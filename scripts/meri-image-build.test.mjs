// Focused contract tests for the retained Meri image-build operator:
// intent-before-start, read-only reconciliation with no ambiguous pick, the
// required promotion-policy gate, and the two-stage qualification (build+smoke
// is NOT a qualified image until the exact-digest scan passes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, 'scripts/meri-image-build.mjs');
const SHA = '13a5dd43fdb0c20614d667e3a0d28dba75623b1c';
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'meri-build-'));

process.env.BUILD_SERVICE = 'meriv2-orchestrator';
process.env.BUILD_SOURCE_SHA = SHA;
process.env.BUILD_ROOT = BUILD_ROOT;
const { buildIntent, assertIntent, selectReconcileMatch, scan } = await import('./meri-image-build.mjs');
const operator = readFileSync(SOURCE, 'utf8');

test('the intent binds the exact service, project, source, SHA and repository', () => {
  const intent = buildIntent(SHA, '2026-10-29T21:00:00.000Z', 'intent-token');
  assert.deepEqual(intent, {
    at: '2026-10-29T21:00:00.000Z',
    service: 'meriv2-orchestrator',
    project: 'capiro-build-web-dev',
    sourceRepository: 'https://github.com/neo-capiro/capiro-backend.git',
    sourceSha: SHA,
    repository: 'capiro/dev/meriv2-orchestrator',
    idempotencyToken: 'intent-token',
  });
  assert.doesNotThrow(() => assertIntent(intent));
  for (const [field, value] of [
    ['service', 'api'],
    ['project', 'other-project'],
    ['sourceRepository', 'https://github.com/neo-capiro/capirov2.git'],
    ['sourceSha', 'short'],
    ['repository', 'capiro/dev/web'],
    ['at', 'not-a-date'],
  ]) {
    assert.throws(() => assertIntent({ ...intent, [field]: value }), new RegExp('BUILD_INTENT_INVALID: ' + field), field);
  }
});

test('reconciliation accepts one exact match and refuses ambiguity or near misses', () => {
  const intent = buildIntent(SHA, '2026-10-29T21:00:00.000Z', 'intent-token');
  const build = (over = {}) => ({
    id: 'capiro-build-web-dev:11111111-1111-1111-1111-111111111111',
    projectName: 'capiro-build-web-dev',
    source: { location: 'https://github.com/neo-capiro/capiro-backend.git' },
    sourceVersion: SHA,
    resolvedSourceVersion: SHA,
    startTime: '2026-10-29T21:00:45.000Z',
    ...over,
  });
  assert.equal(selectReconcileMatch([build()], intent).state, 'MATCH');
  assert.equal(selectReconcileMatch([], intent).state, 'NO_MATCH');
  const ambiguous = selectReconcileMatch([build(), build({ id: 'capiro-build-web-dev:2' })], intent);
  assert.equal(ambiguous.state, 'AMBIGUOUS');
  assert.equal(ambiguous.buildIds.length, 2);
  assert.equal(selectReconcileMatch([build({ projectName: 'other-project' })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ source: { location: 'https://github.com/neo-capiro/capirov2.git' } })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ sourceVersion: 'b'.repeat(40), resolvedSourceVersion: null })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ startTime: '2026-10-29T17:00:00.000Z' })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ startTime: null })], intent).state, 'NO_MATCH');
});

test('launch writes the intent first and reconcile never starts a build', () => {
  const launch = operator.slice(operator.indexOf('function launch()'), operator.indexOf('function reconcile()'));
  assert.ok(launch.indexOf('build-intent.json') < launch.indexOf("'start-build'"));
  assert.match(launch, /flag: 'wx'/);
  assert.match(launch, /BUILD_INTENT_EXISTS_USE_RECONCILE/);
  const reconcile = operator.slice(operator.indexOf('function reconcile()'), operator.indexOf('function readScan()'));
  assert.doesNotMatch(reconcile, /'start-build'/);
  assert.match(reconcile, /list-builds-for-project/);
  assert.match(reconcile, /batch-get-builds/);
  assert.match(reconcile, /selectReconcileMatch/);
});

test('the promotion-policy tests are a required gate on the retained build path', () => {
  assert.match(operator, /node --test scripts\/lib\/meri-release-policy\.test\.mjs scripts\/meri-release\.test\.mjs/);
  assert.match(operator, /echo PROMOTION_POLICY_TEST_PASS/);
  assert.match(operator, /const REQUIRED = \[[^\]]*'PROMOTION_POLICY_TEST_PASS'\]/);
  // Offline, on the pinned node image, from the checked-out source.
  assert.match(operator, /--network none -v "\$PWD":\/src -w \/src node:20\.16\.0-bookworm-slim/);
});

test('OCI source attribution names the repository the source is pinned to', () => {
  assert.match(operator, /org\.opencontainers\.image\.source=https:\/\/github\.com\/neo-capiro\/capiro-backend/);
  assert.doesNotMatch(operator, /org\.opencontainers\.image\.source=https:\/\/github\.com\/neo-capiro\/capirov2/);
  assert.match(operator, /org\.opencontainers\.image\.revision=\$EXPECTED_SHA/);
});

test('build plus smoke is explicitly not a qualified image', () => {
  assert.match(operator, /BUILD_AND_IMAGE_SMOKE_PASS_NOT_QUALIFIED/);
  assert.match(operator, /qualified: false/);
  assert.match(operator, /nextStage: 'scan'/);
  assert.match(operator, /scan-readback\.json/);
  assert.match(operator, /IMAGE_SCAN_PASS digest=/);
  assert.match(operator, /BUILD_SMOKE_AND_DIGEST_SCAN_PASS/);
  assert.doesNotMatch(operator, /qualification: ok \? 'IMMUTABLE_BUILD_AND_IMAGE_SMOKE_PASS'/);
});

test('the scan stage refuses to run without a collected exact digest', () => {
  assert.throws(() => scan(), /SCAN_REQUIRES_COLLECTED_DIGEST/);
});

test('the scan stage is bound to the digest, not the mutable tag', () => {
  const body = operator.slice(operator.indexOf('export function scan()'));
  assert.ok(body.includes("'--image-id', `imageDigest=${digest}`"), 'scan must bind the digest');
  assert.match(body, /TAG_MOVED/);
  assert.match(body, /DIGEST_MISMATCH/);
  assert.ok(body.includes("=== 'COMPLETE'"), 'scan must require COMPLETE');
  assert.match(body, /counts\.CRITICAL/);
  assert.match(body, /counts\.HIGH/);
});
