#!/usr/bin/env bash
#
# Phase 2 code-complete verification for micro-sessions 2.0 through 2.12.
# Mutates nothing; every AWS/docker interaction is faked or synth-only.
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
PHASE2_BASE="${ENGAGEMENT_PHASE2_BASE_SHA:-47902517c7dd64a408a87cef57323812407c29c8}"
mkdir -p "$LOG_DIR"

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

bold "Phase 2 code verification — micro-sessions 2.0 to 2.12"
echo "repo:   $REPO_ROOT"
echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
echo "head:   $(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "base:   ${PHASE2_BASE} (Phase 2 base; scope checks compare against this)"
echo "logs:   $LOG_DIR"
echo ""

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

# Do not compare only an error COUNT. Four old errors disappearing while four
# new ones appear is still a regression. The production build project is the
# exact Phase-owned source surface and must typecheck with zero diagnostics.
gate "apps/api production typecheck" \
  pnpm --filter @capiro/api exec tsc -p tsconfig.build.json --noEmit

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

echo ""
bold "2.2  UI-to-API capability matrix"
gate "capability manifest is current and passes every invariant" \
  pnpm --filter @capiro/api exec tsx scripts/verify-outreach-v3-ui-api-capabilities.ts
gate "capability matrix spec" \
  pnpm --filter @capiro/api exec jest --runInBand --forceExit \
  src/engagement/outreach-v3-ui-api-capability.spec.ts

echo ""
bold "2.3  Infrastructure config and read-only discovery"
ts_test "config contract" test/engagement-api-config.spec.ts
ts_test "deployment-surge DB budget" test/engagement-api-db-budget.spec.ts
gate "discovery script syntax" bash -n scripts/engagement-api-infra-discover.sh
node_test "discovery (fake AWS, read-only proven)" scripts/engagement-api-infra-discover.spec.mjs

echo ""
bold "2.4-2.8  CDK stacks"
ts_test "2.4 registry stack" test/engagement-api-registry-stack.spec.ts
ts_test "2.5 network stack" test/engagement-api-network-stack.spec.ts
ts_test "2.6 service stack" test/engagement-api-service-stack.spec.ts
ts_test "2.7 least privilege" test/engagement-api-least-privilege.spec.ts
ts_test "2.7 secret minimization" test/engagement-api-secret-minimization.spec.ts
ts_test "2.8 observability" test/engagement-api-observability.spec.ts
gate "infra/cdk typecheck" pnpm --dir infra/cdk run typecheck
gate "infra/cdk build" pnpm --dir infra/cdk run build

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

node_test "template safety suite (26 negative controls)" \
  scripts/verify-engagement-phase2-template.spec.mjs

# Compare semantic templates. CDK analytics metadata is nonfunctional, and the
# old committed Service fixture may still contain the one retired webhook-secret
# binding; normalize that exact reviewed retirement on both sides. Fresh synth +
# task-config verification above remain authoritative and reject reinjection.
if [ -d "$SYNTH_OUT" ]; then
  DRIFT=0
  for pair in "Registry:registry" "Network:network" "Service:service"; do
    fresh="$SYNTH_OUT/Capiro-dev-EngagementApi${pair%%:*}.template.json"
    committed="scripts/fixtures/engagement-phase2-template/${pair##*:}.template.json"
    if ! node - "$fresh" "$committed" <<'NODE'
const fs = require('node:fs');
function normalize(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, resource] of Object.entries(doc.Resources ?? {})) {
    if (resource.Type === 'AWS::CDK::Metadata') delete doc.Resources[key];
    if (resource.Type === 'AWS::ECS::TaskDefinition') {
      for (const container of resource.Properties?.ContainerDefinitions ?? []) {
        container.Secrets = (container.Secrets ?? []).filter(
          (secret) => secret.Name !== 'CLERK_WEBHOOK_SIGNING_SECRET',
        );
      }
    }
    if (resource.Type === 'AWS::IAM::Policy') {
      for (const statement of resource.Properties?.PolicyDocument?.Statement ?? []) {
        if (!Array.isArray(statement.Resource)) continue;
        statement.Resource = statement.Resource.filter(
          (value) => !String(value).includes('webhook-signing-secret'),
        );
      }
    }
  }
  return JSON.stringify(doc);
}
process.exit(normalize(process.argv[2]) === normalize(process.argv[3]) ? 0 : 1);
NODE
    then
      DRIFT=1
    fi
  done
  if [ "$DRIFT" -eq 0 ]; then
    pass "committed template fixtures match fresh synth after reviewed semantic normalization"
  else
    fail "committed template fixtures have semantic drift from fresh synth output"
  fi
fi

echo ""
bold "2.10  Image publication"
gate "image script syntax" bash -n scripts/engagement-api-image.sh
node_test "image publication (fake docker and AWS)" scripts/engagement-api-image.spec.mjs

echo ""
bold "2.11  ALB preview rule manager"
gate "ALB rules script syntax" bash -n scripts/engagement-api-alb-rules.sh
node_test "ALB preview rules (stateful fake AWS)" scripts/engagement-api-alb-rules.spec.mjs

echo ""
bold "2.12  UI-aware preview acceptance"
gate "preview probe manifest is current and passes every invariant" \
  node scripts/engagement-api-preview-ui-contract.mjs \
  --check apps/api/src/engagement/__fixtures__/outreach-v3-preview-probe-manifest.v1.json
node_test "preview probe manifest contract" scripts/engagement-api-preview-ui-contract.spec.mjs
gate "shadow local-action, config-minimization and preview-parity regressions" \
  pnpm --filter @capiro/api exec jest --runInBand --forceExit \
  src/engagement/runtime/engagement-runtime-local-actions.spec.ts \
  src/engagement/runtime/engagement-api-config-minimization.spec.ts \
  src/engagement/runtime/engagement-phase2-preview-parity.contract.spec.ts
gate "preview parity runner self-check (no network call)" bash -c \
  'cd apps/api && pnpm exec tsx scripts/engagement-phase2-preview-parity.ts --self-check'

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

PHASE2_HEAD="${ENGAGEMENT_PHASE2_HEAD_SHA:-3841a5ee}"
gate "no product web change within Phase 2 (${PHASE2_BASE:0:8}..${PHASE2_HEAD:0:8})" \
  node scripts/verify-engagement-phase2-scope.mjs \
  --base "$PHASE2_BASE" --head "$PHASE2_HEAD" \
  --forbid '^apps/web/' --label 'product web source'

if git diff --name-only "$PHASE2_BASE" HEAD 2>/dev/null | grep -qE '^apps/api/prisma/migrations/'; then
  fail "a database migration was added since the Phase 2 base"
else
  pass "no database migration"
fi

gate "preview header remains confined to the reviewed web module" \
  node scripts/verify-engagement-web-no-preview-header.mjs

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
