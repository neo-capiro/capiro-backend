#!/usr/bin/env bash
#
# Portable pinned-Linux capture/compare/regression RUNNER (host orchestration)
# — round-13.
#
#   run-linux-capture.sh capture <archiveDir> <outDir>
#   run-linux-capture.sh compare <archiveDir> <goldenBaselinesDir> <outDir>
#   run-linux-capture.sh regression <archiveDir> <goldenBaselinesDir> <outDir>
#
# `compare` is the strict same-source repeat proof (repeat-zero-diff.mjs).
# `regression` is the NORMAL CI/regression comparison: the CURRENT source is
# rendered against an IMMUTABLE baseline captured on a HISTORICAL source commit
# and the REAL complete Playwright comparison suite (+ separate onboarding smoke)
# runs READ-ONLY. It reuses the SAME validated archive, trusted byte-bound
# bootstrap, exact-id/label lifecycle, owned volume/setup and network-none
# rendering as `capture`/`compare`; it never captures/updates/promotes goldens.
#
# Bootstrap (round-13 fix): the in-container scripts are the TRUSTED harness and
# are mounted READ-ONLY from a fixed path (/bootstrap = this script's own
# directory). They are NOT read from the archive or from the (empty) /work
# volume — the previous version tried to `bash /work/apps/e2e/linux/container-
# setup.sh` before any extraction, which cannot exist. The archive is validated
# (entry type/containment/checksum) on the host BEFORE any extraction.
#
# Dependencies: ONE bounded setup installs onto an owned NAMED VOLUME mounted at
# /work (which MUST be empty at first use); the network-none capture/compare
# reuses that volume. No Windows-bind install.
#
# Lifecycle: containers are created with `docker create --cidfile` (id captured)
# and started under `timeout`; the id is tracked BEFORE start so a timed-out or
# failed run still has a proven-stoppable container. Removal is by exact id with
# a label check; name collisions are refused; cidfiles/diagnostics are RETAINED.
set -euo pipefail

MODE="${1:?usage: capture <archiveDir> <outDir> | compare <archiveDir> <goldenDir> <outDir>}"

IMAGE="${CAPIRO_VISUAL_IMAGE:-mcr.microsoft.com/playwright@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7}"
IMAGE_DIGEST="${CAPIRO_VISUAL_IMAGE_DIGEST:-sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7}"
EXTERNAL_DIR="${CAPIRO_PW_EXTERNAL:-/c/dev/.cleanup-playwright-runtime-20261007}"
PNPM_VERSION="${CAPIRO_PNPM_VERSION:-9.12.0}"
STAMP="$(date +%s)-$$"
RUN_ID="cleanup1-visual-${STAMP}"
VOLUME_NAME="cleanup1-visual-deps-${STAMP}"
MEMORY="${CAPIRO_VISUAL_MEMORY:-6g}"
CPUS="${CAPIRO_VISUAL_CPUS:-4}"
STEP_TIMEOUT="${CAPIRO_STEP_TIMEOUT:-2400}"
CREATE_TIMEOUT="${CAPIRO_CREATE_TIMEOUT:-120}"
INSPECT_TIMEOUT="${CAPIRO_INSPECT_TIMEOUT:-20}"
STOP_TIMEOUT="${CAPIRO_STOP_TIMEOUT:-60}"
RM_TIMEOUT="${CAPIRO_RM_TIMEOUT:-30}"
BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[run-linux-capture:%s] %s\n' "$MODE" "$*"; }
die() { printf '[run-linux-capture] FATAL: %s\n' "$*" >&2; exit 2; }

command -v docker >/dev/null 2>&1 || die "docker is required"
command -v timeout >/dev/null 2>&1 || die "timeout(1) is required (GNU coreutils)"
[[ "$STEP_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || die "CAPIRO_STEP_TIMEOUT must be a positive integer, got '$STEP_TIMEOUT'"
[[ "$CPUS" =~ ^[0-9]+$ ]] || die "CAPIRO_VISUAL_CPUS must be an integer, got '$CPUS'"
[[ "$MEMORY" =~ ^[0-9]+[mg]$ ]] || die "CAPIRO_VISUAL_MEMORY must look like 6g/512m, got '$MEMORY'"
[[ -f "$BOOTSTRAP_DIR/container-setup.sh" ]] || die "bootstrap scripts missing next to the runner: $BOOTSTRAP_DIR"
timeout "$INSPECT_TIMEOUT" docker image inspect "$IMAGE" >/dev/null 2>&1 || die "pinned image not present locally (pull it once): $IMAGE"

TARBALL_NAME=""
# Real archive validation (round-14): delegates to linux/validate-archive.mjs,
# which parses the tar HEADERS and rejects absolute/.. /drive/link/device entries,
# binds the manifest to the receipt (head/tree/fingerprint/fileCount), and
# BYTE-BINDS the /bootstrap harness to the measured source archive. Runs on the
# host BEFORE create_volume / extraction.
validate_archive() {
  local dir="$1"
  [[ -d "$dir" ]] || die "archive dir missing: $dir"
  command -v node >/dev/null 2>&1 || die "node is required to validate the archive"
  local out
  if ! out="$(node "$BOOTSTRAP_DIR/validate-archive.mjs" "$dir" "$BOOTSTRAP_DIR" 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "archive validation failed (entry/containment/checksum/bootstrap byte-binding)"
  fi
  printf '%s\n' "$out"
  TARBALL_NAME="$(printf '%s\n' "$out" | sed -n 's/^TARBALL_NAME=//p' | tail -1)"
  [[ -n "$TARBALL_NAME" ]] || die "archive validation did not report a tarball name"
}

for t in "$CREATE_TIMEOUT" "$INSPECT_TIMEOUT" "$STOP_TIMEOUT" "$RM_TIMEOUT"; do
  [[ "$t" =~ ^[1-9][0-9]*$ ]] || die "docker timeout env must be a positive integer, got '$t'"
done
# Shared lifecycle classification + cleanup (also exercised by tests/lifecycle-controls.sh).
# shellcheck source=lifecycle.sh
source "$BOOTSTRAP_DIR/lifecycle.sh"

run_container() { # <name> <phase> <cidfile> <docker-create-args...>
  local name="$1" phase="$2" cidfile="$3"; shift 3
  [[ -n "$cidfile" ]] || die "cidfile missing for $name"
  if timeout "$INSPECT_TIMEOUT" docker container inspect "$name" >/dev/null 2>&1; then die "container name collision: $name"; fi
  rm -f "$cidfile"
  local crc=0
  timeout "$CREATE_TIMEOUT" docker create --cidfile "$cidfile" --name "$name" \
    --label "cleanup1.visual.run=$RUN_ID" --label "cleanup1.visual.phase=$phase" "$@" >/dev/null 2>&1 || crc=$?
  # ALWAYS capture + register the cidfile receipt BEFORE any die/start.
  if ! register_created "$cidfile" "$phase"; then
    if [[ $crc -ne 0 ]]; then log "docker create failed/timed out (rc=$crc) with no cid receipt for '$phase'"; return "$crc"; fi
    die "docker create reported success but produced no cid receipt for '$phase'"
  fi
  local cid="$CREATED_CID"
  # Prove the exact Id and the task label before anything else.
  local gotid; gotid="$(timeout "$INSPECT_TIMEOUT" docker inspect -f '{{.Id}}' "$cid" 2>&1 || true)"
  [[ "$gotid" == "$cid" ]] || die "created container id mismatch: got '$gotid' want '$cid'"
  local gotlab; gotlab="$(timeout "$INSPECT_TIMEOUT" docker inspect -f '{{ index .Config.Labels "cleanup1.visual.run" }}' "$cid" 2>&1 || true)"
  [[ "$gotlab" == "$RUN_ID" ]] || die "created container $cid not task-owned (label='$gotlab')"
  if [[ $crc -ne 0 ]]; then log "docker create returned $crc for '$phase'; container $cid is registered for cleanup"; return "$crc"; fi
  local st=0
  timeout "$STEP_TIMEOUT" docker start -a "$cid" || st=$?
  if [[ $st -ne 0 ]]; then log "phase '$phase' exited $st (container $cid)"; return "$st"; fi
  return 0
}

cleanup() {
  local rc=$?
  cleanup_containers
  if [[ "$CLEANUP_UNCERTAIN" -ne 0 ]]; then
    printf '{"cleanupUncertain":true,"runId":"%s","containers":[%s],"note":"state not provably removed for at least one id"}\n' \
      "$RUN_ID" "$(printf '"%s",' "${created_ids[@]:-}" | sed 's/,$//')" > "${DIAG:-/tmp}/cleanup-uncertain.json" 2>/dev/null || true
    log "WARNING: cleanup uncertain — diagnostics retained in ${DIAG:-/tmp}"
  fi
  # Diagnostics/cidfiles/out are RETAINED (never recursively deleted).
  if [[ "$CLEANUP_UNCERTAIN" -ne 0 && "$rc" -eq 0 ]]; then exit 3; fi
  exit "$rc"
}
trap cleanup EXIT

# Fresh owned volume: create only if absent; the setup container REQUIRES it empty.
create_volume() {
  if timeout "$INSPECT_TIMEOUT" docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then die "volume collision: $VOLUME_NAME"; fi
  log "creating owned dependency volume $VOLUME_NAME"
  timeout "$CREATE_TIMEOUT" docker volume create --label "cleanup1.visual.volume=$VOLUME_NAME" "$VOLUME_NAME" >/dev/null || die "volume create failed/timed out"
}

# COMMON_ENV depends on TARBALL_NAME, which validate_archive sets. Building it at
# top level captured an EMPTY CAPIRO_ARCHIVE_TAR; build it AFTER validation.
COMMON_ENV=()
build_common_env() {
  COMMON_ENV=(
    -e "CAPIRO_ARCHIVE_TAR=$TARBALL_NAME"
    -e "CAPIRO_PNPM_VERSION=$PNPM_VERSION"
    -e TZ=UTC -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8
  )
}
BOOTSTRAP_MOUNT=(--mount "type=bind,source=${BOOTSTRAP_DIR},target=/bootstrap,readonly")

case "$MODE" in
capture)
  ARCHIVE_DIR="${2:?capture needs <archiveDir>}"; OUT_DIR="${3:?capture needs <outDir>}"
  [[ -d "$ARCHIVE_DIR" ]] || die "archive dir missing: $ARCHIVE_DIR"
  mkdir -p "$OUT_DIR"; ARCHIVE_DIR="$(cd "$ARCHIVE_DIR" && pwd)"; OUT_DIR="$(cd "$OUT_DIR" && pwd)"
  DIAG="${OUT_DIR}/.run-${RUN_ID}"; mkdir -p "$DIAG"
  validate_archive "$ARCHIVE_DIR"; build_common_env; create_volume

  log "setup: extract + pnpm@$PNPM_VERSION install onto empty /work (network=bridge)"
  run_container "${RUN_ID}-setup" setup "$DIAG/setup.cid" \
    --network bridge --memory "$MEMORY" --cpus "$CPUS" \
    --mount "type=bind,source=${ARCHIVE_DIR},target=/arch,readonly" \
    --mount "type=volume,source=${VOLUME_NAME},target=/work" \
    "${BOOTSTRAP_MOUNT[@]}" \
    -w / "${COMMON_ENV[@]}" \
    "$IMAGE" bash -lc 'bash /bootstrap/container-setup.sh' || die "setup failed"

  log "capture: provenance + capture + atomic publish + guard + 3 repeats (network=none)"
  crc=0
  run_container "${RUN_ID}-capture" capture "$DIAG/capture.cid" \
    --network none --memory "$MEMORY" --cpus "$CPUS" \
    --mount "type=bind,source=${ARCHIVE_DIR},target=/arch,readonly" \
    --mount "type=bind,source=${EXTERNAL_DIR},target=/external,readonly" \
    --mount "type=volume,source=${VOLUME_NAME},target=/work" \
    --mount "type=bind,source=${OUT_DIR},target=/out" \
    "${BOOTSTRAP_MOUNT[@]}" \
    -w /work/apps/e2e \
    -e PLAYWRIGHT_CLI=/external/node_modules/@playwright/test/cli.js \
    -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    -e "CAPIRO_VISUAL_IMAGE=$IMAGE" -e "CAPIRO_VISUAL_IMAGE_DIGEST=$IMAGE_DIGEST" \
    -e "CAPIRO_PNPM_VERSION=$PNPM_VERSION" \
    -e CAPIRO_BASELINE_ROOT=/work/apps/e2e/baselines \
    -e CAPIRO_SOURCE_PROVENANCE=/arch/source-manifest.json \
    -e XDG_CACHE_HOME=/tmp/cache "${COMMON_ENV[@]}" \
    "$IMAGE" bash -lc 'bash /bootstrap/container-capture.sh' || crc=$?

  log "capture artifacts: $OUT_DIR (container exit $crc; diagnostics retained in $DIAG)"
  exit "$crc"
  ;;
compare)
  ARCHIVE_DIR="${2:?compare needs <archiveDir>}"; GOLDEN_DIR="${3:?compare needs <goldenDir>}"; OUT_DIR="${4:?compare needs <outDir>}"
  [[ -d "$ARCHIVE_DIR" ]] || die "archive dir missing: $ARCHIVE_DIR"
  [[ -d "$GOLDEN_DIR" ]] || die "golden dir missing: $GOLDEN_DIR"
  mkdir -p "$OUT_DIR"; ARCHIVE_DIR="$(cd "$ARCHIVE_DIR" && pwd)"; GOLDEN_DIR="$(cd "$GOLDEN_DIR" && pwd)"; OUT_DIR="$(cd "$OUT_DIR" && pwd)"
  DIAG="${OUT_DIR}/.run-${RUN_ID}"; mkdir -p "$DIAG"
  validate_archive "$ARCHIVE_DIR"
  build_common_env
  [[ -f "$GOLDEN_DIR/manifest.json" ]] || die "golden baselines manifest missing: $GOLDEN_DIR/manifest.json"
  create_volume

  log "setup: extract + pnpm@$PNPM_VERSION install onto empty /work (network=bridge)"
  run_container "${RUN_ID}-setup" setup "$DIAG/setup.cid" \
    --network bridge --memory "$MEMORY" --cpus "$CPUS" \
    --mount "type=bind,source=${ARCHIVE_DIR},target=/arch,readonly" \
    --mount "type=volume,source=${VOLUME_NAME},target=/work" \
    "${BOOTSTRAP_MOUNT[@]}" \
    -w / "${COMMON_ENV[@]}" \
    "$IMAGE" bash -lc 'bash /bootstrap/container-setup.sh' || die "setup failed"

  log "compare: repeat proof against IMMUTABLE golden bytes (network=none)"
  crc=0
  run_container "${RUN_ID}-compare" compare "$DIAG/compare.cid" \
    --network none --memory "$MEMORY" --cpus "$CPUS" \
    --mount "type=bind,source=${ARCHIVE_DIR},target=/arch,readonly" \
    --mount "type=bind,source=${EXTERNAL_DIR},target=/external,readonly" \
    --mount "type=volume,source=${VOLUME_NAME},target=/work" \
    --mount "type=bind,source=${GOLDEN_DIR},target=/work/apps/e2e/baselines,readonly" \
    --mount "type=bind,source=${OUT_DIR},target=/out" \
    "${BOOTSTRAP_MOUNT[@]}" \
    -w /work/apps/e2e \
    -e PLAYWRIGHT_CLI=/external/node_modules/@playwright/test/cli.js \
    -e "CAPIRO_VISUAL_IMAGE=$IMAGE" -e "CAPIRO_VISUAL_IMAGE_DIGEST=$IMAGE_DIGEST" \
    -e CAPIRO_BASELINE_ROOT=/work/apps/e2e/baselines \
    -e CAPIRO_SOURCE_PROVENANCE=/arch/source-manifest.json \
    -e XDG_CACHE_HOME=/tmp/cache "${COMMON_ENV[@]}" \
    "$IMAGE" bash -lc 'bash /bootstrap/container-compare.sh' || crc=$?

  log "compare reports: $OUT_DIR (container exit $crc)"
  exit "$crc"
  ;;
regression)
  ARCHIVE_DIR="${2:?regression needs <archiveDir>}"; GOLDEN_DIR="${3:?regression needs <goldenDir>}"; OUT_DIR="${4:?regression needs <outDir>}"
  [[ -d "$ARCHIVE_DIR" ]] || die "archive dir missing: $ARCHIVE_DIR"
  [[ -d "$GOLDEN_DIR" ]] || die "golden dir missing: $GOLDEN_DIR"
  mkdir -p "$OUT_DIR"; ARCHIVE_DIR="$(cd "$ARCHIVE_DIR" && pwd)"; GOLDEN_DIR="$(cd "$GOLDEN_DIR" && pwd)"; OUT_DIR="$(cd "$OUT_DIR" && pwd)"
  DIAG="${OUT_DIR}/.run-${RUN_ID}"; mkdir -p "$DIAG"
  validate_archive "$ARCHIVE_DIR"
  build_common_env
  [[ -f "$GOLDEN_DIR/manifest.json" ]] || die "golden baselines manifest missing: $GOLDEN_DIR/manifest.json"
  create_volume

  log "setup: extract + pnpm@$PNPM_VERSION install onto empty /work (network=bridge)"
  run_container "${RUN_ID}-setup" setup "$DIAG/setup.cid" \
    --network bridge --memory "$MEMORY" --cpus "$CPUS" \
    --mount "type=bind,source=${ARCHIVE_DIR},target=/arch,readonly" \
    --mount "type=volume,source=${VOLUME_NAME},target=/work" \
    "${BOOTSTRAP_MOUNT[@]}" \
    -w / "${COMMON_ENV[@]}" \
    "$IMAGE" bash -lc 'bash /bootstrap/container-setup.sh' || die "setup failed"

  log "regression: current source vs IMMUTABLE golden bytes, complete comparison + onboard smoke (network=none)"
  crc=0
  run_container "${RUN_ID}-regression" regression "$DIAG/regression.cid" \
    --network none --memory "$MEMORY" --cpus "$CPUS" \
    --mount "type=bind,source=${ARCHIVE_DIR},target=/arch,readonly" \
    --mount "type=bind,source=${EXTERNAL_DIR},target=/external,readonly" \
    --mount "type=volume,source=${VOLUME_NAME},target=/work" \
    --mount "type=bind,source=${GOLDEN_DIR},target=/work/apps/e2e/baselines,readonly" \
    --mount "type=bind,source=${OUT_DIR},target=/out" \
    "${BOOTSTRAP_MOUNT[@]}" \
    -w /work/apps/e2e \
    -e PLAYWRIGHT_CLI=/external/node_modules/@playwright/test/cli.js \
    -e "CAPIRO_VISUAL_IMAGE=$IMAGE" -e "CAPIRO_VISUAL_IMAGE_DIGEST=$IMAGE_DIGEST" \
    -e CAPIRO_BASELINE_ROOT=/work/apps/e2e/baselines \
    -e CAPIRO_SOURCE_PROVENANCE=/arch/source-manifest.json \
    -e CAPIRO_REGRESSION_OUT=/out/regression-evidence.json \
    -e XDG_CACHE_HOME=/tmp/cache "${COMMON_ENV[@]}" \
    "$IMAGE" bash -lc 'bash /bootstrap/container-regression.sh' || crc=$?

  log "regression evidence: $OUT_DIR (container exit $crc; diagnostics retained in $DIAG)"
  exit "$crc"
  ;;
*) die "unknown mode: $MODE" ;;
esac
