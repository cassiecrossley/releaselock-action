'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractUsesRefs,
  extractDockerfileFindings,
  splitGlobList,
  globToRegExp,
  normalizeFailOn,
  normalizeOnFailure,
  normalizeAllowList,
} = require('../src/index.js');

test('extractUsesRefs keeps real uses lines and skips comments', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: "actions/setup-node@v4"',
    "      - uses: 'docker://alpine:3.20'",
    '      - uses: ./.github/actions/local',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    '      # - uses: ignored/comment@v1',
    '      - run: echo "uses: not-a-ref@v1"',
  ].join('\n');
  const refs = extractUsesRefs(yaml).map((item) => item.ref);
  assert.deepEqual(refs, [
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'docker://alpine:3.20',
    './.github/actions/local',
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  ]);
});

test('extractDockerfileFindings flags curl pipe and remote COPY', () => {
  const text = [
    'FROM alpine',
    'ADD https://example.com/tool.tgz /tmp/tool.tgz',
    'RUN curl -fsSL https://example.com/install.sh | bash',
  ].join('\n');
  const findings = extractDockerfileFindings(text, 'Dockerfile');
  assert.equal(findings.length, 2);
  assert.equal(findings[0].ref, 'curl-bash://dockerfile-install');
  assert.match(findings[1].ref, /^download:\/\/https:\/\/example.com\/tool.tgz/);
});

test('splitGlobList does not split inside braces', () => {
  assert.deepEqual(splitGlobList('.github/workflows/*.yml,.github/workflows/*.yaml'), [
    '.github/workflows/*.yml',
    '.github/workflows/*.yaml',
  ]);
  assert.deepEqual(splitGlobList('.github/workflows/*.{yml,yaml}'), [
    '.github/workflows/*.{yml,yaml}',
  ]);
});

test('default workflow globs match workflow files only', () => {
  const patterns = splitGlobList('.github/workflows/*.yml,.github/workflows/*.yaml');
  const matchers = patterns.map(globToRegExp);
  const matches = (rel) => matchers.some((re) => re.test(rel));
  assert.equal(matches('.github/workflows/self-gate.yml'), true);
  assert.equal(matches('.github/workflows/ci.yaml'), true);
  assert.equal(matches('test/fixtures/unlocked-tag/ci.yml'), false);
  assert.equal(matches('.github/workflows/nested/ci.yml'), false);
});

test('normalizeFailOn maps aliases and keeps unknown values', () => {
  assert.equal(normalizeFailOn(''), 'unlocked');
  assert.equal(normalizeFailOn('Checksums only'), 'checksums-only');
  assert.equal(normalizeFailOn('IMMUTABLE'), 'immutable');
  assert.equal(normalizeFailOn('off'), 'none');
  assert.equal(normalizeFailOn('bogus'), 'bogus');
});

test('normalizeOnFailure and allow list', () => {
  assert.equal(normalizeOnFailure(''), 'fail');
  assert.equal(normalizeOnFailure('warn'), 'warn');
  assert.equal(normalizeOnFailure('nope'), 'fail');
  assert.equal(normalizeAllowList(' actions/checkout, , aquasecurity/trivy@v0.76.1 '), 'actions/checkout, aquasecurity/trivy@v0.76.1');
});
