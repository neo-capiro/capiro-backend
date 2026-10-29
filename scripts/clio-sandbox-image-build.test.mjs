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
  REQUIRED_MARKERS,
  SOURCE_BUCKET,
  SOURCE_REPOSITORY,
  assertSourceSha,
  buildspec,
  startBuildInput,
} from './clio-sandbox-image-build.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA = '13a5dd43fdb0c20614d667e3a0d28dba75623b1c';
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
  assert.deepEqual(input.environmentVariablesOverride, [{ name: 'EXPECTED_SHA', value: SHA, type: 'PLAINTEXT' }]);
  assert.equal(input.idempotencyToken, 'fixed-token');
  assert.equal(input.timeoutInMinutesOverride, 60);
  // No project/IAM/environment mutation and no deployment knobs in the request.
  for (const forbidden of ['environmentTypeOverride', 'serviceRoleOverride', 'computeTypeOverride', 'privilegedModeOverride']) {
    assert.equal(forbidden in input, false, forbidden);
  }
});

test('an exact versioned source archive can be pinned instead of GitHub resolution', () => {
  const archive = `${SOURCE_BUCKET}/inputs/clio-13a5dd43.zip@versionId.1`;
  const input = startBuildInput(SHA, 'fixed-token', archive);
  assert.equal(input.sourceTypeOverride, 'S3');
  assert.equal(input.sourceLocationOverride, `${SOURCE_BUCKET}/inputs/clio-13a5dd43.zip`);
  assert.equal(input.sourceVersion, 'versionId.1');
  assert.equal(input.projectName, PROJECT);
  assert.throws(() => startBuildInput(SHA, 't', 'other-bucket/x.zip@v'), /bucket must be/);
  assert.throws(() => startBuildInput(SHA, 't', 'no-version'), /<bucket>\/<key>@<versionId>/);
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
  const post = script('post_build');
  assert.match(post, /describe-image-scan-findings/);
  assert.match(post, /imageScanStatus/);
  assert.match(post, /"COMPLETE"/);
  assert.match(post, /counts\.get\("CRITICAL"/);
  assert.match(post, /counts\.get\("HIGH"/);
  assert.match(post, /IMAGE_SCAN_PASS/);
  // An incomplete scan must not be reported as a pass.
  assert.match(post, /scan did not reach COMPLETE/);
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

test('the gates match the real recipe and runtime sources', () => {
  const dockerfile = readFileSync(join(ROOT, DOCKERFILE), 'utf8');
  assert.match(dockerfile, /^FROM node:20-slim$/m);
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
