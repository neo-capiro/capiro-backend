#!/usr/bin/env bash
#
# Phase 2 code-complete verification for micro-sessions 2.0 through 2.10.
#
# Runs every gate those sessions produced, in dependency order, and prints one
# line per gate plus a summary. Designed to be handed to a fresh agent or
# operator with no prior context.
#
# THIS SCRIPT MUTATES NOTHING. It uses no AWS credentials, deploys nothing,
# pushes no image, and touches no listener rule. Every AWS interaction in the
# suites below is against a fake binary.
#
# Usage:
#   scripts/verify-engagement-phase2-code.sh              # everything runnable here
#   scripts/verify-engagement-phase2-code.sh --fast       # skip Phase 0/1 verifiers
#
# Optional, enables the prototype drift gates:
#   export OUTREACH_V3_PROTOTYPE_PATH="/path/to/Outreach V3 (standalone).html"
#   export EXPECTED_OUTREACH_V3_PROTOTYPE_SHA256=84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453
#
# Exit: 0 every gate passed (skips reported) · 1 at least one gate failed
set -uo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

PASSED=0
FAILED=0
SKIPPED=0
FAILED_GATES=()
SKIPPED_GATES=()

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
pass() { PASSED=$((PASSED + 1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); FAILED_GATES+=("$1"); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
skip() { SKIPPED=$((SKIPPED + 1)); SKIPPED_GATES+=("$1"); printf '  \033[33mSKIP\033[0m  %s — %s\n' "$1" "$2"; }

LOG_DIR="${ENGAGEMENT_PHASE2_LOG_DIR:-.artifacts/engagement-phase2-code}"

# The Phase 2 base. Scope checks compare against THIS, not origin/main: the
# branch also carries all of Phase 0 and Phase 1, so an origin/main baseline
# would attribute their changes to Phase 2.
PHASE2_BASE="${ENGAGEMENT_PHASE2_BASE_SHA:-47902517c7dd64a408a87cef57323812407c29c8}"
mkdir -p "$LOG_DIR"

# gate <name> <command...>
gate() {
  local name="$1"
  shift
  local log="${LOG_DIR}/$(echo "$name" | tr ' /:' '___').log"
  if "$@" >"$log" 2>&1; then
    pass "$name"
  else
    fail "$name  (see $log)"
  fi
}

# node_test <name> <file> — a node:test file passes only when it reports fail 0
node_test() {
  local name="$1" file="$2"
  local log="${LOG_DIR}/$(echo "$name" | tr ' /:' '___').log"
  if node "$file" >"$log" 2>&1 && grep -qE '^# fail 0$' "$log"; then
    local count
    count="$(grep -oE '^# pass [0-9]+' "$log" | grep -oE '[0-9]+' || echo '?')"
    pass "$name  (${count} assertions)"
  else
    fail "$name  (see $log)"
  fi
}

# ts_test <name> <file> — same, through ts-node inside infra/cdk
ts_test() {
  local name="$1" file="$2"
  local log="${LOG_DIR}/$(echo "$name" | tr ' /:' '___').log"
  if (cd infra/cdk && pnpm exec ts-node --prefer-ts-exts "$file") >"$log" 2>&1 &&
    grep -qE '^# fail 0$' "$log"; then
    local count
    count="$(grep -oE '^# pass [0-9]+' "$log" | grep -oE '[0-9]+' || echo '?')"
    pass "$name  (${count} assertions)"
  else
    fail "$name  (see $log)"
  fi
}

bold "Phase 2 code verification — micro-sessions 2.0 to 2.10"
echo "repo:   $REPO_ROOT"
echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "head:   $(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "base:   ${PHASE2_BASE} (Phase 2 base; scope checks compare against this)"
echo "logs:   $LOG_DIR"
echo ""

# ── 2.0 prerequisites and input lock ─────────────────────────────────────────
bold "2.0  Prerequisites and input lock"

if [ -f docs/plans/engagement-api/phase-2-input-lock.md ]; then
  pass "input lock document is committed"
else
  fail "input lock document is missing"
fi

if [ "$FAST" -eq 1 ]; then
  skip "Phase 0 verifier" "--fast"
  skip "Phase 1 DB-free verifier" "--fast"
else
  gate "Phase 0 verifier" pnpm verify:engagement-phase-0
  gate "Phase 1 DB-free verifier" pnpm verify:engagement-phase-1
fi

# The repo-wide typecheck is known-red on main for four pre-existing
# defense-budget TS6059 errors. Assert the count has not GROWN.
BASELINE_TS_ERRORS=4
ACTUAL_TS_ERRORS="$( (cd apps/api && pnpm exec tsc --noEmit 2>&1) | grep -cE 'error TS' || true)"
if [ "$ACTUAL_TS_ERRORS" -le "$BASELINE_TS_ERRORS" ]; then
  pass "apps/api typecheck at or below the pre-existing baseline (${ACTUAL_TS_ERRORS}/${BASELINE_TS_ERRORS})"
else
  fail "apps/api typecheck regressed: ${ACTUAL_TS_ERRORS} errors, baseline ${BASELINE_TS_ERRORS}"
fi

# ── 2.1 prototype interaction contract ───────────────────────────────────────
echo ""
bold "2.1  Prototype interaction contract"
node_test "prototype contract suite" scripts/outreach-v3-prototype-contract.spec.mjs

if [ -n "${OUTREACH_V3_PROTOTYPE_PATH:-}" ] && [ -f "${OUTREACH_V3_PROTOTYPE_PATH}" ]; then
  gate "prototype contract drift (fixture matches the real prototype)" \
    node scripts/outreach-v3-prototype-contract.mjs \
    --check apps/api/src/engagement/__fixtures__/outreach-v3-prototype-state-manifest.v1.json
else
  skip "prototype contract drift" "set OUTREACH_V3_PROTOTYPE_PATH to enable"
fi

# ── 2.2 UI-to-API capability matrix ──────────────────────────────────────────
echo ""
bold "2.2  UI-to-API capability matrix"
gate "capability manifest is current and passes every invariant" \
  pnpm --filter @capiro/api exec tsx scripts/verify-outreach-v3-ui-api-capabilities.ts
gate "capability matrix spec (16 assertions)" \
  pnpm --filter @capiro/api exec jest --runInBand --forceExit \
  src/engagement/outreach-v3-ui-api-capability.spec.ts

# ── 2.3 config contract and read-only discovery ──────────────────────────────
echo ""
bold "2.3  Infrastructure config and read-only discovery"
ts_test "config contract" test/engagement-api-config.spec.ts
gate "discovery script syntax" bash -n scripts/engagement-api-infra-discover.sh
node_test "discovery (fake AWS, read-only proven)" scripts/engagement-api-infra-discover.spec.mjs

# ── 2.4 to 2.8 CDK stacks ────────────────────────────────────────────────────
echo ""
bold "2.4-2.8  CDK stacks"
ts_test "2.4 registry stack" test/engagement-api-registry-stack.spec.ts
ts_test "2.5 network stack" test/engagement-api-network-stack.spec.ts
ts_test "2.6 service stack" test/engagement-api-service-stack.spec.ts
ts_test "2.7 least privilege" test/engagement-api-least-privilege.spec.ts
ts_test "2.8 observability" test/engagement-api-observability.spec.ts
gate "infra/cdk typecheck" pnpm --dir infra/cdk run typecheck
gate "infra/cdk build" pnpm --dir infra/cdk run build

# ── synthesis and template safety ────────────────────────────────────────────
echo ""
bold "2.9  Synthesis and template safety"

SYNTH_OUT="${REPO_ROOT}/${LOG_DIR}/cdk.out"
rm -rf "$SYNTH_OUT"
if (cd infra/cdk &&
  ENGAGEMENT_API_INFRA_CONFIG="${REPO_ROOT}/infra/cdk/fixtures/engagement-api.test.json" \
    pnpm exec cdk synth --app "ts-node --prefer-ts-exts bin/engagement-api.ts" \
    --output "$SYNTH_OUT" --quiet) >"${LOG_DIR}/synth.log" 2>&1; then
  pass "synthetic synth of all three stacks"

  gate "template safety verifier on fresh synth output" \
    node scripts/verify-engagement-phase2-template.mjs \
    "$SYNTH_OUT/Capiro-dev-EngagementApiRegistry.template.json" \
    "$SYNTH_OUT/Capiro-dev-EngagementApiNetwork.template.json" \
    "$SYNTH_OUT/Capiro-dev-EngagementApiService.template.json"

  gate "task config verifier on fresh synth output" \
    node scripts/verify-engagement-api-task-config.mjs \
    --template "$SYNTH_OUT/Capiro-dev-EngagementApiService.template.json" \
    --config infra/cdk/fixtures/engagement-api.test.json
else
  fail "synthetic synth of all three stacks  (see ${LOG_DIR}/synth.log)"
  skip "template safety verifier on fresh synth output" "synth failed"
  skip "task config verifier on fresh synth output" "synth failed"
fi

node_test "template safety suite (23 negative controls)" \
  scripts/verify-engagement-phase2-template.spec.mjs

# The committed fixtures must still match what the stacks synthesize; otherwise
# the negative controls above are exercising stale templates.
if [ -d "$SYNTH_OUT" ]; then
  DRIFT=0
  for pair in "Registry:registry" "Network:network" "Service:service"; do
    fresh="$SYNTH_OUT/Capiro-dev-EngagementApi${pair%%:*}.template.json"
    committed="scripts/fixtures/engagement-phase2-template/${pair##*:}.template.json"
    if ! node -e '
      const fs = require("node:fs");
      const a = JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
      const b = JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
      process.exit(a === b ? 0 : 1);
    ' "$fresh" "$committed" 2>/dev/null; then
      DRIFT=1
    fi
  done
  if [ "$DRIFT" -eq 0 ]; then
    pass "committed template fixtures match fresh synth output"
  else
    fail "committed template fixtures have drifted from fresh synth output"
  fi
fi

# ── 2.10 image publication ───────────────────────────────────────────────────
echo ""
bold "2.10  Image publication"
gate "image script syntax" bash -n scripts/engagement-api-image.sh
node_test "image publication (fake docker and AWS)" scripts/engagement-api-image.spec.mjs

# ── 2.11 fail-closed ALB preview rule manager ────────────────────────────────
echo ""
bold "2.11  ALB preview rule manager"
gate "ALB rules script syntax" bash -n scripts/engagement-api-alb-rules.sh
node_test "ALB preview rules (stateful fake AWS)" scripts/engagement-api-alb-rules.spec.mjs

# ── 2.12 UI-aware preview acceptance ─────────────────────────────────────────
echo ""
bold "2.12  UI-aware preview acceptance"
gate "preview probe manifest is current and passes every invariant" \
  node scripts/engagement-api-preview-ui-contract.mjs \
  --check apps/api/src/engagement/__fixtures__/outreach-v3-preview-probe-manifest.v1.json
node_test "preview probe manifest contract" scripts/engagement-api-preview-ui-contract.spec.mjs
gate "preview parity runner self-check (no network call)" bash -c \
  'cd apps/api && pnpm exec tsx scripts/engagement-phase2-preview-parity.ts --self-check'

# ── cross-cutting safety ─────────────────────────────────────────────────────
echo ""
bold "Cross-cutting safety"

if git diff --quiet "$PHASE2_BASE" HEAD -- \
  infra/cdk/lib/compute-stack.ts infra/cdk/bin/capiro.ts infra/cdk/lib/config.ts 2>/dev/null; then
  pass "frozen Compute stack, root CDK app and shared config untouched"
else
  fail "the frozen Compute stack or root CDK app was modified since the Phase 2 base"
fi

if [ -z "$(git status --porcelain)" ]; then
  pass "working tree clean"
else
  fail "working tree is dirty"
fi

if git diff --name-only "$PHASE2_BASE" HEAD 2>/dev/null | grep -qE '^apps/web/'; then
  fail "product web source was modified since the Phase 2 base"
else
  pass "no product web change since the Phase 2 base"
fi

if git diff --name-only "$PHASE2_BASE" HEAD 2>/dev/null | grep -qE '^apps/api/prisma/migrations/'; then
  fail "a database migration was added since the Phase 2 base"
else
  pass "no database migration"
fi

gate "current web sends no preview header (dedicated guard)" \
  node scripts/verify-engagement-web-no-preview-header.mjs

# ── summary ──────────────────────────────────────────────────────────────────
echo ""
bold "Summary"
echo "  passed:  $PASSED"
echo "  failed:  $FAILED"
echo "  skipped: $SKIPPED"
for gate_name in "${SKIPPED_GATES[@]+"${SKIPPED_GATES[@]}"}"; do
  echo "    skipped: $gate_name"
done
for gate_name in "${FAILED_GATES[@]+"${FAILED_GATES[@]}"}"; do
  echo "    failed:  $gate_name"
done
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo "ENGAGEMENT_PHASE2_CODE_INCOMPLETE ($FAILED gate(s) failed)" >&2
  exit 1
fi
if [ "$SKIPPED" -gt 0 ]; then
  echo "ENGAGEMENT_PHASE2_CODE_COMPLETE_WITH_SKIPS ($SKIPPED gate(s) not measured)"
  exit 0
fi
echo "ENGAGEMENT_PHASE2_CODE_COMPLETE"
