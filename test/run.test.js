'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runReleaseLock } = require('../src/index.js');

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'releaselock-'));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  return root;
}

function baseEnv(root, extra = {}) {
  return {
    GITHUB_WORKSPACE: root,
    ...extra,
  };
}

test('passes a SHA pin when fail-on is none and sends a JSON boolean', async () => {
  const root = tempWorkspace();
  fs.writeFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: ./\n',
  );
  let body;
  const result = await runReleaseLock({
    env: baseEnv(root, {
      'INPUT_FAIL-ON': 'none',
      'INPUT_REQUIRE-SHA-PINNING': 'false',
      'INPUT_SCAN-DOCKERFILES': 'false',
    }),
    workspace: root,
    write() {},
    writeErr() {},
    async fetchImpl(_url, opts) {
      body = JSON.parse(opts.body);
      assert.equal(opts.method, 'POST');
      assert.match(String(_url), /\/v1\/scan\/workflows$/);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            policy_failed: false,
            failing_count: 0,
            count: body.actions.length,
            fail_on: body.fail_on,
            require_sha_pinning: body.require_sha_pinning,
            results: body.actions.map((ref) => ({
              ref,
              integrity_status: 'Unlocked',
              fails_policy: false,
              fail_reasons: [],
              sha_pinned: /^[0-9a-f]{40}$/i.test(ref.split('@')[1] || ''),
            })),
          });
        },
      };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputs['policy-failed'], 'false');
  assert.equal(body.require_sha_pinning, false);
  assert.equal(typeof body.require_sha_pinning, 'boolean');
  assert.deepEqual(body.actions.sort(), [
    './',
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  ]);
  assert.match(result.summary, /policy passed|Result: \*\*passed\*\*/);
});

test('fails the job when the API reports policy_failed', async () => {
  const root = tempWorkspace();
  fs.writeFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n',
  );
  const errors = [];
  const result = await runReleaseLock({
    env: baseEnv(root, {
      'INPUT_FAIL-ON': 'unlocked',
      'INPUT_REQUIRE-SHA-PINNING': 'true',
      'INPUT_SCAN-DOCKERFILES': 'false',
    }),
    workspace: root,
    write() {},
    writeErr(line) {
      errors.push(line);
    },
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            policy_failed: true,
            failing_count: 1,
            count: 1,
            results: [
              {
                ref: 'actions/checkout@v4',
                owner: 'actions',
                repo: 'checkout',
                current_ref: 'v4',
                integrity_status: 'Unlocked',
                sha_pinned: false,
                fails_policy: true,
                fail_reasons: ['integrity:Unlocked', 'not_sha_pinned'],
                recommended_sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
              },
            ],
          });
        },
      };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.outputs['policy-failed'], 'true');
  assert.ok(errors.some((line) => line.startsWith('::error')));
  assert.match(result.summary, /actions\/checkout/);
});

test('on-failure warn keeps a failing policy green', async () => {
  const root = tempWorkspace();
  fs.writeFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n',
  );
  const result = await runReleaseLock({
    env: baseEnv(root, {
      'INPUT_ON-FAILURE': 'warn',
      'INPUT_SCAN-DOCKERFILES': 'false',
    }),
    workspace: root,
    write() {},
    writeErr(line) {
      throw new Error(`unexpected error stream: ${line}`);
    },
    async fetchImpl() {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            policy_failed: true,
            failing_count: 1,
            count: 1,
            results: [{ ref: 'actions/checkout@v4', fails_policy: true, integrity_status: 'Unlocked', fail_reasons: ['integrity:Unlocked'] }],
          });
        },
      };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputs['policy-failed'], 'true');
});

test('API errors fail closed even when on-failure is warn', async () => {
  const root = tempWorkspace();
  fs.writeFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n',
  );
  const result = await runReleaseLock({
    env: baseEnv(root, { 'INPUT_ON-FAILURE': 'warn', 'INPUT_SCAN-DOCKERFILES': 'false' }),
    workspace: root,
    write() {},
    writeErr() {},
    async fetchImpl() {
      return { ok: false, status: 500, async text() { return JSON.stringify({ ok: false, error: 'boom' }); } };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.outputs['policy-failed'], 'true');
});

test('does not call the API when no refs exist', async () => {
  const root = tempWorkspace();
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'jobs: {}\n');
  let called = false;
  const result = await runReleaseLock({
    env: baseEnv(root, { 'INPUT_SCAN-DOCKERFILES': 'false' }),
    workspace: root,
    write() {},
    writeErr() {},
    async fetchImpl() {
      called = true;
      throw new Error('should not be called');
    },
  });
  assert.equal(called, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputs['policy-failed'], 'false');
});

test('Dockerfile curl pipe is a warning and does not fail a clean policy', async () => {
  const root = tempWorkspace();
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'jobs: {}\n');
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM alpine\nRUN curl -fsSL https://example.com/i.sh | bash\n');
  const warnings = [];
  const result = await runReleaseLock({
    env: baseEnv(root, { 'INPUT_SCAN-DOCKERFILES': 'true' }),
    workspace: root,
    write(line) {
      warnings.push(line);
    },
    writeErr() {},
    async fetchImpl() {
      throw new Error('no uses refs, fetch should not run');
    },
  });
  assert.equal(result.exitCode, 0);
  assert.ok(warnings.some((line) => line.includes('curl piped to a shell')));
  assert.match(result.summary, /curl-bash:\/\/dockerfile-install/);
});
