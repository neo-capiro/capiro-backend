/**
 * @cleanup-smoke noArgsExit=2 helpExit=0
 *
 * Bounded build-request generator for the two legacy maintenance images. This is
 * a *request* tool: it never starts a build, never creates a project, never
 * changes IAM and never deploys. `--stage` only uploads the caller's exact source
 * archive to the existing versioned source bucket; `plan` writes the reviewable
 * request without touching AWS.
 *
 * It uses the existing ARM builder `capiro-build-web-dev` with a per-build S3
 * source override (sourceTypeOverride/sourceLocationOverride/sourceVersion) and
 * an inline buildspec — the same method already used by the accepted frontend
 * build `capiro-portfolio-preview-build` (S3 object + VersionId pin +
 * EXPECTED_SHA/EXPECTED_S3_VERSION). No stored project field is modified.
 *
 * web:  pulls the qualified frontend image digest, extracts its /app tree, runs
 *       the unchanged Linux/Node24 gates in the pinned Node24.21 musl image,
 *       assembles release-artifacts/capiro-frontend with the existing owner,
 *       builds+smokes the 8080 consumer recipe, then pushes an exact-SHA tag.
 * marketing: builds+smokes marketing/Dockerfile and pushes an exact-SHA tag.
 *
 * Usage:
 *   node scripts/legacy-consumer-build-request.mjs --service web --source-checkout ABS \
 *     --source-commit 40HEX --out-dir ABS [--stage]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { NEWSLETTER_ACCEPTED_SOURCE_PROFILE } from './lib/frontend-standalone-artifact-contract.mjs';

export const ACCOUNT = '967807252336';
export const REGION = 'us-east-1';
export const PROJECT = 'capiro-build-web-dev';
export const SOURCE_BUCKET = 'capiro-portfolio-preview-source-967807252336-us-east-1';
export const SOURCE_PREFIX = 'inputs/';
export const NODE_IMAGE = 'public.ecr.aws/docker/library/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
export const FRONTEND_IMAGE_DIGEST = 'sha256:983eb6d99feb25e664a0a2f14244d60e906f12f88a3a262b27519ffbed53f930';
export const FRONTEND_SOURCE_COMMIT = 'ee470d7d44b811dc84d147c62a3eab7c9b5be09f';
export const CONSUMER_REPOSITORIES = Object.freeze({ web: 'capiro/dev/web', marketing: 'capiro/dev/marketing' });
export const USAGE = 'Usage: node scripts/legacy-consumer-build-request.mjs --service web|marketing --source-checkout ABS --source-commit 40HEX --out-dir ABS [--stage]';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (reason) => { throw new Error('Legacy consumer build request refused: ' + reason); };
const flags = Object.freeze(['--service', '--source-checkout', '--source-commit', '--out-dir']);

export function parseInvocation(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return Object.freeze({ mode: 'help' });
  const stage = argv.includes('--stage');
  const args = argv.filter((value) => value !== '--stage');
  if (args.length !== flags.length * 2) fail('exactly four explicit flags plus optional --stage required');
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!flags.includes(args[index]) || values.has(args[index]) || !args[index + 1]) fail('unknown or duplicate flag');
    values.set(args[index], args[index + 1]);
  }
  const options = Object.freeze({
    service: values.get('--service'),
    sourceCheckout: values.get('--source-checkout'),
    sourceCommit: values.get('--source-commit'),
    outDir: values.get('--out-dir'),
  });
  if (!Object.hasOwn(CONSUMER_REPOSITORIES, options.service)) fail('service must be web or marketing');
  if (!/^[a-f0-9]{40}$/.test(options.sourceCommit)) fail('40-hex source commit required');
  for (const value of [options.sourceCheckout, options.outDir])
    if (!value || !path.isAbsolute(value)) fail('absolute source-checkout and out-dir required');
  return Object.freeze({ mode: stage ? 'stage' : 'plan', options });
}

/** Deterministic content digest of an exact commit, reproduced by the job. */
export function treeDigest(sourceCheckout, sourceCommit) {
  const listing = execFileSync('git', ['-C', sourceCheckout, 'ls-tree', '-r', '-z', sourceCommit],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
  const rows = [];
  for (const line of listing) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) fail('unparsable tree entry');
    const [, mode, type, object, name] = match;
    if (type !== 'blob') fail('non-blob tree entry refused: ' + name);
    if (mode === '120000') {
      const target = execFileSync('git', ['-C', sourceCheckout, 'cat-file', 'blob', object], { encoding: 'utf8' });
      rows.push(`L ${name} ${target}`);
    } else rows.push(`F ${name} ${object}`);
  }
  rows.sort();
  return sha(Buffer.from(rows.join('\n') + '\n'));
}

const BUILDSPEC_DIGEST_STEP = `python3 - <<'PY'
import hashlib, os, sys
root = '.'
rows = []
for base, dirs, files in os.walk(root):
    dirs[:] = sorted(d for d in dirs if d != '.git')
    for name in files:
        if name == '.git':
            continue
        full = os.path.join(base, name)
        rel = os.path.relpath(full, root)
        if rel == '.git':
            continue
        if os.path.islink(full):
            rows.append("L %s %s" % (rel, os.readlink(full)))
        else:
            with open(full, 'rb') as handle:
                rows.append("F %s %s" % (rel, hashlib.sha256(handle.read(64 * 1024 * 1024)).hexdigest()))
rows.sort()
digest = hashlib.sha256(('\\n'.join(rows) + '\\n').encode()).hexdigest()
expected = os.environ['EXPECTED_TREE_SHA256']
if digest != expected:
    print('SOURCE_TREE_DIGEST_MISMATCH', digest, expected)
    sys.exit(1)
print('SOURCE_TREE_DIGEST_PASS', digest)
PY`;

const PRELUDE = `set -euo pipefail
: "\${EXPECTED_SHA:?exact source commit required}"
: "\${EXPECTED_TREE_SHA256:?exact source tree digest required}"
: "\${EXPECTED_S3_VERSION:?immutable S3 source version required}"
test "\${CODEBUILD_SOURCE_VERSION:-}" = "$EXPECTED_S3_VERSION"
test "$(uname -m)" = aarch64
test "$(aws sts get-caller-identity --query Account --output text)" = ${ACCOUNT}
case "$(docker info --format '{{.Architecture}}')" in aarch64|arm64) ;; *) echo 'container engine is not arm64' >&2; exit 1 ;; esac
${BUILDSPEC_DIGEST_STEP}
aws ecr get-login-password --region ${REGION} \\
  | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com
`;

const SCAN_ASSERT = `assert_clean_scan() {
  repository="$1"
  slug="$(printf '%s' "$repository" | tr '/' '-')"
  digest="$(aws ecr describe-images --region ${REGION} --repository-name "$repository" \\
    --image-ids "imageTag=$EXPECTED_SHA" --query 'imageDetails[0].imageDigest' --output text)"
  case "$digest" in sha256:*) ;; *) echo "no immutable digest for the exact-SHA tag in $repository" >&2; exit 1 ;; esac
  status=PENDING
  for _ in $(seq 1 30); do
    status="$(aws ecr describe-image-scan-findings --region ${REGION} --repository-name "$repository" \\
      --image-id "imageDigest=$digest" --query 'imageScanStatus.status' --output text 2>/dev/null || echo PENDING)"
    [ "$status" = COMPLETE ] && break
    sleep 10
  done
  test "$status" = COMPLETE
  aws ecr describe-image-scan-findings --region ${REGION} --repository-name "$repository" \\
    --image-id "imageDigest=$digest" --output json > "evidence-scan-$slug.json"
  aws ecr describe-images --region ${REGION} --repository-name "$repository" \\
    --image-ids "imageDigest=$digest" --output json > "evidence-image-$slug.json"
  python3 - "$slug" <<'PY'
import json, sys
slug = sys.argv[1]
findings = json.load(open('evidence-scan-%s.json' % slug))['imageScanFindings']['findingSeverityCounts']
blocking = int(findings.get('HIGH', 0)) + int(findings.get('CRITICAL', 0))
print('SCAN_SEVERITY', slug, json.dumps(findings, sort_keys=True))
if blocking:
    raise SystemExit('blocking findings present in %s: %d' % (slug, blocking))
print('SCAN_CLEAN_PASS', slug)
PY
  echo "EXACT_IMAGE_DIGEST=$repository@$digest"
}
`;

const WEB_BUILDSPEC = `set -euo pipefail
FE_IMAGE=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/portfolio-preview@${FRONTEND_IMAGE_DIGEST}
NODE_IMAGE=${NODE_IMAGE}
CONSUMER_IMAGE=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONSUMER_REPOSITORIES.web}:$EXPECTED_SHA
${PRELUDE}
${SCAN_ASSERT}
docker pull "$FE_IMAGE"
test "$(docker image inspect "$FE_IMAGE" --format '{{.Os}}/{{.Architecture}}')" = linux/arm64
test "$(docker image inspect "$FE_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = ${FRONTEND_SOURCE_COMMIT}
test "$(docker run --rm --network none --entrypoint /usr/local/bin/node "$FE_IMAGE" -v)" = v24.21.0
docker run --rm --network none --entrypoint sh "$FE_IMAGE" -ec 'grep -q "^3.23" /etc/alpine-release'
docker pull "$NODE_IMAGE"
test "$(docker image inspect "$NODE_IMAGE" --format '{{.Os}}/{{.Architecture}}')" = linux/arm64
# Extract the qualified producer's /app root (the accepted standalone bytes).
container="$(docker create "$FE_IMAGE")"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
mkdir -p work/app
docker cp "$container:/app/." work/app
docker rm -f "$container" >/dev/null
# Unchanged Linux/Node24 gates run in the pinned musl Node24.21 image.
docker run --rm -v "$PWD:/src" -w /src "$NODE_IMAGE" node --test \\
  scripts/ci/legacy-web-release.spec.mjs \\
  scripts/ci/newsletter-accepted-source-profile.spec.mjs \\
  scripts/ci/frontend-standalone-artifact.contract.spec.mjs
docker run --rm -v "$PWD:/src" -v "$PWD/work:/work" -w /src "$NODE_IMAGE" \\
  node scripts/legacy-web-release.mjs artifact \\
  --extracted-app-dir /work/app \\
  --frontend-commit ${FRONTEND_SOURCE_COMMIT} \\
  --image-digest ${FRONTEND_IMAGE_DIGEST} \\
  --manifest /work/artifact.manifest.json \\
  --output-dir /src/release-artifacts/capiro-frontend \\
  --backend-commit "$EXPECTED_SHA" \\
  --arch arm64 | tee work/assembly.json
MANIFEST_SHA256="$(sha256sum release-artifacts/capiro-frontend/manifest.json | cut -d' ' -f1)"
test -s release-artifacts/capiro-frontend/build-receipt.json
docker build --platform linux/arm64 -f apps/web/Dockerfile \\
  --build-arg FRONTEND_ARTIFACT_MANIFEST_SHA256="$MANIFEST_SHA256" \\
  --build-arg FRONTEND_ARTIFACT_SOURCE_REPOSITORY=neo-capiro/capiro-frontend \\
  --build-arg FRONTEND_ARTIFACT_SOURCE_COMMIT=${FRONTEND_SOURCE_COMMIT} \\
  --build-arg TARGETPLATFORM=linux/arm64 \\
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \\
  --label "org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend" \\
  -t "$CONSUMER_IMAGE" .
test "$(docker image inspect "$CONSUMER_IMAGE" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$CONSUMER_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
bash apps/web/smoke-8080.sh "$CONSUMER_IMAGE"
# The same admitted image serves both legacy consumers; publish the exact commit
# tag to both repositories and require a clean exact-digest scan for each.
for repository in ${CONSUMER_REPOSITORIES.web} capiro/dev/web-vnext; do
  target=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/$repository:$EXPECTED_SHA
  if [ "$target" != "$CONSUMER_IMAGE" ]; then
    docker tag "$CONSUMER_IMAGE" "$target"
  fi
  docker push "$target"
done
assert_clean_scan ${CONSUMER_REPOSITORIES.web}
assert_clean_scan capiro/dev/web-vnext`;

const MARKETING_BUILDSPEC = `set -euo pipefail
IMAGE=${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${CONSUMER_REPOSITORIES.marketing}:$EXPECTED_SHA
${PRELUDE}
${SCAN_ASSERT}
docker build --platform linux/arm64 -f marketing/Dockerfile \\
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \\
  --label "org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend" \\
  -t "$IMAGE" .
test "$(docker image inspect "$IMAGE" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
bash marketing/smoke-8080.sh "$IMAGE"
docker push "$IMAGE"
assert_clean_scan ${CONSUMER_REPOSITORIES.marketing}`;

export function buildspecFor(service) {
  const script = service === 'web' ? WEB_BUILDSPEC : MARKETING_BUILDSPEC;
  const encoded = gzipSync(Buffer.from(script, 'utf8')).toString('base64');
  return {
    version: 0.2,
    env: { shell: 'bash' },
    phases: {
      build: {
        'on-failure': 'ABORT',
        commands: [`set -euo pipefail\nprintf '%s' '${encoded}' | base64 -d | gzip -dc | bash`],
      },
    },
  };
}

/** Source admission: the consumer's declared frontend source must be active. */
export function assertSourceSelection(service) {
  if (service !== 'web') return null;
  const active = NEWSLETTER_ACCEPTED_SOURCE_PROFILE.activeCommit;
  if (active !== FRONTEND_SOURCE_COMMIT) fail('generator pin does not match the reviewed active artifact source');
  return active;
}

export function createPlan(options) {
  if (!options || typeof options !== 'object') fail('explicit options required');
  const checkoutHead = execFileSync('git', ['-C', options.sourceCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (checkoutHead !== options.sourceCommit) fail('source checkout is not at the declared commit');
  if (execFileSync('git', ['-C', options.sourceCheckout, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' }).trim() !== '') fail('source checkout has tracked modifications');
  assertSourceSelection(options.service);
  const buildspec = buildspecFor(options.service);
  const buildspecOverride = JSON.stringify(buildspec);
  if (buildspecOverride.length > 25_600) fail(`BUILDSPEC_TOO_LONG_${buildspecOverride.length}`);
  const treeDigestValue = treeDigest(options.sourceCheckout, options.sourceCommit);
  const key = `${SOURCE_PREFIX}${options.service}-${options.sourceCommit}.zip`;
  return Object.freeze({
    schemaVersion: 1, kind: 'legacy-consumer-build-request', generatedAt: new Date().toISOString(),
    service: options.service, project: PROJECT, region: REGION, account: ACCOUNT,
    source: Object.freeze({ type: 'S3', bucket: SOURCE_BUCKET, key, prefix: SOURCE_PREFIX,
      sourceCommit: options.sourceCommit, treeDigestSha256: treeDigestValue,
      // Filled from put-object; the request refuses to run without it.
      sourceVersion: null }),
    frontend: options.service === 'web' ? Object.freeze({ imageDigest: FRONTEND_IMAGE_DIGEST,
      sourceCommit: FRONTEND_SOURCE_COMMIT,
      activeAcceptedSource: NEWSLETTER_ACCEPTED_SOURCE_PROFILE.activeCommit }) : null,
    consumerRepository: CONSUMER_REPOSITORIES[options.service],
    imageTagPolicy: 'exact-40-hex source commit only; no latest, no mutable-tag scan',
    buildspecSha256: sha(buildspecOverride), buildspecCharacters: buildspecOverride.length,
    environmentVariables: [
      { name: 'EXPECTED_SHA', value: options.sourceCommit, type: 'PLAINTEXT' },
      { name: 'EXPECTED_TREE_SHA256', value: treeDigestValue, type: 'PLAINTEXT' },
      { name: 'EXPECTED_S3_VERSION', value: '<S3_VERSION_ID>', type: 'PLAINTEXT' },
    ],
    stages: Object.freeze([
      'verify caller/account/arm64 and the exact source tree digest',
      'web: pull the qualified frontend digest, assert arch/label/node/libc, extract /app',
      'run the unchanged Linux/Node24 gate specs in the pinned Node24.21 musl image',
      'web: assemble release-artifacts/capiro-frontend through the existing owner',
      'build+smoke the consumer image, push the exact-SHA tag, assert a clean exact-digest scan',
    ]),
    startBuildPerformed: false, projectMutated: false, iamChanged: false, deployed: false,
  });
}

export function startBuildRequest(plan, sourceVersion, idempotencyToken) {
  if (!/^[A-Za-z0-9+/=_.:-]{8,120}$/.test(sourceVersion ?? '')) fail('immutable S3 version id required');
  return {
    projectName: plan.project,
    sourceTypeOverride: 'S3',
    sourceLocationOverride: `${plan.source.bucket}/${plan.source.key}`,
    sourceVersion,
    buildspecOverride: JSON.stringify(buildspecFor(plan.service)),
    environmentVariablesOverride: plan.environmentVariables.map((item) =>
      item.name === 'EXPECTED_S3_VERSION' ? { ...item, value: sourceVersion } : item),
    idempotencyToken,
    timeoutInMinutesOverride: 60,
  };
}

function stage(options, outDir) {
  const archive = path.join(outDir, `${options.service}-${options.sourceCommit}.zip`);
  execFileSync('git', ['-C', options.sourceCheckout, 'archive', '--format=zip', '-o', archive, options.sourceCommit],
    { stdio: 'inherit' });
  const uploaded = JSON.parse(execFileSync('aws', ['s3api', 'put-object', '--bucket', SOURCE_BUCKET,
    '--key', `${SOURCE_PREFIX}${options.service}-${options.sourceCommit}.zip`, '--body', archive,
    '--checksum-algorithm', 'SHA256', '--output', 'json'], { encoding: 'utf8' }));
  if (!uploaded.VersionId) fail('bucket did not return an immutable version id');
  return uploaded;
}

function main(argv) {
  try {
    const invocation = parseInvocation(argv);
    if (invocation.mode === 'help') { console.log(USAGE); return; }
    mkdirSync(invocation.options.outDir, { recursive: true });
    const plan = createPlan(invocation.options);
    let uploaded = null;
    if (invocation.mode === 'stage') uploaded = stage(invocation.options, invocation.options.outDir);
    const sourceVersion = uploaded?.VersionId ?? null;
    const request = sourceVersion ? startBuildRequest(plan, sourceVersion,
      `legacy-${plan.service}-${plan.source.sourceCommit.slice(0, 12)}`) : null;
    writeFileSync(path.join(invocation.options.outDir, 'build-request-plan.json'),
      `${JSON.stringify({ ...plan, staged: uploaded ? { versionId: uploaded.VersionId,
        checksumSha256: uploaded.ChecksumSHA256 ?? null, etag: uploaded.ETag ?? null } : null }, null, 2)}\n`);
    if (request) writeFileSync(path.join(invocation.options.outDir, 'start-build.request.json'),
      `${JSON.stringify(request, null, 2)}\n`);
    console.log(JSON.stringify({ mode: invocation.mode, service: plan.service, project: plan.project,
      buildspecSha256: plan.buildspecSha256, buildspecCharacters: plan.buildspecCharacters,
      treeDigestSha256: plan.source.treeDigestSha256, sourceKey: plan.source.key,
      sourceVersion, outDir: invocation.options.outDir,
      startBuildPerformed: false, deployed: false }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', startBuildPerformed: false, deployed: false,
      usage: USAGE, error: String(error.message).slice(0, 300) }));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
