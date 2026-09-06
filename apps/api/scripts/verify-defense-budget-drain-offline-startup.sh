#!/usr/bin/env bash
# Phase 10B-28R -- ingestion-drain image OFFLINE STARTUP GATE.
#
# Proves, against a BUILT drain image, that the exact production parser-runtime
# launcher used by source-document-parser-handoff.ts
#
#     uv run --no-sync capiro-defense-budget-parser <verb ...>
#
# (LIFECYCLE_BRIDGE_PARSER_RUNTIME_COMMAND_V1) works for every production verb
# -- version, profile, run -- with Docker networking DISABLED, an EMPTY runtime
# uv cache (/tmp is a fresh tmpfs), no host dependency-cache mounts, and as the
# image's own non-root user. It also proves the fail-closed guard the image
# carries (UV_OFFLINE=1): a launcher that re-syncs the environment must FAIL in
# this image even WITH network, instead of silently downloading from PyPI.
#
# Phase 10B-28 found the previous launcher (`uv run capiro-defense-budget-parser`,
# no --no-sync) rebuilt the editable root project on every task start and
# fetched `hatchling` from PyPI; this gate is what catches that class of
# regression. Run it as part of every drain-image qualification.
#
# usage:
#   verify-defense-budget-drain-offline-startup.sh <image-ref> <source.pdf> <source-sha256> [pages] [out-dir]
#     pages   comma-separated physical pages to parse with the OCR engine
#             (default 11,15,20,37 -- the FY2024 Army R-2 scanned-page set)
#     out-dir where job files, results, and logs are written (default: mktemp -d)
# env:
#   DRAIN_IMAGE_PLATFORM   docker --platform value (default linux/arm64; QEMU on x86 hosts is slow: ~5 min/OCR page)
#   OFFLINE_GATE_ENGINE    parse engine for the per-page jobs (default paddleocr)
#
# exit 0 => OFFLINE_STARTUP_GATE=PASS ; non-zero => FAIL (every failed step is printed).
set -u
export MSYS_NO_PATHCONV=1

IMG="${1:?image ref required}"
SRC="${2:?source pdf path required}"
SHA="${3:?source sha256 required}"
PAGES="${4:-11,15,20,37}"
OUT="${5:-$(mktemp -d)}"
PLATFORM="${DRAIN_IMAGE_PLATFORM:-linux/arm64}"
ENGINE="${OFFLINE_GATE_ENGINE:-paddleocr}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOBS_TS="$HERE/lib/defense-budget-offline-startup-jobs.ts"

hostpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
mkdir -p "$OUT/jobs"
SRC_DIR_W="$(hostpath "$(cd "$(dirname "$SRC")" && pwd)")"
SRC_NAME="$(basename "$SRC")"
OUT_W="$(hostpath "$OUT")"
JOBS_TS_W="$(hostpath "$JOBS_TS")"

FAILED=0
fail() { echo "GATE_FAIL: $*"; FAILED=1; }
pass() { echo "GATE_OK:   $*"; }
json() { node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],j);console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2" 2>/dev/null; }
no_download_markers() {
  # uv prints these while syncing/installing; none may appear on a compliant launcher.
  if grep -Eq 'Downloading|Downloaded|Installed [0-9]+ package|Building capiro-defense-budget-parser|Built capiro-defense-budget-parser|Resolved [0-9]+ package|Prepared [0-9]+ package|pypi\.org' "$1"; then return 1; fi
  return 0
}

# Every launcher invocation below: no network, fresh empty /tmp (=> empty UV_CACHE_DIR), image user, image env.
BASE=(docker run --rm --platform "$PLATFORM" --tmpfs /tmp:rw,size=2g -v "$SRC_DIR_W:/src:ro" -v "$OUT_W:/out")
OFFLINE=("${BASE[@]}" --network none)

echo "=== drain image ==="
docker image inspect "$IMG" --format 'os/arch={{.Os}}/{{.Architecture}} id={{.Id}} repoDigests={{.RepoDigests}} created={{.Created}}' || { fail "image not present locally: $IMG"; echo "OFFLINE_STARTUP_GATE=FAIL"; exit 1; }
ARCH="$(docker image inspect "$IMG" --format '{{.Architecture}}')"
case "$PLATFORM" in *"$ARCH"*) pass "image architecture $ARCH matches $PLATFORM";; *) fail "image architecture $ARCH does not match $PLATFORM";; esac

echo "=== source identity ==="
ACTUAL_SHA="$(sha256sum "$SRC" | cut -d' ' -f1)"
[ "$ACTUAL_SHA" = "$SHA" ] && pass "source sha256 $SHA" || fail "source sha256 mismatch: expected $SHA got $ACTUAL_SHA"

echo "=== image runtime env (must carry the no-runtime-download contract) ==="
"${OFFLINE[@]}" --entrypoint sh "$IMG" -c 'echo "user=$(id -u):$(id -g)"; echo "UV_NO_SYNC=${UV_NO_SYNC:-<unset>} UV_OFFLINE=${UV_OFFLINE:-<unset>} UV_CACHE_DIR=${UV_CACHE_DIR:-<unset>} UV_PROJECT=${UV_PROJECT:-<unset>}"; echo "uv_cache_present=$([ -d "$UV_CACHE_DIR" ] && echo yes || echo no)"; uv --version' > "$OUT/env.txt" 2>&1
cat "$OUT/env.txt"
grep -q 'UV_NO_SYNC=1' "$OUT/env.txt" && pass "UV_NO_SYNC=1 in image env" || fail "UV_NO_SYNC=1 missing from image env"
grep -q 'UV_OFFLINE=1' "$OUT/env.txt" && pass "UV_OFFLINE=1 in image env" || fail "UV_OFFLINE=1 missing from image env"
grep -q 'uv_cache_present=no' "$OUT/env.txt" && pass "runtime uv cache starts empty" || fail "runtime uv cache unexpectedly present"

echo "=== [1/5] version via the exact production launcher, network disabled ==="
"${OFFLINE[@]}" -w /defense-budget-parser --entrypoint uv "$IMG" run --no-sync capiro-defense-budget-parser version --json > "$OUT/version.json" 2> "$OUT/version.stderr"
RC=$?
if [ $RC -eq 0 ]; then pass "version exit 0"; else fail "version exit $RC: $(head -c 600 "$OUT/version.stderr")"; fi
no_download_markers "$OUT/version.stderr" && pass "version: no download/sync markers on stderr ($(stat -c %s "$OUT/version.stderr") bytes)" || fail "version stderr shows sync/download activity"
PDFPLUMBER_VERSION="$(json "$OUT/version.json" engines.deterministic_pdfplumber)"
ENGINE_VERSION="$(json "$OUT/version.json" "engines.$ENGINE")"
echo "engines: $(json "$OUT/version.json" engines)"
[ -n "$PDFPLUMBER_VERSION" ] && [ "$PDFPLUMBER_VERSION" != "ENGINE_UNAVAILABLE" ] && [ "$PDFPLUMBER_VERSION" != "undefined" ] && pass "pdfplumber engine identity $PDFPLUMBER_VERSION" || fail "pdfplumber engine identity missing/unavailable"
[ -n "$ENGINE_VERSION" ] && [ "$ENGINE_VERSION" != "ENGINE_UNAVAILABLE" ] && [ "$ENGINE_VERSION" != "undefined" ] && pass "$ENGINE engine identity $ENGINE_VERSION" || fail "$ENGINE engine identity missing/unavailable"

echo "=== [2/5] job files generated in-container from the real parser identities ==="
"${OFFLINE[@]}" -v "$JOBS_TS_W:/app/apps/api/scripts/lib/defense-budget-offline-startup-jobs.ts:ro" --entrypoint /app/apps/api/node_modules/.bin/tsx "$IMG" \
  /app/apps/api/scripts/lib/defense-budget-offline-startup-jobs.ts --source-path "/src/$SRC_NAME" --source-sha256 "$SHA" --out-dir /out/jobs \
  --pages "$PAGES" --engine "$ENGINE" --pdfplumber-version "$PDFPLUMBER_VERSION" --engine-version "$ENGINE_VERSION" > "$OUT/jobs.stdout" 2> "$OUT/jobs.stderr"
RC=$?
if [ $RC -eq 0 ]; then pass "job generation exit 0: $(cat "$OUT/jobs.stdout")"; else fail "job generation exit $RC: $(head -c 800 "$OUT/jobs.stderr")"; fi

echo "=== [3/5] profile via the exact production launcher, network disabled ==="
T0=$(date +%s)
"${OFFLINE[@]}" -w /defense-budget-parser --entrypoint uv "$IMG" run --no-sync capiro-defense-budget-parser profile --job /out/jobs/profile.job.json --out /out/profile.result.json > "$OUT/profile.stdout" 2> "$OUT/profile.stderr"
RC=$?
echo "profile wall=$(( $(date +%s) - T0 ))s"
if [ $RC -eq 0 ]; then pass "profile exit 0"; else fail "profile exit $RC: $(head -c 600 "$OUT/profile.stderr")"; fi
no_download_markers "$OUT/profile.stderr" && pass "profile: no download/sync markers" || fail "profile stderr shows sync/download activity"
if [ -f "$OUT/profile.result.json" ]; then
  PROFILE_SHA="$(json "$OUT/profile.result.json" sourceSha256)"; PROFILE_PAGES="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((j.pages||[]).length)' "$OUT/profile.result.json")"
  [ "$PROFILE_SHA" = "$SHA" ] && pass "profile sourceSha256 matches" || fail "profile sourceSha256 $PROFILE_SHA != $SHA"
  [ "${PROFILE_PAGES:-0}" -gt 0 ] && pass "profile reported $PROFILE_PAGES physical pages" || fail "profile reported zero pages"
else
  fail "profile result missing"
fi

echo "=== [4/5] per-page $ENGINE parse via the exact production launcher, network disabled (pages: $PAGES) ==="
IFS=',' read -r -a PAGE_LIST <<< "$PAGES"
for P in "${PAGE_LIST[@]}"; do
  P="$(echo "$P" | tr -d ' ')"; [ -z "$P" ] && continue
  T0=$(date +%s)
  "${OFFLINE[@]}" -w /defense-budget-parser --entrypoint uv "$IMG" run --no-sync capiro-defense-budget-parser run --job "/out/jobs/p$P.job.json" --out "/out/p$P/result.json" > "$OUT/p$P.stdout" 2> "$OUT/p$P.stderr"
  RC=$?
  WALL=$(( $(date +%s) - T0 ))
  if [ $RC -eq 0 ]; then pass "page $P exit 0 (wall ${WALL}s)"; else fail "page $P exit $RC (wall ${WALL}s): $(head -c 600 "$OUT/p$P.stderr")"; fi
  no_download_markers "$OUT/p$P.stderr" && pass "page $P: no download/sync markers" || fail "page $P stderr shows sync/download activity"
  if [ -f "$OUT/p$P/result.json" ]; then
    SUMMARY="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const codes=[...new Set((j.failedPages||[]).map(f=>f.code))];console.log(JSON.stringify({engine:j.engine,parserVersion:j.parserVersion,succeededPages:j.succeededPages,failedPages:(j.failedPages||[]).length,failCodes:codes,warnings:(j.warnings||[]).length,contentSha256:j.contentSha256}))' "$OUT/p$P/result.json")"
    echo "page $P result: $SUMMARY"
    echo "$SUMMARY" | grep -q "\"succeededPages\":\[$P\]" && pass "page $P succeeded exactly" || fail "page $P did not succeed exactly"
    echo "$SUMMARY" | grep -q '"failedPages":0' && pass "page $P zero failed pages" || fail "page $P has failed pages"
    echo "$SUMMARY" | grep -q 'model_unavailable' && fail "page $P reports model_unavailable" || pass "page $P no model_unavailable"
    echo "$SUMMARY" | grep -q "\"engine\":\"$ENGINE\"" && pass "page $P engine identity $ENGINE" || fail "page $P engine identity mismatch"
    echo "$SUMMARY" | grep -q "\"parserVersion\":\"$ENGINE_VERSION\"" && pass "page $P parser version $ENGINE_VERSION" || fail "page $P parser version mismatch"
  else
    fail "page $P result missing"
  fi
done

echo "=== [5/5] fail-closed controls: a launcher that RE-SYNCS must fail in this image ==="
# Control A: sync forced back on (UV_NO_SYNC=0 overrides the image env), no network.
"${OFFLINE[@]}" -e UV_NO_SYNC=0 -w /defense-budget-parser --entrypoint uv "$IMG" run capiro-defense-budget-parser version --json > "$OUT/controlA.stdout" 2> "$OUT/controlA.stderr"
RC=$?
[ $RC -ne 0 ] && pass "control A (sync on, no network) failed closed with exit $RC" || fail "control A unexpectedly succeeded: a re-syncing launcher must not work offline"
# Control B: sync forced back on WITH network -- UV_OFFLINE=1 must still refuse to download anything.
"${BASE[@]}" -e UV_NO_SYNC=0 -w /defense-budget-parser --entrypoint uv "$IMG" run capiro-defense-budget-parser version --json > "$OUT/controlB.stdout" 2> "$OUT/controlB.stderr"
RC=$?
[ $RC -ne 0 ] && pass "control B (sync on, network available) failed closed with exit $RC" || fail "control B unexpectedly succeeded: image allowed a runtime sync with network (UV_OFFLINE guard missing)"
no_download_markers "$OUT/controlB.stderr" && pass "control B: nothing was downloaded or installed" || fail "control B downloaded/installed packages at runtime"
echo "control B stderr head: $(head -c 300 "$OUT/controlB.stderr" | tr '\n' ' ')"

echo "=== summary ==="
echo "image=$IMG platform=$PLATFORM engine=$ENGINE pages=$PAGES out=$OUT"
if [ $FAILED -eq 0 ]; then echo "OFFLINE_STARTUP_GATE=PASS"; exit 0; else echo "OFFLINE_STARTUP_GATE=FAIL"; exit 1; fi
