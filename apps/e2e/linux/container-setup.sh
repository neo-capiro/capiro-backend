#!/usr/bin/env bash
# In-container SETUP (round-18): the /work volume MUST BE EMPTY (never wiped by
# us — a non-empty/foreign volume is refused). Extract the exact validated
# archive while preserving the COMPLETE workspace node_modules topology on the
# owned volume, install dependencies there with a pinned pnpm, then BUILD the
# workspace packages the renderers resolve at dev time.
#
# Why the build stage exists: the apps/web and apps/onboard-web renderers import
# @capiro/shared, and apps/web also imports @capiro/strategy-verifier. Vite
# resolves those workspace packages through their package.json `exports` to
# built `dist/*` entries (e.g. @capiro/shared "." -> ./dist/index.js). `dist` is
# gitignored and is never part of the source archive, so a fresh
# `pnpm install --frozen-lockfile` alone leaves the package entry UNBUILT and the
# dev server fails ("Vite cannot resolve @capiro/shared package entry"). The
# renderer deps are therefore built here, on the owned volume, BEFORE any browser
# starts.
#
# Every stage is BOUNDED and its raw exit status is RETAINED (no `set -e`
# short-circuit hiding a stage, no build-skip/hidden fallback, no source-fixture
# weakening). A failed stage aborts setup with its own non-zero status.
set -uo pipefail

: "${CAPIRO_ARCHIVE_TAR:?CAPIRO_ARCHIVE_TAR must be set}"
PNPM_VERSION="${CAPIRO_PNPM_VERSION:-9.12.0}"
BUILD_TIMEOUT="${CAPIRO_BUILD_TIMEOUT:-900}"

log() { printf '[setup] %s\n' "$*"; }

# The pinned image must supply timeout; refuse an unbounded build.
command -v timeout >/dev/null 2>&1 || { log 'timeout is required'; exit 3; }
[[ "$BUILD_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { log 'build timeout must be a positive integer'; exit 3; }
run_bounded() { # <seconds> <cmd...>
  local secs="$1"; shift
  timeout "$secs" "$@"
}

# Refuse a non-empty volume: we never blind-delete an unknown volume's contents.
if [[ -d /work ]] && [[ -n "$(ls -A /work 2>/dev/null)" ]]; then
  echo "[setup] REFUSING: /work volume is not empty:" >&2
  ls -A /work | head -20 >&2
  exit 3
fi
mkdir -p /work

# ── Stage 1: extract the exact, host-validated archive (single named tarball) ─
extract=0
tar -xf "/arch/${CAPIRO_ARCHIVE_TAR}" -C /work || extract=$?
if [[ "$extract" -ne 0 ]]; then log "stage extract FAILED rc=$extract"; exit "$extract"; fi
cd /work
log "stage extract=ok archive=${CAPIRO_ARCHIVE_TAR}"

# ── Stage 2: pinned pnpm provision (corepack first, then pinned npm install) ──
corepack enable >/dev/null 2>&1 || true
if ! command -v pnpm >/dev/null 2>&1; then
  provision=0
  npm i -g "pnpm@${PNPM_VERSION}" >/dev/null 2>&1 || provision=$?
  if [[ "$provision" -ne 0 ]]; then log "stage pnpm-provision FAILED rc=$provision"; exit 1; fi
fi
command -v pnpm >/dev/null 2>&1 || { log "stage pnpm-provision FAILED (pnpm absent)"; exit 1; }
pnpm_actual="$(pnpm --version)" || exit $?
[[ "$pnpm_actual" == "$PNPM_VERSION" ]] || { log "pnpm version mismatch: $pnpm_actual, expected $PNPM_VERSION"; exit 3; }
log "stage pnpm-provision=ok pnpm=$pnpm_actual"

# ── Stage 3: frozen workspace install onto the owned volume (network=bridge) ──
# Bounded by the host setup container timeout (STEP_TIMEOUT); status retained.
install=0
pnpm install --frozen-lockfile || install=$?
if [[ "$install" -ne 0 ]]; then log "stage install FAILED rc=$install"; exit "$install"; fi
log "stage install=ok node_modules dirs=$(find /work -maxdepth 3 -name node_modules -type d | wc -l)"

# ── Stage 4+: build the workspace packages the renderers import ───────────────
# build_ws <pnpm-filter> <label> <repo-relative sentinel entry>
build_ws() {
  local filter="$1" label="$2" sentinel="$3" rc=0
  log "stage build[$label] pnpm --filter $filter run build (timeout ${BUILD_TIMEOUT}s)"
  run_bounded "$BUILD_TIMEOUT" pnpm --filter "$filter" run build || rc=$?
  if [[ "$rc" -ne 0 ]]; then log "stage build[$label] FAILED rc=$rc"; return "$rc"; fi
  if [[ ! -f "/work/$sentinel" ]]; then
    log "stage build[$label] FAILED: expected entry not produced: $sentinel"
    return 1
  fi
  log "stage build[$label]=ok entry=$sentinel"
  return 0
}

# @capiro/shared is the lowest common dependency (web + onboard-web). Build it
# first: turbo's contract is `build dependsOn ^build`, and strategy-verifier is
# a sibling of shared in the dependency graph.
build_ws "@capiro/shared" "shared" "packages/shared/dist/index.js" || exit $?
build_ws "@capiro/strategy-verifier" "strategy-verifier" "packages/strategy-verifier/dist/index.js" || exit $?

echo "[setup] node_modules dirs on volume: $(find /work -maxdepth 3 -name node_modules -type d | wc -l)"
echo "[setup] workspace links under apps/*: $(find /work/apps -maxdepth 2 -name node_modules -type d 2>/dev/null | wc -l)"
echo "[setup] built renderer deps: @capiro/shared=packages/shared/dist @capiro/strategy-verifier=packages/strategy-verifier/dist"
exit 0
