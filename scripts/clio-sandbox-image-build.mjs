// Dedicated Clio analysis-sandbox image build (maintenance lane, 2026-10-29).
//
// WHY THIS EXISTS: apps/clio-sandbox is a live consumer (service
// capiro-dev-clio-sandbox, task definition rev 3: ARM64, node user, read-only
// root filesystem, port 4100, GET /healthz, zero task-role grants, no-egress
// security group). Its historical .github/workflows/sandbox-image.yml was
// removed by the inert backend import (c76f5fc0), so no current exact-source
// build path was bound. This operator rebinds the *existing* dedicated recipe
// and context to the *existing* authorized ARM builder (CodeBuild project
// capiro-build-web-dev). It adds no pipeline, no project, no IAM and no
// deployment step: it builds, qualifies and pushes one immutably tagged image.
//
// BINDINGS (exact, reviewable):
//   recipe        apps/clio-sandbox/Dockerfile
//   context       apps/clio-sandbox            (NOT the repository root: the
//                 recipe COPYs package.json/tsconfig.json/src from the app dir)
//   source        https://github.com/neo-capiro/capiro-backend.git at the exact
//                 40-hex SHA (the builder project itself still points at the
//                 legacy capirov2 repository, which does not contain the
//                 frozen backend commits, so the request pins the source per
//                 build instead of changing the project). This is the only
//                 supported source route: a direct-S3 build is not implemented
//                 and would silently weaken the git provenance gates below.
//   repository    967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/clio-sandbox
//   tag           <exact source SHA> — the only tag; `latest` is never produced
//
// GATES (all fail closed, all evidence is a printed marker):
//   native        aarch64 pre-build host + arm64 image config
//   nonroot       image Config.User = node and `id -u != 0` inside the container
//   read-only     smoke container runs with --read-only and a tmpfs /tmp,
//                 mirroring the live task's readonlyRootFilesystem
//   offline       smoke runs with --network none; the runtime gets no egress
//   behaviour     GET /healthz returns {ok:true}; POST /run without the bearer
//                 token returns 401; POST /run with the token executes Python
//                 (ok:true, stdout captured); the pinned analysis stack imports
//   provenance    resolved source SHA, clean tree, ECR tag-absence and the
//                 local RepoDigest = ECR digest readback
//   scan          ECR basic scan must reach COMPLETE with 0 CRITICAL and
//                 0 HIGH findings for the exact pushed digest
//
// COMMANDS
//   node scripts/clio-sandbox-image-build.mjs plan
//       Print the exact StartBuild request JSON (no AWS call, nothing written).
//       This is the artifact Root reviews before authorizing a build.
//   node scripts/clio-sandbox-image-build.mjs preflight
//       Read-only builder/account/repository readiness check.
//   node scripts/clio-sandbox-image-build.mjs launch
//       Start exactly one build (needs CLIO_BUILD_SOURCE_SHA and
//       CLIO_BUILD_ROOT). Root owns this call. The build intent is written
//       before StartBuild, so a lost acknowledgement is recoverable.
//   node scripts/clio-sandbox-image-build.mjs reconcile
//       Read-only recovery for a lost StartBuild acknowledgement: binds the
//       recorded intent to exactly one real CodeBuild build by comparing the
//       SERVER-RETURNED buildspec digest and the exclusive operation marker in
//       the effective environment overrides (plus project/source/version/time).
//       Never resends; NO_MATCH, AMBIGUOUS and UNKNOWN stay explicit.
//   node scripts/clio-sandbox-image-build.mjs collect
//       Read-only; rerun until the build is complete. The build id is re-bound
//       to the recorded intent before any log is read, so a supplied build id
//       cannot adopt another build.
//
// ENV
//   CLIO_BUILD_SOURCE_SHA   40-hex source commit (required for launch/plan/preflight)
//   CLIO_BUILD_ROOT         evidence directory (required for launch/collect)
//   CLIO_BUILD_AWS_PROFILE  AWS profile (default: capiro-dev, as in the retained helper)
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROJECT = 'capiro-build-web-dev';
export const ACCOUNT = '967807252336';
export const REGION = 'us-east-1';
export const REPOSITORY = 'capiro/dev/clio-sandbox';
export const SOURCE_REPOSITORY = 'https://github.com/neo-capiro/capiro-backend.git';
export const DOCKERFILE = 'apps/clio-sandbox/Dockerfile';
export const CONTEXT = 'apps/clio-sandbox';
export const SERVICE = 'clio-sandbox';
export const CONTAINER_PORT = 4100;
// Exclusive per-operation marker, carried in the environment override and
// returned by BatchGetBuilds, so a build from the same project and commit for a
// different service cannot be adopted as this one.
export const OPERATION_MARKER_ENV = 'CAPIRO_BUILD_OPERATION_MARKER';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REQUIRED_MARKERS = ['IMAGE_SMOKE_PASS', 'LOCAL_REPODIGEST_ECR_MATCH_PASS', 'IMAGE_SCAN_PASS'];
export const IMAGE_MARKER = 'CANDIDATE_IMAGE=';
const PROFILE = process.env.CLIO_BUILD_AWS_PROFILE ?? 'capiro-dev';
const AWS = 'C:/Program Files/Amazon/AWSCLIV2/aws.exe';
const IMAGE = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPOSITORY}`;

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function assertSourceSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error('CLIO_BUILD_SOURCE_SHA must be 40 lowercase hex characters');
  return value;
}

// The dedicated recipe/context contract the live service depends on. Kept in
// the pre-build phase so a drifted recipe or context fails before any build.
const RECIPE_GATES = `# Dedicated recipe + app-directory context (live service contract).
test -f ${DOCKERFILE}
test -f ${CONTEXT}/package.json
test -f ${CONTEXT}/tsconfig.json
test -f ${CONTEXT}/src/server.ts
test -f ${CONTEXT}/src/run.ts
test -f ${CONTEXT}/src/harness.py
grep -qF 'EXPOSE ${CONTAINER_PORT}' ${DOCKERFILE}
grep -qF 'USER node' ${DOCKERFILE}
grep -qF 'CMD ["node", "dist/server.js"]' ${DOCKERFILE}
grep -qF "req.url === '/healthz'" ${CONTEXT}/src/server.ts
grep -qF 'process.env.PORT ?? ${CONTAINER_PORT}' ${CONTEXT}/src/server.ts
# The sandbox must not inherit a network client or AWS SDK: no egress, no creds.
! grep -Eq 'aws-sdk|@aws-sdk|curl|wget|http-proxy' ${DOCKERFILE}`;

const preBuild = `set -euo pipefail
: "\${EXPECTED_SHA:?start-build must pass the exact source SHA}"
[[ "\$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]
test "\${CODEBUILD_RESOLVED_SOURCE_VERSION:-}" = "\$EXPECTED_SHA"
test "\$(git rev-parse HEAD)" = "\$EXPECTED_SHA"
test -z "\$(git status --porcelain --untracked-files=no)"
test "\$(uname -m)" = aarch64
test "\$(aws sts get-caller-identity --query Account --output text)" = ${ACCOUNT}
test "\$(aws ecr list-images --region ${REGION} --repository-name ${REPOSITORY} --filter tagStatus=TAGGED --query "length(imageIds[?imageTag=='\${EXPECTED_SHA}'])" --output json)" = 0
${RECIPE_GATES}
aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com
`;

// Mirrors the live task: read-only root filesystem, tmpfs /tmp, non-root, no
// network. A code path that needs to write outside /tmp, or that needs egress,
// fails here instead of at the first production run.
const smoke = `docker run --rm -i --network none --read-only --tmpfs /tmp --user node \\
  -e TMPDIR=/tmp -e HOME=/tmp -e MPLCONFIGDIR=/tmp/mpl -e MPLBACKEND=Agg \\
  -e CLIO_SANDBOX_TOKEN=clio-smoke-token \\
  --entrypoint sh "\$image" -s <<'CLIO_SMOKE'
set -e
test "\$(id -u)" != "0"
test -s /app/dist/server.js
test -s /app/dist/run.js
test -s /app/dist/harness.py
python3 -I -c "import pandas, numpy, matplotlib, scipy, statsmodels, seaborn, networkx"
node dist/server.js &
server=\$!
python3 - <<'CLIO_PROBE'
import json, sys, time, urllib.error, urllib.request

BASE = "http://127.0.0.1:4100"

def post(path, payload, token=None):
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(BASE + path, data=data, method="POST")
    request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, None

for _ in range(60):
    try:
        with urllib.request.urlopen(BASE + "/healthz", timeout=5) as response:
            status, body = response.status, json.loads(response.read().decode("utf-8"))
        if status == 200 and body.get("ok") is True:
            break
    except Exception:
        time.sleep(0.5)
else:
    sys.exit("healthz never became ready")

status, _ = post("/run", {"code": "print(1)"})
if status != 401:
    sys.exit("unauthenticated /run returned %s, expected 401" % status)

status, body = post("/run", {"code": "print('clio-smoke-ok')"}, token="clio-smoke-token")
if status != 200 or not body or body.get("ok") is not True or "clio-smoke-ok" not in (body.get("stdout") or ""):
    sys.exit("authenticated /run did not execute python: %s %s" % (status, body))
print("IMAGE_HEALTHZ_TOKEN_BOUNDARY_AND_RUN_PASS")
CLIO_PROBE
kill "\$server"
wait "\$server" 2>/dev/null || true
echo IMAGE_SMOKE_PASS
CLIO_SMOKE`;

const build = `set -euo pipefail
image="${IMAGE}:\${EXPECTED_SHA}"
docker build --platform linux/arm64 \\
  --label "org.opencontainers.image.revision=\$EXPECTED_SHA" \\
  --label 'org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend' \\
  -f ${DOCKERFILE} -t "\$image" ${CONTEXT}
test "\$(docker image inspect "\$image" --format '{{.Architecture}}')" = arm64
test "\$(docker image inspect "\$image" --format '{{.Config.User}}')" = node
test "\$(docker image inspect "\$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "\$EXPECTED_SHA"
${smoke}
`;

const postBuild = `set -euo pipefail
test "\${CODEBUILD_BUILD_SUCCEEDING:-0}" = 1
image="${IMAGE}:\${EXPECTED_SHA}"
docker push "\$image"
docker image inspect "\$image" --format '{{json .RepoDigests}}' > pushed-repo-digests.json
digest="\$(aws ecr describe-images --region ${REGION} --repository-name ${REPOSITORY} --image-ids "imageTag=\${EXPECTED_SHA}" --query 'imageDetails[0].imageDigest' --output text)"
[[ "\$digest" =~ ^sha256:[0-9a-f]{64}\$ ]]
python3 - "\$digest" <<'CLIO_DIGEST'
import json, sys
target = '${IMAGE}@' + sys.argv[1]
assert target in json.load(open('pushed-repo-digests.json')), target
print('LOCAL_REPODIGEST_ECR_MATCH_PASS')
CLIO_DIGEST
# ECR basic scanning is asynchronous and the tag is mutable, so the scan gate
# binds the exact captured digest: it re-checks the tag->digest resolution,
# scans by digest, requires the response to echo that digest, and requires
# COMPLETE with 0 CRITICAL and 0 HIGH findings.
python3 scripts/clio-image-scan-gate.py "$EXPECTED_SHA" "$digest"
echo "${IMAGE_MARKER}${IMAGE}@\$digest"
`;

const phase = (script) => ({
  'on-failure': 'ABORT',
  commands: [`set -euo pipefail\nprintf '%s' '${gzipSync(Buffer.from(script, 'utf8')).toString('base64')}' | base64 -d | gzip -dc | bash`],
});

export function buildspec(sourceSha) {
  assertSourceSha(sourceSha);
  return {
    version: 0.2,
    env: { shell: 'bash' },
    phases: { pre_build: phase(preBuild), build: phase(build), post_build: phase(postBuild) },
  };
}

// The exact StartBuild input. sourceTypeOverride/sourceLocationOverride pin the
// split backend repository for this one build; the project definition, its
// service role and its IAM are left untouched.
export function startBuildInput(sourceSha, idempotencyToken = randomUUID(), operationMarker = randomUUID()) {
  const override = JSON.stringify(buildspec(sourceSha));
  if (override.length > 25_600) throw new Error(`BUILDSPEC_TOO_LONG_${override.length}`);
  return {
    projectName: PROJECT,
    sourceTypeOverride: 'GITHUB',
    sourceLocationOverride: SOURCE_REPOSITORY,
    sourceVersion: sourceSha,
    buildspecOverride: override,
    // EXPECTED_SHA is the provenance gate; the operation marker is the exclusive
    // per-operation identity that BatchGetBuilds returns in the effective
    // environment, so a build from the same project/commit for another service
    // cannot be adopted.
    environmentVariablesOverride: [
      { name: 'EXPECTED_SHA', value: sourceSha, type: 'PLAINTEXT' },
      { name: OPERATION_MARKER_ENV, value: operationMarker, type: 'PLAINTEXT' },
    ],
    idempotencyToken,
    timeoutInMinutesOverride: 60,
  };
}


const aws = (args, options = {}) =>
  JSON.parse(
    execFileSync(AWS, [...args, '--region', REGION, '--profile', PROFILE, '--output', 'json', '--no-cli-pager'], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      ...options,
    }) || '{}',
  );

function plan() {
  const input = startBuildInput(process.env.CLIO_BUILD_SOURCE_SHA ?? '');
  const override = input.buildspecOverride;
  console.log(
    JSON.stringify(
      {
        command: ['aws', 'codebuild', 'start-build', '--cli-input-json', 'file://<root>/build-input.json', '--profile', PROFILE, '--region', REGION],
        request: input,
        buildspecSha256: sha256(override),
        buildspecCharacters: override.length,
        requiredMarkers: REQUIRED_MARKERS,
      },
      null,
      2,
    ),
  );
}

function preflight() {
  const sha = assertSourceSha(process.env.CLIO_BUILD_SOURCE_SHA ?? '');
  const identity = aws(['sts', 'get-caller-identity']);
  const project = aws(['codebuild', 'batch-get-projects', '--names', PROJECT]).projects?.[0];
  if (!project) throw new Error(`CodeBuild project ${PROJECT} not found`);
  const repository = aws(['ecr', 'describe-repositories', '--repository-names', REPOSITORY]).repositories?.[0];
  if (!repository) throw new Error(`ECR repository ${REPOSITORY} not found`);
  let tagExists = true;
  try {
    aws(['ecr', 'describe-images', '--repository-name', REPOSITORY, '--image-ids', `imageTag=${sha}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    tagExists = false;
  }
  const facts = {
    profile: PROFILE,
    account: identity.Account,
    caller: identity.Arn,
    project: project.name,
    projectEnvironmentType: project.environment?.type,
    projectImage: project.environment?.image,
    projectServiceRole: project.serviceRole,
    configuredSource: project.source?.location,
    sourceOverrideForThisBuild: SOURCE_REPOSITORY,
    sourceVersionPinned: sha,
    repository: repository.repositoryName,
    scanOnPush: repository.imageScanningConfiguration?.scanOnPush ?? false,
    tagMutability: repository.imageTagMutability,
    tagAlreadyExists: tagExists,
    ready: true,
  };
  facts.ready =
    facts.account === ACCOUNT &&
    facts.projectEnvironmentType === 'ARM_CONTAINER' &&
    facts.scanOnPush === true &&
    facts.tagAlreadyExists === false;
  console.log(JSON.stringify(facts, null, 2));
  if (!facts.ready) process.exitCode = 1;
}

const IDENTITY_WINDOW_MS = 6 * 60 * 60 * 1000;

// A build intent is written before StartBuild so a lost acknowledgement can be
// reconciled read-only against real CodeBuild builds. It binds the exact
// service/project/source/SHA/repository, an exclusive per-operation marker that
// travels in the submitted environment override and comes back in the Build,
// and the exact buildspec digest.
export function buildIntent(sha, at = new Date().toISOString(), idempotencyToken = randomUUID(), operationMarker = randomUUID()) {
  const input = startBuildInput(sha, idempotencyToken, operationMarker);
  return {
    at,
    service: SERVICE,
    project: PROJECT,
    sourceRepository: SOURCE_REPOSITORY,
    sourceSha: sha,
    repository: REPOSITORY,
    idempotencyToken,
    operationMarker,
    buildspecSha256: sha256(input.buildspecOverride),
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
  if (!UUID.test(intent?.idempotencyToken ?? '')) failures.push('idempotencyToken');
  if (!UUID.test(intent?.operationMarker ?? '')) failures.push('operationMarker');
  if (!/^[0-9a-f]{64}$/.test(intent?.buildspecSha256 ?? '')) failures.push('buildspecSha256');
  if (failures.length) throw new Error(`BUILD_INTENT_INVALID: ${failures.join(',')}`);
  return intent;
}

// Identity of the build AWS actually ran, taken from the returned Build:
// project, source type/location/version, the server-returned buildspec bytes
// and the effective environment overrides. A field AWS does not return is
// UNKNOWN, never assumed; any concrete contradiction is MISMATCH.
export function verifyBuildIdentity(build, intent, windowMs = IDENTITY_WINDOW_MS) {
  if (!build?.id) return { state: 'UNKNOWN', reasons: ['build-id-unavailable'], observed: null };
  const problems = [];
  const unknown = [];
  if (build.projectName !== PROJECT) problems.push('project');
  const source = build.source && typeof build.source === 'object' ? build.source : null;
  if (!source) unknown.push('source-unavailable');
  else {
    if (source.type !== 'GITHUB') problems.push('source-type');
    if (source.location !== SOURCE_REPOSITORY) problems.push('source-location');
  }
  if (build.sourceVersion !== intent.sourceSha && build.resolvedSourceVersion !== intent.sourceSha) problems.push('source-version');
  const started = Date.parse(build.startTime ?? '');
  const intentAt = Date.parse(intent.at);
  if (Number.isNaN(started) || Number.isNaN(intentAt) || started < intentAt - 120_000 || started > intentAt + windowMs) problems.push('start-time');
  const buildspec = source?.buildspec;
  const observedBuildspecSha256 = typeof buildspec === 'string' && buildspec.length > 0 ? sha256(buildspec) : null;
  if (observedBuildspecSha256 === null) unknown.push('buildspec-unavailable');
  else if (observedBuildspecSha256 !== intent.buildspecSha256) problems.push('buildspec');
  const variables = build.environment?.environmentVariables;
  let observedOperationMarker = null;
  if (!Array.isArray(variables)) unknown.push('environment-unavailable');
  else {
    const marker = variables.find((entry) => entry?.name === OPERATION_MARKER_ENV);
    if (!marker) unknown.push('operation-marker-unavailable');
    else {
      observedOperationMarker = marker.value ?? null;
      if (observedOperationMarker !== intent.operationMarker) problems.push('operation-marker');
    }
  }
  const observed = {
    buildId: build.id,
    projectName: build.projectName ?? null,
    sourceType: source?.type ?? null,
    sourceLocation: source?.location ?? null,
    sourceVersion: build.sourceVersion ?? null,
    resolvedSourceVersion: build.resolvedSourceVersion ?? null,
    startTime: build.startTime ?? null,
    buildspecSha256: observedBuildspecSha256,
    operationMarker: observedOperationMarker,
    environmentVariableNames: Array.isArray(variables) ? variables.map((entry) => entry?.name).filter(Boolean) : null,
  };
  if (problems.length) return { state: 'MISMATCH', reasons: problems, observed };
  if (unknown.length) return { state: 'UNKNOWN', reasons: unknown, observed };
  return { state: 'MATCH', reasons: [], observed };
}

// Pure decision used by `reconcile`: only one unambiguous build whose returned
// identity equals the recorded intent is accepted. Zero matches, multiple
// exact matches and missing binding evidence stay explicit.
export function selectReconcileMatch(builds, intent, windowMs = IDENTITY_WINDOW_MS) {
  const intentAt = Date.parse(intent.at);
  const coarse = (builds ?? []).filter((build) => {
    if (!build?.id || build.projectName !== PROJECT) return false;
    if (build.source?.location !== SOURCE_REPOSITORY) return false;
    if (build.sourceVersion !== intent.sourceSha && build.resolvedSourceVersion !== intent.sourceSha) return false;
    const started = Date.parse(build.startTime ?? '');
    return !Number.isNaN(started) && started >= intentAt - 120_000 && started <= intentAt + windowMs;
  });
  if (coarse.length === 0) return { state: 'NO_MATCH', buildIds: [], rejected: [] };
  const verified = coarse.map((build) => ({ build, identity: verifyBuildIdentity(build, intent, windowMs) }));
  const exact = verified.filter((entry) => entry.identity.state === 'MATCH');
  if (exact.length === 1) {
    return { state: 'MATCH', build: exact[0].build, observed: exact[0].identity.observed, buildIds: [exact[0].build.id] };
  }
  if (exact.length > 1) return { state: 'AMBIGUOUS', buildIds: exact.map((entry) => entry.build.id) };
  const rejected = verified.map((entry) => ({ buildId: entry.build.id, state: entry.identity.state, reasons: entry.identity.reasons }));
  const unknown = verified.filter((entry) => entry.identity.state === 'UNKNOWN');
  if (unknown.length) {
    return { state: 'UNKNOWN', buildIds: unknown.map((entry) => entry.build.id), reasons: unknown.flatMap((entry) => entry.identity.reasons), rejected };
  }
  return { state: 'NO_MATCH', buildIds: [], rejected };
}
function launch() {
  const root = process.env.CLIO_BUILD_ROOT;
  if (!root) throw new Error('CLIO_BUILD_ROOT');
  const sha = assertSourceSha(process.env.CLIO_BUILD_SOURCE_SHA ?? '');
  mkdirSync(root, { recursive: true });
  if (existsSync(`${root}/build-start.json`)) throw new Error('ALREADY_LAUNCHED_DO_NOT_REPLAY');
  if (existsSync(`${root}/build-intent.json`)) throw new Error('BUILD_INTENT_EXISTS_USE_RECONCILE');
  const intent = buildIntent(sha);
  writeFileSync(`${root}/build-intent.json`, `${JSON.stringify(intent, null, 2)}\n`, { flag: 'wx' });
  const input = startBuildInput(sha, intent.idempotencyToken, intent.operationMarker);
  writeFileSync(`${root}/build-input.json`, `${JSON.stringify(input, null, 2)}\n`, { flag: 'wx' });
  const started = aws(['codebuild', 'start-build', '--cli-input-json', `file://${root}/build-input.json`]);
  const returned = started.build ?? null;
  if (!returned?.id) throw new Error('START_BUILD_RESPONSE_MISSING');
  const identity = verifyBuildIdentity(returned, intent);
  writeFileSync(
    `${root}/build-start.json`,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        service: SERVICE,
        sourceSha: sha,
        buildId: returned.id,
        status: returned.buildStatus ?? null,
        expectedBuildspecSha256: intent.buildspecSha256,
        observedBuildspecSha256: identity.observed?.buildspecSha256 ?? null,
        identityState: identity.state,
        identityReasons: identity.reasons,
        requiredMarkers: REQUIRED_MARKERS,
        reconciled: false,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ launched: returned.id, status: returned.buildStatus ?? null, identityState: identity.state }));
}
// Read-only recovery after a lost StartBuild acknowledgement. It never calls
// start-build, never resends, and records only one build whose returned
// buildspec and environment marker prove it is this exact request.
function reconcile() {
  const root = process.env.CLIO_BUILD_ROOT;
  if (!root) throw new Error('CLIO_BUILD_ROOT');
  if (!existsSync(`${root}/build-intent.json`)) throw new Error('BUILD_INTENT_REQUIRED');
  const intent = assertIntent(JSON.parse(readFileSync(`${root}/build-intent.json`, 'utf8')));
  if (existsSync(`${root}/build-start.json`)) {
    console.log(JSON.stringify({ state: 'ALREADY_RECORDED', start: JSON.parse(readFileSync(`${root}/build-start.json`, 'utf8')) }, null, 2));
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
    console.log(
      JSON.stringify(
        { state: decision.state, intent, buildIds: decision.buildIds, reasons: decision.reasons ?? [], rejected: decision.rejected ?? [], recorded: false },
        null,
        2,
      ),
    );
    process.exitCode = decision.state === 'AMBIGUOUS' ? 2 : 1;
    return;
  }
  const build = decision.build;
  const record = {
    at: new Date().toISOString(),
    service: SERVICE,
    sourceSha: intent.sourceSha,
    buildId: build.id,
    status: build.buildStatus,
    expectedBuildspecSha256: intent.buildspecSha256,
    observedBuildspecSha256: decision.observed.buildspecSha256,
    identityState: 'MATCH',
    identity: decision.observed,
    requiredMarkers: REQUIRED_MARKERS,
    reconciled: true,
  };
  writeFileSync(`${root}/build-start.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ state: 'MATCH', recorded: true, start: record }, null, 2));
}
function collect() {
  const root = process.env.CLIO_BUILD_ROOT;
  if (!root) throw new Error('CLIO_BUILD_ROOT');
  if (!existsSync(`${root}/build-intent.json`)) throw new Error('BUILD_INTENT_REQUIRED');
  const intent = assertIntent(JSON.parse(readFileSync(`${root}/build-intent.json`, 'utf8')));
  if (!existsSync(`${root}/build-start.json`)) throw new Error('BUILD_START_REQUIRED');
  if (existsSync(`${root}/build-readback.json`)) {
    console.log(readFileSync(`${root}/build-readback.json`, 'utf8'));
    return;
  }
  const start = JSON.parse(readFileSync(`${root}/build-start.json`, 'utf8'));
  const b = aws(['codebuild', 'batch-get-builds', '--ids', start.buildId]).builds?.[0];
  if (!b) throw new Error('BUILD_NOT_FOUND');
  // A user-supplied build id cannot bypass the identity of the request AWS ran.
  const identity = verifyBuildIdentity(b, intent);
  if (identity.state !== 'MATCH') {
    console.log(JSON.stringify({ state: 'IDENTITY_NOT_VERIFIED', buildId: b.id, identity }, null, 2));
    process.exitCode = 2;
    return;
  }
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
  writeFileSync(`${root}/build.txt`, log);
  const seen = new Set(log.match(/\b[A-Z0-9_]+_PASS\b/g) ?? []);
  const imageLine = log.split('\n').find((line) => line.startsWith(IMAGE_MARKER));
  const candidate = imageLine ? imageLine.slice(IMAGE_MARKER.length).trim() : null;
  const ok =
    b.buildStatus === 'SUCCEEDED' &&
    identity.observed.resolvedSourceVersion === intent.sourceSha &&
    REQUIRED_MARKERS.every((m) => seen.has(m)) &&
    Boolean(candidate);
  writeFileSync(
    `${root}/build-readback.json`,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        service: SERVICE,
        status: b.buildStatus,
        qualification: ok ? 'IMMUTABLE_BUILD_SMOKE_AND_SCAN_PASS' : 'BUILD_NOT_QUALIFIED',
        identityState: 'MATCH',
        identity: identity.observed,
        expectedBuildspecSha256: intent.buildspecSha256,
        observedBuildspecSha256: identity.observed.buildspecSha256,
        sourceSha: intent.sourceSha,
        resolvedSourceSha: identity.observed.resolvedSourceVersion,
        buildId: b.id,
        requiredMarkers: REQUIRED_MARKERS,
        markersSeen: REQUIRED_MARKERS.filter((m) => seen.has(m)),
        image: candidate,
      },
      null,
      2,
    )}\n`,
  );
  console.log(readFileSync(`${root}/build-readback.json`, 'utf8'));
}
const command = process.argv[2];
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (command === 'plan') plan();
  else if (command === 'preflight') preflight();
  else if (command === 'launch') launch();
  else if (command === 'reconcile') reconcile();
  else if (command === 'collect') collect();
  else throw new Error('Use plan, preflight, launch, reconcile or collect');
}
