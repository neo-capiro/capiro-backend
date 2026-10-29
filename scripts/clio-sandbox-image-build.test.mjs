// Focused contract tests for the dedicated Clio sandbox image build operator.
// They prove the actual build request (source pin, app-directory context,
// immutable tag, sandbox gates) and that the gates match the *real* recipe —
// not merely that some strings exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  ACCOUNT,
  CONTEXT,
  DOCKERFILE,
  PROJECT,
  REGION,
  REPOSITORY,
  OPERATION_MARKER_ENV,
  REQUIRED_MARKERS,
  SOURCE_REPOSITORY,
  assertIntent,
  assertSourceSha,
  buildIntent,
  buildspec,
  selectReconcileMatch,
  startBuildInput,
  verifyBuildIdentity,
} from './clio-sandbox-image-build.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA = '13a5dd43fdb0c20614d667e3a0d28dba75623b1c';
const TOKEN = '11111111-1111-4111-8111-111111111111';
const MARKER = '22222222-2222-4222-8222-222222222222';
const OTHER_TOKEN = '33333333-3333-4333-8333-333333333333';
const OTHER_MARKER = '44444444-4444-4444-8444-444444444444';
const phases = (sha = SHA) => buildspec(sha).phases;
const script = (name, sha = SHA) => {
  const command = phases(sha)[name].commands[0];
  const base64 = command.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)[1];
  return gunzipSync(Buffer.from(base64, 'base64')).toString('utf8');
};

test('the request pins the exact source repository and commit on the existing ARM builder', () => {
  const input = startBuildInput(SHA, 'fixed-token');
  assert.equal(input.projectName, PROJECT);
  assert.equal(input.projectName, 'capiro-build-web-dev');
  assert.equal(input.sourceTypeOverride, 'GITHUB');
  assert.equal(input.sourceLocationOverride, 'https://github.com/neo-capiro/capiro-backend.git');
  assert.equal(input.sourceVersion, SHA);
  assert.deepEqual(input.environmentVariablesOverride, [
    { name: 'EXPECTED_SHA', value: SHA, type: 'PLAINTEXT' },
    { name: OPERATION_MARKER_ENV, value: input.environmentVariablesOverride[1].value, type: 'PLAINTEXT' },
  ]);
  // The operation marker is the exclusive per-operation identity returned by BatchGetBuilds.
  assert.match(input.environmentVariablesOverride[1].value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(input.idempotencyToken, 'fixed-token');
  assert.equal(input.timeoutInMinutesOverride, 60);
  // No project/IAM/environment mutation and no deployment knobs in the request.
  for (const forbidden of ['environmentTypeOverride', 'serviceRoleOverride', 'computeTypeOverride', 'privilegedModeOverride']) {
    assert.equal(forbidden in input, false, forbidden);
  }
});

test('the image reference is the exact SHA and never a mutable tag', () => {
  const build = script('build');
  assert.match(build, new RegExp(`image="[^"]*/${REPOSITORY}:\\$\\{EXPECTED_SHA\\}"`));
  assert.doesNotMatch(build, /:latest/);
  assert.equal((build.match(/dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/g) ?? []).length, 1);
  assert.match(script('post_build'), /docker push "\$image"/);
  // The single tag written by the operator is derived from the pinned SHA.
  assert.match(script('post_build'), /--image-ids "imageTag=\$\{EXPECTED_SHA\}"/);
});

test('the build uses the dedicated app-directory context, not the repository root', () => {
  const build = script('build');
  assert.equal(CONTEXT, 'apps/clio-sandbox');
  assert.equal(DOCKERFILE, 'apps/clio-sandbox/Dockerfile');
  assert.match(build, /-f apps\/clio-sandbox\/Dockerfile -t "\$image" apps\/clio-sandbox\n/);
  assert.doesNotMatch(build, /-f apps\/clio-sandbox\/Dockerfile -t "\$image" \./);
});

test('pre-build binds provenance, architecture, account and an unused tag', () => {
  const pre = script('pre_build');
  for (const fragment of [
    'CODEBUILD_RESOLVED_SOURCE_VERSION',
    'git rev-parse HEAD',
    'git status --porcelain --untracked-files=no',
    'uname -m',
    'aarch64',
    `aws sts get-caller-identity --query Account --output text)" = ${ACCOUNT}`,
    `--repository-name ${REPOSITORY}`,
    'imageIds[?imageTag==',
  ]) {
    assert.ok(pre.includes(fragment), fragment);
  }
  assert.ok(pre.includes('--region ' + REGION));
});

test('pre-build gates the recipe/context contract the live service depends on', () => {
  const pre = script('pre_build');
  for (const fragment of ['EXPOSE 4100', 'USER node', 'CMD ["node", "dist/server.js"]', "req.url === '/healthz'", 'process.env.PORT ?? 4100']) {
    assert.ok(pre.includes(fragment), fragment);
  }
  assert.match(pre, /! grep -Eq 'aws-sdk\|@aws-sdk\|curl\|wget/);
});

test('the smoke covers non-root, read-only, no-network, health, token boundary and real execution', () => {
  const build = script('build');
  for (const fragment of [
    '--network none',
    '--read-only',
    '--tmpfs /tmp',
    '--user node',
    '{{.Config.User}}',
    '= node',
    'test "$(id -u)" != "0"',
    '/healthz',
    'expected 401',
    'clio-smoke-token',
    "print('clio-smoke-ok')",
    'import pandas, numpy, matplotlib, scipy, statsmodels, seaborn, networkx',
    'IMAGE_SMOKE_PASS',
  ]) {
    assert.ok(build.includes(fragment), fragment);
  }
});

test('the scan gate requires a COMPLETE scan with zero critical/high findings', () => {
  const gate = readFileSync(join(ROOT, 'scripts/clio-image-scan-gate.py'), 'utf8');
  assert.match(gate, /imageScanStatus/);
  assert.match(gate, /== 'COMPLETE'/);
  assert.match(gate, /counts\.get\('CRITICAL', 0\)/);
  assert.match(gate, /counts\.get\('HIGH', 0\)/);
  assert.match(gate, /IMAGE_SCAN_PASS/);
  // An incomplete scan must not be reported as a pass.
  assert.match(gate, /did not reach COMPLETE/);
  assert.deepEqual(REQUIRED_MARKERS, ['IMAGE_SMOKE_PASS', 'LOCAL_REPODIGEST_ECR_MATCH_PASS', 'IMAGE_SCAN_PASS']);
});

test('the build and promotion are separate: no ECS or deployment side effects', () => {
  const all = ['pre_build', 'build', 'post_build'].map((name) => script(name)).join('\n');
  for (const forbidden of ['aws ecs', 'update-service', 'register-task-definition', 'services-stable', 'run-task', 'deploy']) {
    assert.equal(all.includes(forbidden), false, forbidden);
  }
});

test('the operator refuses a malformed SHA instead of guessing', () => {
  assert.throws(() => assertSourceSha('13a5dd43'), /40 lowercase hex/);
  assert.throws(() => assertSourceSha(SHA.toUpperCase()), /40 lowercase hex/);
  assert.throws(() => assertSourceSha(''), /40 lowercase hex/);
  assert.throws(() => buildspec('not-a-sha'), /40 lowercase hex/);
});

test('an already launched build cannot be replayed', () => {
  const root = mkdtempSync(join(tmpdir(), 'clio-build-'));
  writeFileSync(join(root, 'build-start.json'), '{}');
  process.env.CLIO_BUILD_SOURCE_SHA = SHA;
  process.env.CLIO_BUILD_ROOT = root;
  let failed = false;
  try {
    execFileSync('node', ['scripts/clio-sandbox-image-build.mjs', 'launch'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    failed = true;
    assert.match(String(error.stderr), /ALREADY_LAUNCHED_DO_NOT_REPLAY/);
  }
  assert.equal(failed, true, 'launch must refuse to replay');
  assert.equal(readFileSync(join(root, 'build-start.json'), 'utf8'), '{}');
});

test('plan is a pure, reviewable request with no AWS call', () => {
  const plan = execFileSync('node', ['scripts/clio-sandbox-image-build.mjs', 'plan'], {
    encoding: 'utf8',
    env: { ...process.env, CLIO_BUILD_SOURCE_SHA: SHA, CLIO_BUILD_ROOT: mkdtempSync(join(tmpdir(), 'clio-plan-')) },
  });
  const parsed = JSON.parse(plan);
  assert.equal(parsed.request.sourceVersion, SHA);
  assert.equal(parsed.request.sourceLocationOverride, SOURCE_REPOSITORY);
  assert.match(parsed.buildspecSha256, /^[0-9a-f]{64}$/);
  assert.ok(parsed.buildspecCharacters < 25_600);
  assert.deepEqual(parsed.requiredMarkers, REQUIRED_MARKERS);
});

test('the post-build scan is bound to the exact captured digest, not the tag', () => {
  const post = script('post_build');
  assert.match(post, /python3 scripts\/clio-image-scan-gate\.py "\$EXPECTED_SHA" "\$digest"/);
  // No inline tag-based scan may survive: the tag is mutable.
  assert.doesNotMatch(post, /describe-image-scan-findings/);
  assert.match(post, /echo "CANDIDATE_IMAGE=[^"]*@\$digest"/);
});

test('the scan gate itself scans by digest and rejects a moved tag or digest mismatch', () => {
  const gate = readFileSync(join(ROOT, 'scripts/clio-image-scan-gate.py'), 'utf8');
  assert.match(gate, /--image-id', 'imageDigest=' \+ digest/);
  assert.match(gate, /TAG_MOVED/);
  assert.match(gate, /DIGEST_MISMATCH/);
  assert.match(gate, /'COMPLETE'/);
  assert.match(gate, /counts\.get\('CRITICAL', 0\)/);
  assert.match(gate, /counts\.get\('HIGH', 0\)/);
});

test('the only source route is the exact-SHA GitHub pin (no unimplemented S3 route)', () => {
  const input = startBuildInput(SHA, 'fixed-token');
  assert.equal(input.sourceTypeOverride, 'GITHUB');
  assert.equal(input.sourceLocationOverride, SOURCE_REPOSITORY);
  const operator = readFileSync(join(ROOT, 'scripts/clio-sandbox-image-build.mjs'), 'utf8');
  assert.doesNotMatch(operator, /CLIO_BUILD_SOURCE_ARCHIVE|sourceTypeOverride: 'S3'/);
  // The git provenance gates are still in the build path.
  assert.match(script('pre_build'), /CODEBUILD_RESOLVED_SOURCE_VERSION/);
});

test('recovery binds the server-returned buildspec and operation marker, not just project/SHA/time', () => {
  const intent = buildIntent(SHA, '2026-10-29T21:00:00.000Z', TOKEN, MARKER);
  const spec = startBuildInput(SHA, TOKEN, MARKER).buildspecOverride;
  const otherServiceSpec = `${spec}\n# another service's buildspec`;
  const build = (over = {}) => ({
    id: 'capiro-build-web-dev:11111111-1111-1111-1111-111111111111',
    projectName: PROJECT,
    source: { type: 'GITHUB', location: SOURCE_REPOSITORY, buildspec: spec, sourceVersion: SHA },
    sourceVersion: SHA,
    resolvedSourceVersion: SHA,
    startTime: '2026-10-29T21:00:30.000Z',
    environment: {
      environmentVariables: [
        { name: 'EXPECTED_SHA', value: SHA },
        { name: OPERATION_MARKER_ENV, value: MARKER },
      ],
    },
    ...over,
  });

  // Positive: actual-shaped returned source (buildspec bytes) + effective env.
  const positive = selectReconcileMatch([build()], intent);
  assert.equal(positive.state, 'MATCH');
  assert.equal(positive.observed.buildspecSha256, intent.buildspecSha256);
  assert.equal(positive.observed.operationMarker, MARKER);
  assert.equal(positive.observed.sourceType, 'GITHUB');

  assert.equal(selectReconcileMatch([], intent).state, 'NO_MATCH');

  // Same project, source, SHA and time — but another service's request.
  assert.equal(selectReconcileMatch([build({ source: { type: 'GITHUB', location: SOURCE_REPOSITORY, buildspec: otherServiceSpec } })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ environment: { environmentVariables: [{ name: OPERATION_MARKER_ENV, value: OTHER_MARKER }] } })], intent).state, 'NO_MATCH');
  const mixed = selectReconcileMatch([build({ source: { type: 'GITHUB', location: SOURCE_REPOSITORY, buildspec: otherServiceSpec }, environment: { environmentVariables: [{ name: OPERATION_MARKER_ENV, value: OTHER_MARKER }] } })], intent);
  assert.equal(mixed.state, 'NO_MATCH');
  assert.equal(mixed.rejected[0].state, 'MISMATCH');
  assert.ok(mixed.rejected[0].reasons.includes('buildspec'));
  assert.ok(mixed.rejected[0].reasons.includes('operation-marker'));

  // Missing returned evidence is UNKNOWN, never a match.
  const noBuildspec = build();
  delete noBuildspec.source.buildspec;
  assert.equal(selectReconcileMatch([noBuildspec], intent).state, 'UNKNOWN');
  const noMarker = build({ environment: { environmentVariables: [{ name: 'EXPECTED_SHA', value: SHA }] } });
  assert.equal(selectReconcileMatch([noMarker], intent).state, 'UNKNOWN');
  const noEnvironment = build();
  delete noEnvironment.environment;
  assert.equal(selectReconcileMatch([noEnvironment], intent).state, 'UNKNOWN');

  // Two fully-matching candidates stay explicit.
  const ambiguous = selectReconcileMatch([build(), build({ id: 'capiro-build-web-dev:2' })], intent);
  assert.equal(ambiguous.state, 'AMBIGUOUS');
  assert.equal(ambiguous.buildIds.length, 2);

  // Coarse near misses never produce a fallback pick.
  assert.equal(selectReconcileMatch([build({ projectName: 'other-project' })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ sourceVersion: 'b'.repeat(40), resolvedSourceVersion: null })], intent).state, 'NO_MATCH');
  assert.equal(selectReconcileMatch([build({ startTime: '2026-10-29T18:00:00.000Z' })], intent).state, 'NO_MATCH');
});

test('a supplied build id cannot bypass the identity of the request AWS ran', () => {
  const intent = buildIntent(SHA, '2026-10-29T21:00:00.000Z', TOKEN, MARKER);
  const spec = startBuildInput(SHA, TOKEN, MARKER).buildspecOverride;
  const foreign = {
    id: 'capiro-build-web-dev:99999999-9999-4999-8999-999999999999',
    projectName: PROJECT,
    source: { type: 'GITHUB', location: SOURCE_REPOSITORY, buildspec: `${spec}\n# foreign`, sourceVersion: SHA },
    sourceVersion: SHA,
    resolvedSourceVersion: SHA,
    startTime: '2026-10-29T21:01:00.000Z',
    environment: { environmentVariables: [{ name: OPERATION_MARKER_ENV, value: OTHER_MARKER }] },
  };
  const identity = verifyBuildIdentity(foreign, intent);
  assert.equal(identity.state, 'MISMATCH');
  assert.ok(identity.reasons.includes('buildspec'));
  assert.ok(identity.reasons.includes('operation-marker'));
  const operator = readFileSync(join(ROOT, 'scripts/clio-sandbox-image-build.mjs'), 'utf8');
  const collectBody = operator.slice(operator.indexOf('function collect()'), operator.indexOf('const command = process.argv[2];'));
  assert.ok(collectBody.indexOf('verifyBuildIdentity') < collectBody.indexOf('get-log-events'), 'collect must verify identity before reading logs');
  assert.match(collectBody, /IDENTITY_NOT_VERIFIED/);
  assert.match(collectBody, /process\.exitCode = 2/);
  assert.match(collectBody, /BUILD_INTENT_REQUIRED/);
});

test('the intent is rejected when its identity fields are tampered with', () => {
  const intent = buildIntent(SHA, '2026-10-29T21:00:00.000Z', TOKEN, MARKER);
  assert.doesNotThrow(() => assertIntent(intent));
  assert.throws(() => assertIntent({ ...intent, project: 'other' }), /BUILD_INTENT_INVALID: project/);
  assert.throws(() => assertIntent({ ...intent, repository: 'capiro/dev/other' }), /repository/);
  assert.throws(() => assertIntent({ ...intent, sourceSha: 'short' }), /sourceSha/);
  assert.throws(() => assertIntent({ ...intent, at: 'not-a-date' }), /at/);
  assert.throws(() => assertIntent({ ...intent, operationMarker: 'not-a-uuid' }), /operationMarker/);
  assert.throws(() => assertIntent({ ...intent, buildspecSha256: 'short' }), /buildspecSha256/);
});

test('launch records the intent before it submits the build', () => {
  const operator = readFileSync(join(ROOT, 'scripts/clio-sandbox-image-build.mjs'), 'utf8');
  const launchBody = operator.slice(operator.indexOf('function launch()'), operator.indexOf('function reconcile()'));
  assert.ok(launchBody.indexOf("build-intent.json") < launchBody.indexOf("'start-build'"));
  assert.match(launchBody, /flag: 'wx'/);
  const reconcileBody = operator.slice(operator.indexOf('function reconcile()'));
  assert.doesNotMatch(reconcileBody, /'start-build'/);
  assert.match(reconcileBody, /list-builds-for-project/);
  assert.match(reconcileBody, /batch-get-builds/);
});

test('the gates match the real recipe and runtime sources', () => {
  const dockerfile = readFileSync(join(ROOT, DOCKERFILE), 'utf8');
  // Maintained base: an explicit version tag pinned to the published image
  // index. A floating tag (node:20-slim, node:22-slim, node:latest) is rejected
  // because it silently changes the OS/Node line under the scan gate.
  assert.match(dockerfile, /^FROM node:22\.23\.3-bookworm-slim@sha256:[0-9a-f]{64}$/m);
  assert.doesNotMatch(dockerfile, /^FROM node:\d+-slim$/m);
  assert.doesNotMatch(dockerfile, /^FROM node:[\w.-]*:latest$/m);
  // The supported security refresh must name the base packages that have a
  // fixed bookworm version, and must not claim the families that have none.
  const refresh = dockerfile.slice(dockerfile.indexOf('--only-upgrade'), dockerfile.indexOf('python3-pip'));
  for (const pkg of ['perl-base', 'libgnutls30', 'libc6', 'dpkg', 'libpcre2-8-0', 'libcap2']) {
    assert.ok(refresh.includes(pkg), `security refresh must cover ${pkg}`);
  }
  assert.doesNotMatch(refresh, /zlib1g|util-linux/, 'no-upstream-fix packages must stay out of the update list');
  assert.ok(dockerfile.indexOf('--only-upgrade') < dockerfile.indexOf('python3-pip'), 'refresh runs before the installer');
  assert.match(dockerfile, /^WORKDIR \/app$/m);
  assert.match(dockerfile, /^COPY package\.json tsconfig\.json \.\/$/m);
  assert.match(dockerfile, /^COPY src \.\/src$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^EXPOSE 4100$/m);
  assert.match(dockerfile, /^CMD \["node", "dist\/server\.js"\]$/m);
  const server = readFileSync(join(ROOT, CONTEXT, 'src/server.ts'), 'utf8');
  assert.match(server, /process\.env\.PORT \?\? 4100/);
  assert.match(server, /req\.url === '\/healthz'/);
  assert.match(server, /Bearer \$\{TOKEN\}/);
  // The context must carry every input the recipe COPYs.
  for (const file of ['package.json', 'tsconfig.json', 'src/server.ts', 'src/run.ts', 'src/harness.py']) {
    assert.ok(readFileSync(join(ROOT, CONTEXT, file)).length > 0, file);
  }
});

test('the buildspec fits the CodeBuild override limit for any commit', () => {
  const other = 'a'.repeat(40);
  const size = JSON.stringify(buildspec(other)).length;
  assert.ok(size < 25_600, `buildspec ${size}`);
  assert.equal(JSON.stringify(buildspec(other)), JSON.stringify(buildspec(other)));
});
