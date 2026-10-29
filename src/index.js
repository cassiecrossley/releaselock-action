/**
 * releaselock-action
 * Dependency-free Node 20 JavaScript action.
 * Reads workflow uses: refs and posts them to POST /v1/scan/workflows.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_API_BASE = 'https://releaselock.dev';
const DEFAULT_GLOB = '.github/workflows/*.yml,.github/workflows/*.yaml';
const FAIL_ON_ALIASES = {
  unlocked: 'unlocked',
  'checksums-only': 'checksums-only',
  'checksum-only': 'checksums-only',
  signed: 'signed',
  attested: 'attested',
  immutable: 'immutable',
  none: 'none',
  off: 'none',
};

function getInput(env, name, fallback = '') {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const value = env[key];
  return value === undefined || value === '' ? fallback : value;
}

function getBooleanInput(env, name, fallback = false) {
  const value = String(getInput(env, name, fallback ? 'true' : 'false')).trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function normalizeFailOn(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return 'unlocked';
  const hyphenated = raw.replace(/[\s_]+/g, '-');
  return FAIL_ON_ALIASES[hyphenated] || hyphenated;
}

function normalizeOnFailure(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw || raw === 'fail' || raw === 'error') return 'fail';
  if (raw === 'warn' || raw === 'warning') return 'warn';
  return 'fail';
}

function normalizeAllowList(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

function splitGlobList(raw) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(raw || '')) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      const piece = cur.trim();
      if (piece) out.push(piece);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const last = cur.trim();
  if (last) out.push(last);
  return out;
}

function globToRegExp(pattern) {
  let source = String(pattern || '').replace(/\\/g, '/').replace(/^\.\//, '');
  source = source.replace(/\./g, '\\.').replace(/\*\*/g, '::DS::').replace(/\*/g, '[^/]*').replace(/::DS::/g, '.*');
  source = source.replace(/\{([^}]+)\}/g, (_, alts) => `(?:${alts.split(',').join('|')})`);
  return new RegExp(`^${source}$`, 'i');
}

function walkMatch(root, patterns) {
  const files = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  walk(root);
  const matchers = patterns.map(globToRegExp);
  return files
    .map((full) => ({
      full,
      rel: path.relative(root, full).split(path.sep).join('/'),
    }))
    .filter((file) => matchers.some((re) => re.test(file.rel)));
}

function extractUsesRefs(yamlText) {
  const refs = [];
  const lines = String(yamlText || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = line.match(/^\s*-?\s*uses:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/);
    if (match && match[1]) {
      refs.push({ ref: match[1], line: i + 1 });
    }
  }
  return refs;
}

function extractDockerfileFindings(text, relPath) {
  const findings = [];
  const body = String(text || '');
  if (/curl\b[^\n|]*\|\s*(?:sudo\s+)?(?:bash|sh)\b/i.test(body)) {
    findings.push({
      ref: 'curl-bash://dockerfile-install',
      file: relPath,
      detail: 'curl piped to a shell',
    });
  }
  const urlRe = /(?:ADD|COPY)\s+(?:--[^\s]+\s+)*(https?:\/\/[^\s]+)/gi;
  let match;
  while ((match = urlRe.exec(body)) !== null) {
    findings.push({
      ref: `download://${match[1]}`,
      file: relPath,
      detail: 'remote ADD or COPY',
    });
  }
  return findings;
}

function workflowEscape(value) {
  return String(value == null ? '' : value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function annotate(write, level, message, file, line) {
  const loc = file ? ` file=${workflowEscape(file)}${line ? `,line=${line}` : ''}` : '';
  write(`::${level}${loc}::${workflowEscape(message)}`);
}

function escapeMd(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function writeOutput(env, name, value) {
  const outPath = env.GITHUB_OUTPUT;
  if (!outPath) return;
  const text = String(value);
  if (text.includes('\n')) {
    const delim = `RL_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    fs.appendFileSync(outPath, `${name}<<${delim}\n${text}\n${delim}\n`);
  } else {
    fs.appendFileSync(outPath, `${name}=${text}\n`);
  }
}

function appendSummary(env, markdown, write) {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    write(`\n--- Step summary ---\n${markdown}`);
    return;
  }
  fs.appendFileSync(summaryPath, markdown);
}

function locationIndex(found) {
  const map = new Map();
  for (const item of found) {
    const key = item.ref;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function recommendation(item) {
  if (item.recommended_sha && item.owner && item.repo && !item.sha_pinned) {
    const sub = item.subpath ? `/${item.subpath}` : '';
    return `Pin to ${item.owner}/${item.repo}${sub}@${item.recommended_sha}`;
  }
  return item.recommended_action || item.error || '';
}

function buildSummary({ failOn, requireSha, onFailure, rows, findings, policyFailed, count, failingCount }) {
  let md = '## ReleaseLock gate\n\n';
  md += 'Checked workflow `uses:` refs with the [ReleaseLock](https://releaselock.dev) API (`POST /v1/scan/workflows`).\n\n';
  if (!rows.length && !findings.length) {
    md += 'No `uses:` refs or Dockerfile download patterns were found.\n\n';
  }
  if (rows.length) {
    md += '| Dependency | Ref | Status | Policy | Recommendation |\n';
    md += '|---|---|---|---|---|\n';
    for (const item of rows) {
      const dep = item.owner && item.repo ? `${item.owner}/${item.repo}` : item.ref || '';
      const status = item.integrity_status || 'Unknown';
      const policy = item.fails_policy ? 'fail' : 'pass';
      const where = (item.locations || [])
        .map((loc) => (loc.line ? `${loc.file}:${loc.line}` : loc.file))
        .filter(Boolean)
        .join(', ');
      const depCell = where ? `${dep} (${where})` : dep;
      md += `| ${escapeMd(depCell)} | ${escapeMd(item.current_ref || item.ref || '')} | ${escapeMd(status)} | ${policy} | ${escapeMd(recommendation(item))} |\n`;
    }
    md += '\n';
  }
  if (findings.length) {
    md += 'Dockerfile review (warning only, these do not change the API policy result):\n\n';
    md += '| File | Pattern | Detail |\n|---|---|---|\n';
    for (const finding of findings) {
      md += `| ${escapeMd(finding.file)} | ${escapeMd(finding.ref)} | ${escapeMd(finding.detail)} |\n`;
    }
    md += '\n';
  }
  md += `Policy: fail-on \`${escapeMd(failOn)}\`, require-sha-pinning \`${requireSha}\`, on-failure \`${escapeMd(onFailure)}\`.\n\n`;
  md += `Result: **${policyFailed ? 'failed' : 'passed'}**. Failing ${failingCount} of ${count}.\n`;
  return md;
}

async function runReleaseLock(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const write = options.write || ((line) => console.log(line));
  const writeErr = options.writeErr || ((line) => console.error(line));
  const workspace = options.workspace || env.GITHUB_WORKSPACE || process.cwd();

  const failOn = normalizeFailOn(getInput(env, 'fail-on', 'unlocked'));
  const requireSha = getBooleanInput(env, 'require-sha-pinning', true);
  const allowList = normalizeAllowList(getInput(env, 'allow-list', ''));
  const apiBase = getInput(env, 'api-base', DEFAULT_API_BASE).replace(/\/$/, '');
  const scanDocker = getBooleanInput(env, 'scan-dockerfiles', true);
  const onFailureInput = String(getInput(env, 'on-failure', 'fail')).trim().toLowerCase();
  const onFailure = normalizeOnFailure(onFailureInput);
  const workflowGlob = getInput(env, 'workflow-glob', DEFAULT_GLOB);
  const knownOnFailure = new Set(['', 'fail', 'error', 'warn', 'warning']);

  if (!knownOnFailure.has(onFailureInput)) {
    annotate(write, 'warning', `Unknown on-failure value "${onFailureInput}". Using fail.`);
  }

  const patterns = splitGlobList(workflowGlob);
  const workflowFiles = walkMatch(workspace, patterns.length ? patterns : splitGlobList(DEFAULT_GLOB));
  write(`ReleaseLock: scanning ${workflowFiles.length} workflow file(s)`);

  const found = [];
  for (const file of workflowFiles) {
    let text;
    try {
      text = fs.readFileSync(file.full, 'utf8');
    } catch (err) {
      annotate(write, 'warning', `Could not read ${file.rel}: ${err.message}`);
      continue;
    }
    for (const ref of extractUsesRefs(text)) {
      found.push({ ref: ref.ref, file: file.rel, line: ref.line });
    }
  }

  const findings = [];
  if (scanDocker) {
    const dockerFiles = walkMatch(workspace, ['Dockerfile', '**/Dockerfile', 'Dockerfile.*', '**/Dockerfile.*']);
    for (const file of dockerFiles) {
      let text = '';
      try {
        text = fs.readFileSync(file.full, 'utf8');
      } catch {
        continue;
      }
      findings.push(...extractDockerfileFindings(text, file.rel));
    }
  }

  const outputs = {};
  const finish = (exitCode, summary, resultJson) => {
    outputs['policy-failed'] = exitCode === 0 && resultJson && resultJson.policy_failed === false ? 'false' : outputs['policy-failed'];
    appendSummary(env, summary, write);
    for (const [name, value] of Object.entries(outputs)) writeOutput(env, name, value);
    return { exitCode, outputs, summary };
  };

  if (!found.length && !findings.length) {
    const summary = buildSummary({
      failOn,
      requireSha,
      onFailure,
      rows: [],
      findings: [],
      policyFailed: false,
      count: 0,
      failingCount: 0,
    });
    const payload = { ok: true, count: 0, results: [], policy_failed: false, failing_count: 0 };
    outputs['policy-failed'] = 'false';
    outputs['result-json'] = JSON.stringify(payload);
    write('ReleaseLock: no uses refs found.');
    return finish(0, summary, payload);
  }

  const uniqueRefs = [];
  const seen = new Set();
  for (const item of found) {
    if (seen.has(item.ref)) continue;
    seen.add(item.ref);
    uniqueRefs.push(item.ref);
  }
  const byRef = locationIndex(found);

  let data;
  if (!uniqueRefs.length) {
    data = { ok: true, count: 0, results: [], policy_failed: false, failing_count: 0, fail_on: failOn, require_sha_pinning: requireSha };
  } else {
    const payload = {
      actions: uniqueRefs,
      fail_on: failOn,
      require_sha_pinning: requireSha,
      allow_list: allowList,
    };
    const endpoint = `${apiBase}/v1/scan/workflows`;
    write(`ReleaseLock: POST ${endpoint} (${uniqueRefs.length} ref(s))`);
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'releaselock-action',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
      }
      if (!data || typeof data !== 'object' || !res.ok || data.ok === false) {
        const detail = data && typeof data === 'object' ? data.error : '';
        throw new Error(detail || `HTTP ${res.status}`);
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      annotate(writeErr, 'error', `ReleaseLock API error: ${message}`);
      const summary = `## ReleaseLock gate\n\nThe scan API request failed: ${escapeMd(message)}\n\nThe job fails closed when the API cannot be evaluated.\n`;
      const payload = { ok: false, error: message, policy_failed: true };
      outputs['policy-failed'] = 'true';
      outputs['result-json'] = JSON.stringify(payload);
      appendSummary(env, summary, write);
      for (const [name, value] of Object.entries(outputs)) writeOutput(env, name, value);
      return { exitCode: 1, outputs, summary };
    }
  }

  const results = Array.isArray(data.results) ? data.results : [];
  for (const item of results) {
    item.locations = byRef.get(item.ref) || [];
  }
  const policyFailed = typeof data.policy_failed === 'boolean'
    ? data.policy_failed
    : results.some((item) => item.fails_policy);
  const failingCount = Number.isFinite(data.failing_count)
    ? data.failing_count
    : results.filter((item) => item.fails_policy).length;
  const count = Number.isFinite(data.count) ? data.count : results.length;

  if (data.d1_unavailable) {
    annotate(write, 'warning', 'ReleaseLock reported d1_unavailable. Treat integrity results as incomplete.');
  }

  for (const item of results) {
    const where = (item.locations && item.locations[0]) || {};
    if (item.fails_policy) {
      const reasons = Array.isArray(item.fail_reasons) && item.fail_reasons.length
        ? item.fail_reasons.join(', ')
        : item.integrity_status || 'policy';
      const message = `${item.ref} failed ReleaseLock policy (${reasons}). ${recommendation(item)}`.trim();
      annotate(onFailure === 'warn' ? write : writeErr, onFailure === 'warn' ? 'warning' : 'error', message, where.file, where.line);
    } else if (item.drift_detected) {
      annotate(write, 'warning', `${item.ref} has release drift in the ReleaseLock directory.`, where.file, where.line);
    } else if (item.kind === 'docker' && !String(item.ref || '').includes('@sha256:')) {
      annotate(write, 'warning', `${item.ref} is a docker action without an image digest.`, where.file, where.line);
    }
  }
  for (const finding of findings) {
    annotate(write, 'warning', `${finding.file}: ${finding.detail} (${finding.ref}).`, finding.file);
  }

  const summary = buildSummary({
    failOn,
    requireSha,
    onFailure,
    rows: results,
    findings,
    policyFailed,
    count,
    failingCount,
  });
  outputs['policy-failed'] = policyFailed ? 'true' : 'false';
  outputs['result-json'] = JSON.stringify(data);

  let exitCode = 0;
  if (policyFailed && onFailure === 'fail') {
    annotate(writeErr, 'error', `ReleaseLock policy failed for ${failingCount} dependenc${failingCount === 1 ? 'y' : 'ies'}. See the job summary.`);
    exitCode = 1;
  } else if (policyFailed) {
    annotate(write, 'warning', `ReleaseLock policy matched ${failingCount} dependenc${failingCount === 1 ? 'y' : 'ies'}. on-failure=warn, so the job stays green.`);
    write('ReleaseLock: policy matched, reported as warnings.');
  } else {
    write('ReleaseLock: policy passed.');
  }

  appendSummary(env, summary, write);
  for (const [name, value] of Object.entries(outputs)) writeOutput(env, name, value);
  return { exitCode, outputs, summary };
}

async function main() {
  try {
    const result = await runReleaseLock();
    process.exitCode = result.exitCode;
  } catch (err) {
    const message = err && err.stack ? err.stack : String(err);
    console.error(`::error::${workflowEscape(message)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runReleaseLock,
  extractUsesRefs,
  extractDockerfileFindings,
  splitGlobList,
  globToRegExp,
  normalizeFailOn,
  normalizeOnFailure,
  normalizeAllowList,
  walkMatch,
};
