#!/usr/bin/env bash
# G5 (Strategy Planner / Meri) live E2E probe against capiro-dev (real prod).
# The gate ships DARK (STRATEGY_MERI_ENABLED=false + strategyPlannerMeri flag
# off), so this cannot exercise the LLM apply logic end-to-end — that is covered
# by the jest integration suites. What this proves against the live deployment:
#   1. api-strategy + web are serving (health / SPA 200).
#   2. Every NEW Meri route (api-strategy + the shared orchestrator) is
#      REGISTERED and GUARDED — an unauthenticated call returns 401/403, never
#      404 (missing) and never 200 (unprotected).
#   3. Existing strategy routes still enforce auth (no regression).
# Usage: bash infra/qa/g5-meri-qa.sh
set -u
BASE="${BASE:-https://app.capiro.ai}"
pass=0; fail=0
declare -a FAILURES

# code <METHOD> <PATH> -> prints HTTP status code
code() {
  curl -s -o /dev/null -w '%{http_code}' -X "$1" "${BASE}$2" \
    -H 'content-type: application/json' --max-time 20 -d '{}' 2>/dev/null
}
codeget() {
  curl -s -o /dev/null -w '%{http_code}' "${BASE}$1" --max-time 20 2>/dev/null
}

# expect_exact <desc> <actual> <expected>
expect_exact() {
  if [ "$2" == "$3" ]; then
    echo "  PASS  $1 -> $2 (expected $3)"; pass=$((pass+1))
  else
    echo "  FAIL  $1 -> $2 (expected $3)"; fail=$((fail+1)); FAILURES+=("$1: got $2 want $3")
  fi
}
# expect_guarded <desc> <actual>  (PASS on 401/403; FAIL on 404/200/5xx)
expect_guarded() {
  case "$2" in
    401|403) echo "  PASS  $1 -> $2 (registered + guarded)"; pass=$((pass+1));;
    404)     echo "  FAIL  $1 -> 404 (route NOT registered)"; fail=$((fail+1)); FAILURES+=("$1: 404 not registered");;
    200)     echo "  FAIL  $1 -> 200 (route UNPROTECTED!)"; fail=$((fail+1)); FAILURES+=("$1: 200 unprotected");;
    *)       echo "  FAIL  $1 -> $2 (unexpected)"; fail=$((fail+1)); FAILURES+=("$1: unexpected $2");;
  esac
}

echo "== G5 Meri live E2E probe @ ${BASE} =="

echo "-- Liveness --"
expect_exact "GET /strategy-api/health"      "$(codeget /strategy-api/health)" 200
expect_exact "GET / (web SPA)"               "$(codeget /)"                    200

echo "-- api-strategy: existing route still guarded (regression) --"
expect_guarded "GET /strategy-api/strategies"                 "$(codeget /strategy-api/strategies)"

echo "-- api-strategy: NEW Meri routes registered + guarded --"
expect_guarded "POST /strategy-api/strategies/draft"          "$(code POST /strategy-api/strategies/draft)"
expect_guarded "POST /strategy-api/strategies/x/assistant"    "$(code POST /strategy-api/strategies/x/assistant)"
expect_guarded "POST /strategy-api/reference-calendars/congress/assist" "$(code POST /strategy-api/reference-calendars/congress/assist)"
expect_guarded "POST /strategy-api/reference-calendars/ppbe/assist"     "$(code POST /strategy-api/reference-calendars/ppbe/assist)"

echo "-- shared orchestrator: NEW strategy routes registered + guarded --"
expect_guarded "POST /meri-api/strategy-draft"            "$(code POST /meri-api/strategy-draft)"
expect_guarded "POST /meri-api/strategy-assistant"        "$(code POST /meri-api/strategy-assistant)"
expect_guarded "POST /meri-api/strategy-reference-assist" "$(code POST /meri-api/strategy-reference-assist)"

echo "-- orchestrator: existing in-editor route still guarded (regression) --"
expect_guarded "POST /meri-api/in-editor-assistant"       "$(code POST /meri-api/in-editor-assistant)"

echo
echo "== RESULT: ${pass} passed, ${fail} failed =="
if [ "$fail" -ne 0 ]; then
  printf '  - %s\n' "${FAILURES[@]}"
  echo "VERDICT: FAIL"
  exit 1
fi
echo "VERDICT: PASS"
exit 0
