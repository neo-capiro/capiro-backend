// Lean immutable image build for Meri releases (program plan §9 and §10;
// deployment plan §2.2). Replaces the per-release launchers kept under outputs/.
// One CodeBuild run per service on the native ARM64 project capiro-build-web-dev,
// building the exact merged-main SHA, running an offline import smoke test inside
// the built image, then pushing it tagged by SHA. No capture-harness assertions.
// web-vnext builds apps/web/Dockerfile with CAPIRO_WEB_BUILD_SURFACE=vnext on the
// same native ARM64 project (never on this host: the web build segfaults under
// QEMU); its smoke test checks the static bundle and, when BUILD_WEB_PROBE is set,
// that the given release-specific string ships in the bundle.
//
//   BUILD_SERVICE=api|meriv2-orchestrator|web-vnext BUILD_SOURCE_SHA=<40-hex> BUILD_ROOT=<dir> \
//     [BUILD_WEB_PROBE='<text that must appear in the web bundle>'] \
//     node meri-image-build.mjs launch    # writes the intent, then starts exactly one build
//   ... node meri-image-build.mjs reconcile # read-only recovery for a lost start ack
//   ... node meri-image-build.mjs collect   # read-only; build+smoke are NOT qualified
//   ... node meri-image-build.mjs scan      # bounded exact-digest ECR scan; final gate
//
// Qualification is two stages: collect proves the immutable build and the offline
// image smoke; scan proves the exact pushed digest reached a COMPLETE ECR scan with
// 0 CRITICAL and 0 HIGH findings. collect alone never reports a qualified image.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SERVICE = process.env.BUILD_SERVICE;
const SOURCE_SHA = process.env.BUILD_SOURCE_SHA;
const ROOT = process.env.BUILD_ROOT;
const WEB_PROBE = process.env.BUILD_WEB_PROBE ?? '';
if (!['api', 'meriv2-orchestrator', 'web-vnext'].includes(SERVICE)) throw new Error('BUILD_SERVICE');
if (WEB_PROBE && (SERVICE !== 'web-vnext' || !/^[A-Za-z0-9 .,:_-]{3,80}$/.test(WEB_PROBE)))
  throw new Error('BUILD_WEB_PROBE');
if (!/^[0-9a-f]{40}$/.test(SOURCE_SHA ?? '')) throw new Error('BUILD_SOURCE_SHA');
if (!ROOT) throw new Error('BUILD_ROOT');
mkdirSync(ROOT, { recursive: true });

const PROJECT = 'capiro-build-web-dev';
const ACCOUNT = '967807252336';
const REGION = 'us-east-1';
const REPOSITORY = `capiro/dev/${SERVICE}`;
// The builder project still points at the legacy capirov2 repository, which
// does not contain the split backend commits. Each build pins the exact
// backend repository and SHA instead of mutating the project definition.
const SOURCE_REPOSITORY = 'https://github.com/neo-capiro/capiro-backend.git';
const PROFILE = process.env.BUILD_AWS_PROFILE ?? 'capiro-dev';
const IMAGE_MARKER = `CANDIDATE_IMAGE=`;
const REQUIRED = ['IMAGE_SMOKE_PASS', 'LOCAL_REPODIGEST_ECR_MATCH_PASS', 'PROMOTION_POLICY_TEST_PASS'];
const AWS = 'C:/Program Files/Amazon/AWSCLIV2/aws.exe';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const save = (name, value) =>
  writeFileSync(`${ROOT}/${name}`, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const aws = (args) =>
  JSON.parse(
    execFileSync(AWS, [...args, '--region', REGION, '--profile', PROFILE, '--output', 'json', '--no-cli-pager'], {
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }) || '{}',
  );

const image = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPOSITORY}:\${EXPECTED_SHA}`;

const preBuild = `set -euo pipefail
: "\${EXPECTED_SHA:?start-build must pass the exact merged-main SHA}"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]
test "\${CODEBUILD_RESOLVED_SOURCE_VERSION:-}" = "$EXPECTED_SHA"
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = ${ACCOUNT}
test "$(aws ecr list-images --region ${REGION} --repository-name ${REPOSITORY} --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='\${EXPECTED_SHA}'])" --output json)" = 0
python3 scripts/validate-meri-build-isolation.py
${SERVICE === 'meriv2-orchestrator' ? 'python3 scripts/validate-meri-orchestrator-build-only.py\n' : ''}
docker pull public.ecr.aws/docker/library/node:20.16.0-bookworm-slim
docker tag public.ecr.aws/docker/library/node:20.16.0-bookworm-slim node:20.16.0-bookworm-slim
# Required promotion/release policy gate: the historical ci-pr.yml wiring was
# removed with the other .github workflows, so the retained build path runs it.
docker run --rm --network none -v "$PWD":/src -w /src node:20.16.0-bookworm-slim node --test scripts/lib/meri-release-policy.test.mjs scripts/meri-release.test.mjs
echo PROMOTION_POLICY_TEST_PASS
aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com
`;

const webSmoke = `docker run --rm --network none --entrypoint sh "$image" -ec '
test -s /usr/share/nginx/html/index.html
test -x /docker-entrypoint.d/00-runtime-config.sh
grep -rl "__CAPIRO_CONFIG__" /usr/share/nginx/html/assets >/dev/null
${WEB_PROBE ? `grep -rlF "${WEB_PROBE}" /usr/share/nginx/html/assets >/dev/null\n` : ''}echo IMAGE_SMOKE_PASS'`;

const smoke = SERVICE === 'web-vnext'
  ? webSmoke
  : SERVICE === 'api'
    ? `docker run --rm --network none --entrypoint node "$image" -e "
const assert=require('node:assert/strict');
assert.equal(typeof require('@prisma/client').PrismaClient,'function');
require('./dist/meri/meri-tools.service.js');
const flags=require('./dist/common/meriv3-flags.js');
assert.equal(flags.meriV3ChatActive({}, {}),true);
assert.equal(flags.meriV3ChatActive({clioFeatureFlags:{'meriv3.fullChat':false}}, {}),false);
assert.equal(flags.meriV3ChatActive({}, {MERIV3_ENABLED:'false'}),false);
const proxy=require('./dist/meri/meriv3-proxy.service.js');
assert.equal(typeof proxy.MeriV3ProxyService.prototype.streamUnavailable,'function');
const fs=require('node:fs');
const names=fs.readdirSync('./prisma/migrations');
assert.ok(names.includes('20281007020000_clio_attachments_xlsx_kind'));
assert.ok(names.includes('20261005160000_krisp_notetaker'));
assert.ok(names.includes('20281008010000_clio_research_sessions_jobs'));
const job=require('./dist/meri/meri-job.js');
assert.equal(job.projectMeriJobStatus({status:'complete',metadata:{}}),'completed');
const sweeper=require('./dist/meri/meri-job-lease-sweeper.js');
assert.equal(sweeper.meriJobSweeperEnabled({}),false);
const inputs=require('./dist/meri/meri-research-producer-inputs.js');
assert.ok(inputs.PUBLIC_DATA_RESEARCH_TOOLS.has('search_public_web'));
assert.ok(!inputs.PUBLIC_DATA_RESEARCH_TOOLS.has('get_representation'));
assert.equal(typeof require('@capiro/meriv2-core').governedSteeringRowDecision,'function');
const shared=require('@capiro/shared');
assert.equal(shared.congressGovBillUrl('119-hr-8800'),'https://www.congress.gov/bill/119th-congress/house-bill/8800');
assert.equal(shared.classifyApiToolReadOutcome('get_pe_budget_timeline',{tool:'get_pe_budget_timeline',generatedAt:'t',years:[{}]}).kind,'complete');
console.log('IMAGE_SMOKE_PASS');
"`
    : `docker run --rm --network none --entrypoint node "$image" -e "
const assert=require('node:assert/strict');
const access=require('/app/apps/meriv2-orchestrator/dist/meri/meriv3/meriv3-access.service.js');
assert.equal(access.meriV3EnvironmentEnabled({}),true);
assert.equal(access.tenantFlagEnabled({clioFeatureFlags:{'meriv3.fullChat':false}}),false);
const client=require('/app/apps/meriv2-orchestrator/dist/meri/meriv3/openai-responses.client.js');
assert.equal(client.parseRetryAfterMs(new Headers({'retry-after':'2'})),2000);
const shared=require('@capiro/shared');
assert.equal(shared.extractCitationsFromToolResult('get_bill_status',{found:true,billId:'119-hr-8800',title:'T'},1)[0].url,'https://www.congress.gov/bill/119th-congress/house-bill/8800');
const core=require('/app/packages/meriv2-core/dist/index.js');
assert.ok(!core.inferClaimCategories('How did this PE change from FY26 enacted to FY27 requested?').includes('member_vote'));
assert.equal(shared.classifyApiToolReadOutcome('get_pe_budget_timeline',{tool:'get_pe_budget_timeline',generatedAt:'t',years:[{}]}).kind,'complete');
console.log('IMAGE_SMOKE_PASS');
"`;

const build = `set -euo pipefail
image="${image}"
docker build --platform linux/arm64 ${SERVICE === 'meriv2-orchestrator' ? '--no-cache ' : ''}\\
${SERVICE === 'web-vnext' ? '  --build-arg NODE_VERSION=22.23.3 --build-arg GIT_SHA="$EXPECTED_SHA" --build-arg CAPIRO_WEB_BUILD_SURFACE=vnext \\\n' : ''}  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \\
  --label 'org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend' \\
  -f apps/${SERVICE === 'web-vnext' ? 'web' : SERVICE}/Dockerfile -t "$image" .
test "$(docker image inspect "$image" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
${smoke}
`;

const postBuild = `set -euo pipefail
test "\${CODEBUILD_BUILD_SUCCEEDING:-0}" = 1
image="${image}"
docker push "$image"
docker image inspect "$image" --format '{{json .RepoDigests}}' > pushed-repo-digests.json
digest="$(aws ecr describe-images --region ${REGION} --repository-name ${REPOSITORY} --image-ids "imageTag=\${EXPECTED_SHA}" --query 'imageDetails[0].imageDigest' --output text)"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
python3 - "$digest" <<'PY'
import json,sys
target='${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPOSITORY}@'+sys.argv[1]
assert target in json.load(open('pushed-repo-digests.json'))
print('LOCAL_REPODIGEST_ECR_MATCH_PASS')
PY
echo "${IMAGE_MARKER}${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPOSITORY}@$digest"
`;

const phase = (script) => ({
  'on-failure': 'ABORT',
  commands: [
    `set -euo pipefail\nprintf '%s' '${gzipSync(Buffer.from(script, 'utf8')).toString('base64')}' | base64 -d | gzip -dc | bash`,
  ],
});

// A build intent is written before StartBuild so a lost acknowledgement can be
// reconciled read-only against real CodeBuild builds. It binds the exact
// service/project/source/SHA/repository/intent, never a guess.
export function buildIntent(sha, at = new Date().toISOString(), idempotencyToken = randomUUID()) {
  return {
    at,
    service: SERVICE,
    project: PROJECT,
    sourceRepository: SOURCE_REPOSITORY,
    sourceSha: sha,
    repository: REPOSITORY,
    idempotencyToken,
  };
}

export function assertIntent(intent) {
  const failures = [];
  if (intent?.service !== SERVICE) failures.push('service');
  if (intent?.project !== PROJECT) failures.push('project');
  if (intent?.sourceRepository !== SOURCE_REPOSITORY) failures.push('sourceRepository');
  if (!/^[0-9a-f]{40}$/.test(intent?.sourceSha ?? '')) failures.push('sourceSha');
  if (intent?.repository !== REPOSITORY) failures.push('repository');
  if (!intent?.at || Number.isNaN(Date.parse(intent.at))) failures.push('at');
  if (failures.length) throw new Error(`BUILD_INTENT_INVALID: ${failures.join(',')}`);
  return intent;
}

// Pure decision used by `reconcile`: only an unambiguous build that matches the
// recorded intent is accepted; zero or multiple matches stay explicit.
export function selectReconcileMatch(builds, intent, windowMs = 6 * 60 * 60 * 1000) {
  const intentAt = Date.parse(intent.at);
  const matches = (builds ?? []).filter((build) => {
    if (!build?.id || build.projectName !== PROJECT) return false;
    if (build.source?.location !== SOURCE_REPOSITORY) return false;
    if (build.sourceVersion !== intent.sourceSha && build.resolvedSourceVersion !== intent.sourceSha) return false;
    const started = Date.parse(build.startTime ?? '');
    if (Number.isNaN(started) || started < intentAt - 120_000 || started > intentAt + windowMs) return false;
    return true;
  });
  if (matches.length === 0) return { state: 'NO_MATCH', buildIds: [] };
  if (matches.length > 1) return { state: 'AMBIGUOUS', buildIds: matches.map((build) => build.id) };
  return { state: 'MATCH', build: matches[0], buildIds: [matches[0].id] };
}

export function buildspecFor() {
  return {
    version: 0.2,
    env: { shell: 'bash' },
    phases: { pre_build: phase(preBuild), build: phase(build), post_build: phase(postBuild) },
  };
}

function launch() {
  if (existsSync(`${ROOT}/build-start.json`)) throw new Error('ALREADY_LAUNCHED_DO_NOT_REPLAY');
  if (existsSync(`${ROOT}/build-intent.json`)) throw new Error('BUILD_INTENT_EXISTS_USE_RECONCILE');
  const intent = buildIntent(SOURCE_SHA);
  writeFileSync(`${ROOT}/build-intent.json`, `${JSON.stringify(intent, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(`${ROOT}/phase-pre_build.sh`, preBuild);
  writeFileSync(`${ROOT}/phase-build.sh`, build);
  writeFileSync(`${ROOT}/phase-post_build.sh`, postBuild);
  const buildspecOverride = JSON.stringify(buildspecFor());
  if (buildspecOverride.length > 25_600) throw new Error(`BUILDSPEC_TOO_LONG_${buildspecOverride.length}`);
  const input = {
    projectName: PROJECT,
    sourceTypeOverride: 'GITHUB',
    sourceLocationOverride: SOURCE_REPOSITORY,
    sourceVersion: SOURCE_SHA,
    buildspecOverride,
    environmentVariablesOverride: [{ name: 'EXPECTED_SHA', value: SOURCE_SHA, type: 'PLAINTEXT' }],
    idempotencyToken: intent.idempotencyToken,
    timeoutInMinutesOverride: 60,
  };
  const inputBytes = `${JSON.stringify(input, null, 2)}\n`;
  writeFileSync(`${ROOT}/build-input.json`, inputBytes, { flag: 'wx' });
  const started = aws(['codebuild', 'start-build', '--cli-input-json', `file://${ROOT}/build-input.json`]);
  save('build-start.json', {
    at: new Date().toISOString(),
    service: SERVICE,
    sourceSha: SOURCE_SHA,
    buildId: started.build.id,
    status: started.build.buildStatus,
    webProbe: WEB_PROBE || null,
    buildspecSha256: sha256(buildspecOverride),
    buildspecCharacters: buildspecOverride.length,
    requiredMarkers: REQUIRED,
    reconciled: false,
  });
  console.log(JSON.stringify({ launched: started.build.id, status: started.build.buildStatus, chars: buildspecOverride.length }));
}

// Read-only recovery after a lost StartBuild acknowledgement: never calls
// start-build, never resends, and records only a single exact match.
function reconcile() {
  if (!existsSync(`${ROOT}/build-intent.json`)) throw new Error('BUILD_INTENT_REQUIRED');
  const intent = assertIntent(JSON.parse(readFileSync(`${ROOT}/build-intent.json`, 'utf8')));
  if (existsSync(`${ROOT}/build-start.json`)) {
    console.log(JSON.stringify({ state: 'ALREADY_RECORDED', start: JSON.parse(readFileSync(`${ROOT}/build-start.json`, 'utf8')) }, null, 2));
    return;
  }
  const ids = [];
  let nextToken;
  do {
    const page = aws(['codebuild', 'list-builds-for-project', '--project-name', PROJECT, '--max-items', '100', ...(nextToken ? ['--starting-token', nextToken] : [])]);
    ids.push(...(page.ids ?? []));
    nextToken = page.nextToken;
  } while (nextToken && ids.length < 500);
  const builds = [];
  for (let index = 0; index < ids.length; index += 100) {
    builds.push(...(aws(['codebuild', 'batch-get-builds', '--ids', ...ids.slice(index, index + 100)]).builds ?? []));
  }
  const decision = selectReconcileMatch(builds, intent);
  if (decision.state !== 'MATCH') {
    console.log(JSON.stringify({ state: decision.state, intent, buildIds: decision.buildIds, recorded: false }, null, 2));
    process.exitCode = decision.state === 'AMBIGUOUS' ? 2 : 1;
    return;
  }
  const matched = decision.build;
  save('build-start.json', {
    at: new Date().toISOString(),
    service: SERVICE,
    sourceSha: intent.sourceSha,
    buildId: matched.id,
    status: matched.buildStatus,
    webProbe: WEB_PROBE || null,
    requiredMarkers: REQUIRED,
    reconciled: true,
    matchedOn: {
      projectName: matched.projectName,
      sourceLocation: matched.source?.location ?? null,
      sourceVersion: matched.sourceVersion ?? null,
      resolvedSourceVersion: matched.resolvedSourceVersion ?? null,
      startTime: matched.startTime ?? null,
      intentAt: intent.at,
    },
  });
  console.log(JSON.stringify({ state: 'MATCH', recorded: true, buildId: matched.id }, null, 2));
}

function readScan() {
  if (!existsSync(`${ROOT}/scan-readback.json`)) return null;
  return JSON.parse(readFileSync(`${ROOT}/scan-readback.json`, 'utf8'));
}

function collect() {
  const start = JSON.parse(readFileSync(`${ROOT}/build-start.json`, 'utf8'));
  const scanned = readScan();
  if (existsSync(`${ROOT}/build-readback.json`)) {
    const readback = JSON.parse(readFileSync(`${ROOT}/build-readback.json`, 'utf8'));
    if (scanned && scanned.digest === readback.imageDigest && scanned.qualified === true) {
      console.log(JSON.stringify({ ...readback, qualified: true, qualification: 'BUILD_SMOKE_AND_DIGEST_SCAN_PASS', scan: scanned }, null, 2));
    } else {
      console.log(JSON.stringify({ ...readback, qualified: false, nextStage: 'scan' }, null, 2));
    }
    return;
  }
  const b = aws(['codebuild', 'batch-get-builds', '--ids', start.buildId]).builds?.[0];
  if (!b) throw new Error('BUILD_NOT_FOUND');
  if (!b.buildComplete) {
    console.log(JSON.stringify({ buildId: b.id, status: b.buildStatus, phase: b.currentPhase, complete: false }));
    return;
  }
  const lines = [];
  let token;
  for (;;) {
    const page = aws(['logs', 'get-log-events', '--log-group-name', b.logs.groupName, '--log-stream-name', b.logs.streamName, '--start-from-head', ...(token ? ['--next-token', token] : []), '--limit', '10000']);
    for (const e of page.events ?? []) lines.push(e.message.replace(/\n$/, ''));
    if (!page.nextForwardToken || page.nextForwardToken === token || !(page.events ?? []).length) break;
    token = page.nextForwardToken;
  }
  const log = `${lines.join('\n')}\n`;
  writeFileSync(`${ROOT}/build.txt`, log);
  const seen = new Set(log.match(/\b[A-Z0-9_]+_PASS\b/g) ?? []);
  const imageLine = log.split('\n').find((line) => line.startsWith(IMAGE_MARKER));
  const candidate = imageLine ? imageLine.slice(IMAGE_MARKER.length).trim() : null;
  let manifest = null;
  if (candidate) {
    const digest = candidate.split('@')[1];
    manifest = aws(['ecr', 'describe-images', '--repository-name', REPOSITORY, '--image-ids', `imageDigest=${digest}`]).imageDetails?.[0] ?? null;
    if (!manifest?.imageTags?.includes(SOURCE_SHA)) throw new Error('IMAGE_TAG_SOURCE_MISMATCH');
  }
  const ok = b.buildStatus === 'SUCCEEDED' && b.resolvedSourceVersion === SOURCE_SHA && REQUIRED.every((m) => seen.has(m)) && Boolean(candidate);
  save('build-readback.json', {
    at: new Date().toISOString(),
    service: SERVICE,
    status: b.buildStatus,
    // Build + offline image smoke are necessary but NOT a qualification.
    qualification: ok ? 'BUILD_AND_IMAGE_SMOKE_PASS_NOT_QUALIFIED' : 'BUILD_NOT_QUALIFIED',
    qualified: false,
    nextStage: 'scan',
    sourceSha: SOURCE_SHA,
    resolvedSourceSha: b.resolvedSourceVersion ?? null,
    buildId: b.id,
    startedAt: b.startTime,
    finishedAt: b.endTime,
    requiredMarkers: REQUIRED,
    markersSeen: REQUIRED.filter((m) => seen.has(m)),
    image: candidate,
    imageDigest: manifest?.imageDigest ?? null,
    imageTags: manifest?.imageTags ?? [],
  });
  console.log(readFileSync(`${ROOT}/build-readback.json`, 'utf8'));
}

// Bounded, read-only exact-digest scan stage. The tag is mutable, so the scan
// is bound to the digest recorded by collect and the tag->digest resolution is
// re-verified first.
export function scan() {
  if (!existsSync(`${ROOT}/build-readback.json`)) throw new Error('SCAN_REQUIRES_COLLECTED_DIGEST');
  const readback = JSON.parse(readFileSync(`${ROOT}/build-readback.json`, 'utf8'));
  const digest = readback.imageDigest ?? (readback.image ? String(readback.image).split('@')[1] : null);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) throw new Error('SCAN_REQUIRES_COLLECTED_DIGEST');
  const tagged = aws(['ecr', 'describe-images', '--repository-name', REPOSITORY, '--image-ids', `imageTag=${SOURCE_SHA}`]).imageDetails ?? [];
  if (tagged.length !== 1 || tagged[0].imageDigest !== digest || !(tagged[0].imageTags ?? []).includes(SOURCE_SHA)) {
    throw new Error(`TAG_MOVED: ${SOURCE_SHA} no longer resolves to ${digest}`);
  }
  const attempts = Number(process.env.MERI_SCAN_ATTEMPTS ?? 30);
  const interval = Number(process.env.MERI_SCAN_INTERVAL ?? 10);
  const deadline = attempts;
  for (let attempt = 1; attempt <= deadline; attempt += 1) {
    const scanned = aws(['ecr', 'describe-image-scan-findings', '--repository-name', REPOSITORY, '--image-id', `imageDigest=${digest}`]);
    if ((scanned.imageId ?? {}).imageDigest !== digest) throw new Error(`DIGEST_MISMATCH: scan response is for ${(scanned.imageId ?? {}).imageDigest}`);
    if (scanned.imageScanStatus?.status === 'COMPLETE') {
      const counts = scanned.imageScanFindings?.findingSeverityCounts ?? {};
      const critical = Number(counts.CRITICAL ?? 0);
      const high = Number(counts.HIGH ?? 0);
      if (critical || high) throw new Error(`SCAN_FINDINGS: ${critical} CRITICAL, ${high} HIGH for ${digest}`);
      const record = { at: new Date().toISOString(), service: SERVICE, sourceSha: SOURCE_SHA, digest, status: 'COMPLETE', counts, qualified: true };
      save('scan-readback.json', record);
      console.log(`IMAGE_SCAN_PASS digest=${digest}`);
      return;
    }
    if (attempt < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, interval) * 1000);
  }
  throw new Error(`SCAN_INCOMPLETE for ${digest}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'launch') launch();
  else if (process.argv[2] === 'reconcile') reconcile();
  else if (process.argv[2] === 'collect') collect();
  else if (process.argv[2] === 'scan') scan();
  else throw new Error('Use launch, reconcile, collect or scan');
}
