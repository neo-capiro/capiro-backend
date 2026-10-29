// Focused contract tests for the retained Meri image-build operator:
// intent-before-start, exact request-identity reconciliation (server-returned
// buildspec + operation marker), the required promotion-policy gate, and the
// two-stage qualification where a clean digest scan can never repair a failed
// build, smoke or policy gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, 'scripts/meri-image-build.mjs');
const SHA = '13a5dd43fdb0c20614d667e3a0d28dba75623b1c';
const TOKEN = '11111111-1111-4111-8111-111111111111';
const MARKER = '22222222-2222-4222-8222-222222222222';
const OTHER_MARKER = '44444444-4444-4444-8444-444444444444';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'meri-build-'));
const MARKER_ENV = 'CAPIRO_BUILD_OPERATION_MARKER';

process.env.BUILD_SERVICE = 'meriv2-orchestrator';
process.env.BUILD_SOURCE_SHA = SHA;
process.env.BUILD_ROOT = BUILD_ROOT;
const { buildIntent, assertIntent, selectReconcileMatch, verifyBuildIdentity, composeQualification, scan, buildspecFor } =
  await import('./meri-image-build.mjs');
const operator = readFileSync(SOURCE, 'utf8');
const SPEC_TEXT = JSON.stringify(buildspecFor());

const readback = (over = {}) => ({
  buildId: 'capiro-build-web-dev:11111111-1111-1111-1111-111111111111',
  buildQualified: true,
  identityVerified: true,
  imageDigest: DIGEST,
  ...over,
});
const scanReceipt = (over = {}) => ({
  buildId: 'capiro-build-web-dev:11111111-1111-1111-1111-111111111111',
  digest: DIGEST,
  status: 'COMPLETE',
  counts: {},
  qualified: true,
  ...over,
});

test('the intent binds the exact service, project, source, SHA, repository, marker and buildspec', () => {
  const intent = buildIntent(SHA, '2026-10-29T21:00:00.000Z', TOKEN, MARKER);
  assert.equal(intent.service, 'meriv2-orchestrator');
  assert.equal(intent.project, 'capiro-build-web-dev');
  assert.equal(intent.sourceRepository, 'https://github.com/neo-capiro/capiro-backend.git');
  assert.equal(intent.sourceSha, SHA);
  assert.equal(intent.repository, 'capiro/dev/meriv2-orchestrator');
  assert.equal(intent.idempotencyToken, TOKEN);
  assert.equal(intent.operationMarker, MARKER);
  assert.match(intent.buildspecSha256, /^[0-9a-f]{64}$/);
  assert.equal(intent.at, '2026-10-29T21:00:00.000Z');
  assert.doesNotThrow(() => assertIntent(intent));
  for (const [field, value] of [
    ['service', 'api'],
    ['project', 'other-project'],
    ['sourceRepository', 'https://github.com/neo-capiro/capirov2.git'],
    ['sourceSha', 'short'],
    ['repository', 'capiro/dev/web'],
    ['at', 'not-a-date'],
    ['operationMarker', 'not-a-uuid'],
    ['buildspecSha256', 'short'],
    ['idempotencyToken', 'not-a-uuid'],
  ]) {
    assert.throws(() => assertIntent({ ...intent, [field]: value }), new RegExp('BUILD_INTENT_INVALID: ' + field), field);
  }
});

test('recovery binds the server-returned buildspec and operation marker, not just project/SHA/time', () => {
  const intent = buildIntent(SHA, '2026-10-29T21:00:00.000Z', TOKEN, MARKER);
  const build = (over = {}) => ({
    id: 'capiro-build-web-dev:11111111-1111-1111-1111-111111111111',
    projectName: 'capiro-build-web-dev',
    source: { type: 'GITHUB', location: 'https://github.com/neo-capiro/capiro-backend.git', buildspec: SPEC_TEXT },
    sourceVersion: SHA,
    resolvedSourceVersion: SHA,
    startTime: '2026-10-29T21:00:45.000Z',
    environment: {
      environmentVariables: [
        { name: 'EXPECTED_SHA', value: SHA },
        { name: MARKER_ENV, value: MARKER },
      ],
    },
    ...over,
  });

  const positive = selectReconcileMatch([build()], intent);
  assert.equal(positive.state, 'MATCH');
  assert.equal(positive.observed.buildspecSha256, intent.buildspecSha256);
  assert.equal(positive.observed.operationMarker, MARKER);
  assert.equal(selectReconcileMatch([], intent).state, 'NO_MATCH');

  const otherSpec = build({ source: { type: 'GITHUB', location: 'https://github.com/neo-capiro/capiro-backend.git', buildspec: `${SPEC_TEXT}\n# other service` } });
  assert.equal(selectReconcileMatch([otherSpec], intent).state, 'NO_MATCH');
  const otherMarker = build({ environment: { environmentVariables: [{ name: MARKER_ENV, value: OTHER_MARKER }] } });
  assert.equal(selectReconcileMatch([otherMarker], intent).state, 'NO_MATCH');
  const mixed = selectReconcileMatch([
    build({
      source: { type: 'GITHUB', location: 'https://github.com/neo-capiro/capiro-backend.git', buildspec: `${SPEC_TEXT}\n# other service` },
      environment: { environmentVariables: [{ name: MARKER_ENV, value: OTHER_MARKER }] },
    }),
  ], intent);
  assert.equal(mixed.state, 'NO_MATCH');
  assert.equal(mixed.rejected[0].state, 'MISMATCH');
  assert.ok(mixed.rejected[0].reasons.includes('buildspec'));
  assert.ok(mixed.rejected[0].reasons.includes('operation-marker'));

  const noBuildspec = build({ source: { type: 'GITHUB', location: 'https://github.com/neo-capiro/capiro-backend.git' } });
  assert.equal(selectReconcileMatch([noBuildspec], intent).state, 'UNKNOWN');
  const noEnvironment = build();
  delete noEnvironment.environment;
  assert.equal(selectReconcileMatch([noEnvironment], intent).state, 'UNKNOWN');
  const noMarker = build({ environment: { environmentVariables: [{ name: 'EXPECTED_SHA', value: SHA }] } });
  assert.equal(selectReconcileMatch([noMarker], intent).state, 'UNKNOWN');

  const ambiguous = selectReconcileMatch([build(), build({ id: 'capiro-build-web-dev:2' })], intent);
  assert.equal(ambiguous.state, 'AMBIGUOUS');
  assert.equal(ambiguous.buildIds.length, 2);

  assert.equal(selectReconcileMatch([build({ projectName: 'other-project' })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ sourceVersion: 'b'.repeat(40), resolvedSourceVersion: null })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ startTime: '2026-10-29T17:00:00.000Z' })], intent).state, 'NO_MATCH');
});

test('a supplied build id cannot bypass the identity of the request AWS ran', () => {
  const intent = buildIntent(SHA, '2026-10-29T21:00:00.000Z', TOKEN, MARKER);
  const foreign = {
    id: 'capiro-build-web-dev:99999999-9999-4999-8999-999999999999',
    projectName: 'capiro-build-web-dev',
    source: { type: 'GITHUB', location: 'https://github.com/neo-capiro/capiro-backend.git', buildspec: `${SPEC_TEXT}\n# foreign`, sourceVersion: SHA },
    sourceVersion: SHA,
    resolvedSourceVersion: SHA,
    startTime: '2026-10-29T21:02:00.000Z',
    environment: { environmentVariables: [{ name: MARKER_ENV, value: OTHER_MARKER }] },
  };
  const identity = verifyBuildIdentity(foreign, intent);
  assert.equal(identity.state, 'MISMATCH');
  assert.ok(identity.reasons.includes('buildspec'));
  assert.ok(identity.reasons.includes('operation-marker'));
  const collect = operator.slice(operator.indexOf('function collect()'), operator.indexOf('export function scan()'));
  assert.ok(collect.indexOf('verifyBuildIdentity') < collect.indexOf('get-log-events'), 'collect must verify identity before reading logs');
  assert.match(collect, /IDENTITY_NOT_VERIFIED/);
  assert.match(collect, /BUILD_INTENT_REQUIRED/);
});

test('launch writes the intent first and reconcile never starts a build', () => {
  const launch = operator.slice(operator.indexOf('function launch()'), operator.indexOf('function reconcile()'));
  assert.ok(launch.indexOf('build-intent.json') < launch.indexOf("'start-build'"));
  assert.match(launch, /flag: 'wx'/);
  assert.match(launch, /BUILD_INTENT_EXISTS_USE_RECONCILE/);
  assert.match(launch, /OPERATION_MARKER_ENV/);
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
  assert.match(operator, /--network none -v "\$PWD":\/src -w \/src node:20\.16\.0-bookworm-slim/);
});

test('OCI source attribution names the repository the source is pinned to', () => {
  assert.match(operator, /org\.opencontainers\.image\.source=https:\/\/github\.com\/neo-capiro\/capiro-backend/);
  assert.doesNotMatch(operator, /org\.opencontainers\.image\.source=https:\/\/github\.com\/neo-capiro\/capirov2/);
  assert.match(operator, /org\.opencontainers\.image\.revision=\$EXPECTED_SHA/);
});

test('a clean digest scan never repairs a failed, cancelled or incomplete build', () => {
  const clean = scanReceipt();
  for (const status of ['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT', 'IN_PROGRESS']) {
    assert.deepEqual(
      composeQualification(readback({ buildQualified: false, status }), clean),
      { qualified: false, qualification: 'BUILD_NOT_QUALIFIED', reason: 'BUILD_NOT_QUALIFIED' },
      status,
    );
  }
  assert.equal(composeQualification(readback({ buildQualified: false, markersSeen: ['IMAGE_SMOKE_PASS'] }), clean).qualified, false);
  assert.equal(composeQualification(readback({ identityVerified: false }), clean).reason, 'IDENTITY_NOT_VERIFIED');
  assert.equal(composeQualification(readback({ imageDigest: null }), clean).reason, 'DIGEST_MISSING');
});

test('qualification requires a pass from both stages, bound to the same build and digest', () => {
  assert.deepEqual(composeQualification(readback(), null), {
    qualified: false,
    qualification: 'BUILD_AND_IMAGE_SMOKE_PASS_NOT_QUALIFIED',
    nextStage: 'scan',
    reason: 'SCAN_REQUIRED',
  });
  assert.equal(composeQualification(readback(), scanReceipt({ buildId: 'capiro-build-web-dev:2' })).reason, 'SCAN_BUILD_MISMATCH');
  assert.equal(composeQualification(readback(), scanReceipt({ digest: `sha256:${'c'.repeat(64)}` })).reason, 'SCAN_DIGEST_MISMATCH');
  assert.equal(composeQualification(readback(), scanReceipt({ status: 'IN_PROGRESS' })).reason, 'SCAN_NOT_QUALIFIED');
  assert.equal(composeQualification(readback(), scanReceipt({ qualified: false })).reason, 'SCAN_NOT_QUALIFIED');
  assert.deepEqual(composeQualification(readback(), scanReceipt()), {
    qualified: true,
    qualification: 'BUILD_SMOKE_AND_DIGEST_SCAN_PASS',
    reason: null,
  });
  assert.equal(composeQualification(readback({ buildQualified: false }), scanReceipt()).qualified, false);
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

test('the scan stage refuses to run without a collected and qualified build', () => {
  assert.throws(() => scan(), /SCAN_REQUIRES_COLLECTED_DIGEST/);
  writeFileSync(join(BUILD_ROOT, 'build-readback.json'), JSON.stringify(readback({ identityVerified: false })));
  assert.throws(() => scan(), /SCAN_REQUIRES_VERIFIED_IDENTITY/);
  writeFileSync(join(BUILD_ROOT, 'build-readback.json'), JSON.stringify(readback({ buildQualified: false })));
  assert.throws(() => scan(), /SCAN_REQUIRES_QUALIFIED_BUILD/);
  unlinkSync(join(BUILD_ROOT, 'build-readback.json'));
});

test('the scan stage is bound to the digest, not the mutable tag', () => {
  const body = operator.slice(operator.indexOf('export function scan()'));
  assert.ok(body.includes("'--image-id', `imageDigest=${digest}`"), 'scan must bind the digest');
  assert.match(body, /TAG_MOVED/);
  assert.match(body, /DIGEST_MISMATCH/);
  assert.ok(body.includes("=== 'COMPLETE'"), 'scan must require COMPLETE');
  assert.match(body, /counts\.CRITICAL/);
  assert.match(body, /counts\.HIGH/);
  assert.match(body, /buildId: readback\.buildId/);
});
