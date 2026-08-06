#!/usr/bin/env bash
#
# engagement-api image publication.
#
# Builds, pushes, describes and scan-verifies the Phase 1 image. It never
# deploys anything: publishing an image and running it are separate
# authorization gates.
#
# Commands:
#   build         build a Linux ARM64 image tagged with the exact release SHA
#   push          build and push to ECR (requires PUSH confirmation token)
#   describe      resolve the immutable digest and scan metadata from ECR
#   verify-scan   fail if the scan is incomplete or has Critical findings
#   inspect       assert the local image is ARM64, nonroot, serve-only
#
# Required environment:
#   RELEASE_SHA                40-character git SHA; becomes the ONLY tag
#   CAPIRO_ENV                 dev | staging | prod
#   AWS_REGION
#   EXPECTED_AWS_ACCOUNT_ID
#
# Optional:
#   REPOSITORY_URI             defaults to <account>.dkr.ecr.<region>.amazonaws.com/capiro/<env>/engagement-api
#   DOCKER_BIN, AWS_BIN, NODE_BIN
#   HIGH_FINDING_BASELINE      reviewed ceiling for High findings (default 0)
#   CONFIRM_ENGAGEMENT_IMAGE_PUSH   must equal <account>:<region>:<release-sha>
#
# Exit: 0 ok · 1 usage/validation · 2 gate failure
set -euo pipefail
export MSYS_NO_PATHCONV=1

DOCKER_BIN="${DOCKER_BIN:-docker}"
AWS_BIN="${AWS_BIN:-aws}"
NODE_BIN="${NODE_BIN:-node}"
HIGH_FINDING_BASELINE="${HIGH_FINDING_BASELINE:-0}"
DOCKERFILE="apps/engagement-api/Dockerfile"

die() { printf 'ERROR %s\n' "$*" >&2; exit 1; }
gate() { printf 'FAIL  %s\n' "$*" >&2; exit 2; }

command="${1:-}"
[ -n "$command" ] || die "usage: engagement-api-image.sh <build|push|describe|verify-scan|inspect>"

for var in RELEASE_SHA CAPIRO_ENV AWS_REGION EXPECTED_AWS_ACCOUNT_ID; do
  [ -n "${!var:-}" ] || die "$var is required"
done

# The tag IS the release SHA. Nothing else is accepted, so `latest` can never
# be produced by this script even by mistake.
case "$RELEASE_SHA" in
  *[!0-9a-f]* | "") die "RELEASE_SHA must be 40 lowercase hex characters (got '$RELEASE_SHA')" ;;
esac
[ "${#RELEASE_SHA}" -eq 40 ] || die "RELEASE_SHA must be 40 characters (got ${#RELEASE_SHA})"

case "$CAPIRO_ENV" in
  dev | staging | prod) ;;
  *) die "CAPIRO_ENV must be dev, staging or prod" ;;
esac

REPOSITORY_NAME="capiro/${CAPIRO_ENV}/engagement-api"
REPOSITORY_URI="${REPOSITORY_URI:-${EXPECTED_AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPOSITORY_NAME}}"
IMAGE_REF="${REPOSITORY_URI}:${RELEASE_SHA}"
LOCAL_TAG="capiro-engagement-api:${RELEASE_SHA}"
OUT_DIR="${ENGAGEMENT_IMAGE_OUT_DIR:-.artifacts/engagement-phase2/${CAPIRO_ENV}}"
mkdir -p "$OUT_DIR"

# Reject a mutable tag anywhere in the resolved reference.
case "$IMAGE_REF" in
  *:latest | *:latest@* | *latest) gate "refusing a mutable 'latest' tag" ;;
esac

aws_ro() {
  local service="$1" operation="$2"
  shift 2
  case "$operation" in
    describe-* | list-* | get-*) ;;
    *) die "refusing non read-only AWS call: ${service} ${operation}" ;;
  esac
  "$AWS_BIN" "$service" "$operation" --region "$AWS_REGION" "$@"
}

# ── inspect: architecture, user, entrypoint, and no bundled UI ───────────────
inspect_image() {
  local ref="$1"
  local json
  json="$("$DOCKER_BIN" image inspect "$ref")" || gate "cannot inspect image $ref"
  printf '%s' "$json" > "${OUT_DIR}/image-inspect.json"

  "$NODE_BIN" - "${OUT_DIR}/image-inspect.json" <<'NODE'
const { readFileSync } = require('node:fs');
const [file] = process.argv.slice(2);
const parsed = JSON.parse(readFileSync(file, 'utf8'));
const image = Array.isArray(parsed) ? parsed[0] : parsed;
const failures = [];

const architecture = image.Architecture ?? image.architecture;
const os = image.Os ?? image.os;
if (architecture !== 'arm64') failures.push(`architecture is ${architecture}, expected arm64`);
if (os !== 'linux') failures.push(`os is ${os}, expected linux`);

const config = image.Config ?? image.config ?? {};
const user = config.User ?? '';
if (!user || user === 'root' || user === '0') failures.push(`image runs as "${user || 'root'}"`);

const cmd = config.Cmd ?? [];
if (JSON.stringify(cmd) !== JSON.stringify(['serve'])) {
  failures.push(`CMD is ${JSON.stringify(cmd)}, expected ["serve"]`);
}
const entrypoint = JSON.stringify(config.Entrypoint ?? []);
if (!entrypoint.includes('entrypoint.sh')) {
  failures.push(`entrypoint is ${entrypoint}, expected the serve-only entrypoint`);
}
if (/migrate|prisma/i.test(JSON.stringify(cmd))) failures.push('CMD references a migration');

// The image ships the shared backend runtime only. A bundled prototype or a
// copied UI would mean Phase 2 shipped V3 by accident.
const env = config.Env ?? [];
for (const entry of env) {
  if (/OUTREACH_V3_ENABLED|LANGGRAPH_|CAMPAIGN_SPEC_|^VITE_/.test(entry)) {
    failures.push(`image bakes a forbidden variable: ${entry.split('=')[0]}`);
  }
  if (/<!DOCTYPE html|__bundler\//i.test(entry)) failures.push('image bakes UI asset content');
}

for (const failure of failures) console.error(`FAIL  ${failure}`);
if (failures.length > 0) {
  console.error(`\nENGAGEMENT_IMAGE_INSPECT_FAILED (${failures.length})`);
  process.exit(2);
}
console.log(`arm64 linux, user ok, serve-only entrypoint, no bundled UI`);
NODE
}

# ── the image must refuse every verb except serve ────────────────────────────
assert_serve_only() {
  local ref="$1" verb status
  for verb in migrate migration-status seed sync-directory diag-anything; do
    status=0
    "$DOCKER_BIN" run --rm "$ref" "$verb" >/dev/null 2>&1 || status=$?
    [ "$status" -eq 64 ] || gate "image accepted '$verb' (exit ${status}); it must refuse with 64"
  done
  echo "  serve-only entrypoint refused migrate, seed, sync-* and diag-*"
}

case "$command" in
  build)
    echo "==> building ${LOCAL_TAG} (linux/arm64)"
    "$DOCKER_BIN" buildx build \
      --platform linux/arm64 \
      -f "$DOCKERFILE" \
      --tag "$LOCAL_TAG" \
      --load \
      . || gate "ARM64 build failed"
    inspect_image "$LOCAL_TAG"
    assert_serve_only "$LOCAL_TAG"
    echo "ENGAGEMENT_IMAGE_BUILD_COMPLETE"
    ;;

  push)
    [ "${CONFIRM_ENGAGEMENT_IMAGE_PUSH:-}" = "${EXPECTED_AWS_ACCOUNT_ID}:${AWS_REGION}:${RELEASE_SHA}" ] ||
      die "set CONFIRM_ENGAGEMENT_IMAGE_PUSH=${EXPECTED_AWS_ACCOUNT_ID}:${AWS_REGION}:${RELEASE_SHA} to push"

    account="$(aws_ro sts get-caller-identity --query Account --output text)"
    [ "$account" = "$EXPECTED_AWS_ACCOUNT_ID" ] ||
      gate "account ${account} does not match expected ${EXPECTED_AWS_ACCOUNT_ID}"

    # An immutable repository rejects a re-push of an existing tag, but failing
    # early gives a clear message instead of a registry error.
    if aws_ro ecr describe-images --repository-name "$REPOSITORY_NAME" \
      --image-ids "imageTag=${RELEASE_SHA}" >/dev/null 2>&1; then
      gate "tag ${RELEASE_SHA} already exists; the repository is immutable"
    fi

    echo "==> pushing ${IMAGE_REF}"
    "$AWS_BIN" ecr get-login-password --region "$AWS_REGION" |
      "$DOCKER_BIN" login --username AWS --password-stdin "${REPOSITORY_URI%%/*}" ||
      gate "ECR login failed"
    # --provenance=false --sbom=false: without them, buildx pushes an OCI
    # image INDEX (the real manifest plus a build-provenance attestation
    # manifest) under the tag. ECR basic scanning cannot scan an index
    # (UnsupportedImageTypeException) and scans the child manifest instead,
    # so `describe`/`verify-scan` below — which look up the tag directly —
    # would see no scan status forever. Found via a real push (2.16).
    "$DOCKER_BIN" buildx build \
      --platform linux/arm64 \
      --provenance=false \
      --sbom=false \
      -f "$DOCKERFILE" \
      --tag "$IMAGE_REF" \
      --push \
      . || gate "push failed"
    echo "ENGAGEMENT_IMAGE_PUSH_COMPLETE"
    ;;

  describe)
    aws_ro ecr describe-images \
      --repository-name "$REPOSITORY_NAME" \
      --image-ids "imageTag=${RELEASE_SHA}" \
      --output json > "${OUT_DIR}/image-describe.json" || gate "cannot describe ${RELEASE_SHA}"

    "$NODE_BIN" - "${OUT_DIR}/image-describe.json" "$RELEASE_SHA" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [file, releaseSha] = process.argv.slice(2);
const details = JSON.parse(readFileSync(file, 'utf8')).imageDetails ?? [];
if (details.length !== 1) {
  console.error(`FAIL  expected exactly one image for ${releaseSha}, found ${details.length}`);
  process.exit(2);
}
const [image] = details;
const digest = image.imageDigest ?? '';
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
  console.error(`FAIL  digest is not sha256 plus 64 hex: ${digest}`);
  process.exit(2);
}
const tags = image.imageTags ?? [];
if (!tags.includes(releaseSha)) {
  console.error(`FAIL  image is not tagged ${releaseSha} (tags: ${tags.join(', ')})`);
  process.exit(2);
}
if (tags.includes('latest')) {
  console.error('FAIL  image carries a mutable latest tag');
  process.exit(2);
}
console.log(`imageDigest       ${digest}`);
console.log(`imagePushedAt     ${image.imagePushedAt ?? 'unknown'}`);
console.log(`manifestMediaType ${image.imageManifestMediaType ?? 'unknown'}`);
console.log(`scanStatus        ${image.imageScanStatus?.status ?? 'none'}`);
writeFileSync(file.replace('image-describe.json', 'image-digest.txt'), `${digest}\n`);
NODE
    echo "ENGAGEMENT_IMAGE_DESCRIBE_COMPLETE"
    ;;

  verify-scan)
    aws_ro ecr describe-image-scan-findings \
      --repository-name "$REPOSITORY_NAME" \
      --image-id "imageTag=${RELEASE_SHA}" \
      --output json > "${OUT_DIR}/image-scan.json" 2>/dev/null ||
      gate "scan findings are not available for ${RELEASE_SHA}"

    HIGH_FINDING_BASELINE="$HIGH_FINDING_BASELINE" "$NODE_BIN" - "${OUT_DIR}/image-scan.json" <<'NODE'
const { readFileSync } = require('node:fs');
const [file] = process.argv.slice(2);
const parsed = JSON.parse(readFileSync(file, 'utf8'));
const status = parsed.imageScanStatus?.status ?? 'UNKNOWN';
const counts =
  parsed.imageScanFindings?.findingSeverityCounts ??
  parsed.imageScanFindings?.enhancedFindingSeverityCounts ??
  {};
const failures = [];

// An incomplete scan is not a pass. "We do not know yet" must never read as
// "clean" at a deployment gate.
if (status !== 'COMPLETE') failures.push(`scan status is ${status}, expected COMPLETE`);

const critical = Number(counts.CRITICAL ?? 0);
const high = Number(counts.HIGH ?? 0);
const baseline = Number(process.env.HIGH_FINDING_BASELINE ?? 0);
if (critical > 0) failures.push(`${critical} Critical finding(s); publication is blocked`);
if (high > baseline) failures.push(`${high} High finding(s) exceeds the reviewed baseline ${baseline}`);

console.log(`scan status ${status}`);
console.log(`severity counts ${JSON.stringify(counts)}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);
if (failures.length > 0) {
  console.error(`\nENGAGEMENT_IMAGE_SCAN_FAILED (${failures.length})`);
  process.exit(2);
}
console.log('ENGAGEMENT_IMAGE_SCAN_CLEAN');
NODE
    ;;

  inspect)
    inspect_image "${IMAGE_REF_OVERRIDE:-$LOCAL_TAG}"
    ;;

  *)
    die "unknown command '$command'; expected build, push, describe, verify-scan or inspect"
    ;;
esac
