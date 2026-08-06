#!/usr/bin/env bash
#
# engagement-api — fail-closed dark-preview ALB listener rule manager.
#
# Manages EXACTLY ONE rule on the live HTTPS listener:
#   priority 6
#   path       /api/engagement/*
#   AND header X-Capiro-Engagement-Preview: v3
#   -> forward 100% to the engagement-api target group
#
# The header is routing metadata, not authorization. Standard auth/tenant
# checks still run downstream; this script only decides which service SEES
# the request.
#
# Like scripts/meri-alb-rules.sh and scripts/onboard-alb-rules.sh, this ALB is
# hand-managed: its rules are NOT in CloudFormation and cdk deploy must never
# own them. Unlike those scripts, this one is fail-closed by construction: it
# refuses on any ambiguity rather than picking a "close enough" resource, and
# create/delete each require a distinct, exact confirmation token.
#
# Commands:
#   list             describe every rule on the listener (read-only)
#   verify-baseline  the 12 pre-create checks; read-only
#   create-preview   create the exact rule (requires CONFIRM_..._CREATE)
#   verify-preview   assert the created rule is exactly the expected shape
#   delete-preview   remove exactly that rule (requires CONFIRM_..._DELETE)
#
# Required environment:
#   AWS_REGION
#   EXPECTED_AWS_ACCOUNT_ID
#   HTTPS_LISTENER_ARN
#   ENGAGEMENT_TARGET_GROUP_ARN
#   MAIN_API_TARGET_GROUP_ARN
#   GENERIC_API_RULE_PRIORITY     the discovered live value, e.g. 10
#
# Optional (all have the Phase 2 contract defaults):
#   PREVIEW_RULE_PRIORITY=6
#   PREVIEW_HEADER_NAME=X-Capiro-Engagement-Preview
#   PREVIEW_HEADER_VALUE=v3
#   AWS_BIN, NODE_BIN
#   ENGAGEMENT_ALB_OUT_DIR   defaults to .artifacts/engagement-phase2/<region>
#
# create-preview requires:
#   CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE=<account-id>:<region>:<priority>
#
# delete-preview requires:
#   CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE=<exact-rule-arn>
#
# Exit: 0 ok · 1 usage/validation error · 2 refused for safety
set -euo pipefail
export MSYS_NO_PATHCONV=1

AWS_BIN="${AWS_BIN:-aws}"
NODE_BIN="${NODE_BIN:-node}"
PREVIEW_RULE_PRIORITY="${PREVIEW_RULE_PRIORITY:-6}"
PREVIEW_HEADER_NAME="${PREVIEW_HEADER_NAME:-X-Capiro-Engagement-Preview}"
PREVIEW_HEADER_VALUE="${PREVIEW_HEADER_VALUE:-v3}"
PREVIEW_PATH_PATTERN="/api/engagement/*"
RECALL_PATH_PATTERN="/webhooks/recall"

die() { printf 'ERROR %s\n' "$*" >&2; exit 1; }
refuse() { printf 'REFUSED %s\n' "$*" >&2; exit 2; }

command="${1:-}"
[ -n "$command" ] || die "usage: engagement-api-alb-rules.sh <list|verify-baseline|create-preview|verify-preview|delete-preview>"

for var in AWS_REGION EXPECTED_AWS_ACCOUNT_ID HTTPS_LISTENER_ARN \
  ENGAGEMENT_TARGET_GROUP_ARN MAIN_API_TARGET_GROUP_ARN GENERIC_API_RULE_PRIORITY; do
  [ -n "${!var:-}" ] || die "$var is required"
done

OUT_DIR="${ENGAGEMENT_ALB_OUT_DIR:-.artifacts/engagement-phase2/${AWS_REGION}}"
mkdir -p "$OUT_DIR"

# Real files under OUT_DIR, never process substitution. `<(...)` hands node a
# POSIX /dev/fd/N path; a native Windows node.exe does not understand it and
# Git Bash mistranslates it into a nonexistent C:\dev\fd\N, so every read
# fails with ENOENT. Same failure class as the mktemp -d bug in
# engagement-api-infra-discover.sh — write real files, not virtual paths.
TMP_DIR="${OUT_DIR}/.tmp"
mkdir -p "$TMP_DIR"
write_json() {
  local name="$1" content="$2"
  local file="${TMP_DIR}/${name}.json"
  printf '%s' "$content" > "$file"
  printf '%s' "$file"
}

# ── the only allowed AWS calls, by exact command ─────────────────────────────
# Every command declares its own allowlist. A call outside it is refused
# before the AWS binary ever runs, so "this command cannot mutate anything
# else" is a property of the wrapper, not a promise about the code below it.
aws_call() {
  local operation="$1"
  shift
  case "$ALLOWED_OPERATIONS" in
    *" $operation "*) ;;
    *) refuse "operation '$operation' is not allowed by command '$command'" ;;
  esac
  "$AWS_BIN" elbv2 "$operation" --region "$AWS_REGION" "$@"
}

case "$command" in
  list | verify-baseline | verify-preview)
    ALLOWED_OPERATIONS=" describe-rules describe-target-groups "
    ;;
  create-preview)
    ALLOWED_OPERATIONS=" describe-rules describe-target-groups create-rule "
    ;;
  delete-preview)
    ALLOWED_OPERATIONS=" describe-rules describe-target-groups delete-rule "
    ;;
  *)
    die "unknown command '$command'"
    ;;
esac

# ── shared: caller identity, rule set, node-side JSON logic ─────────────────
verify_caller() {
  local account
  account="$("$AWS_BIN" sts get-caller-identity --region "$AWS_REGION" --query Account --output text)" ||
    die "could not verify AWS caller identity"
  [ "$account" = "$EXPECTED_AWS_ACCOUNT_ID" ] ||
    refuse "caller account ${account} does not match expected ${EXPECTED_AWS_ACCOUNT_ID}"
  assert_region_matches_arns
}

# Every configured ARN embeds its region as the 4th colon-separated segment.
# AWS_REGION is only ever used to pick an API endpoint — an operator exporting
# the wrong region would otherwise talk to a different region's API using
# ARNs from THIS one, which AWS itself may or may not reject depending on the
# call. Checking here makes the refusal immediate and specific.
assert_region_matches_arns() {
  local arn region_of_arn
  for arn in "$HTTPS_LISTENER_ARN" "$ENGAGEMENT_TARGET_GROUP_ARN" "$MAIN_API_TARGET_GROUP_ARN"; do
    region_of_arn="$(printf '%s' "$arn" | cut -d: -f4)"
    [ -n "$region_of_arn" ] || die "cannot parse region from ARN: $arn"
    [ "$region_of_arn" = "$AWS_REGION" ] ||
      refuse "AWS_REGION=${AWS_REGION} does not match the region embedded in ${arn}"
  done
}

fetch_rules() {
  aws_call describe-rules --listener-arn "$HTTPS_LISTENER_ARN" --output json
}

fetch_target_group() {
  aws_call describe-target-groups --target-group-arns "$ENGAGEMENT_TARGET_GROUP_ARN" --output json
}

# node-side analysis shared by verify-baseline, create-preview and delete-preview.
# Prints one JSON object with every derived fact; the caller inspects fields
# with jq-free node one-liners so no additional dependency is introduced.
analyze_rules() {
  local rules_json="$1"
  ENGAGEMENT_TARGET_GROUP_ARN="$ENGAGEMENT_TARGET_GROUP_ARN" \
    MAIN_API_TARGET_GROUP_ARN="$MAIN_API_TARGET_GROUP_ARN" \
    GENERIC_API_RULE_PRIORITY="$GENERIC_API_RULE_PRIORITY" \
    PREVIEW_RULE_PRIORITY="$PREVIEW_RULE_PRIORITY" \
    PREVIEW_HEADER_NAME="$PREVIEW_HEADER_NAME" \
    PREVIEW_HEADER_VALUE="$PREVIEW_HEADER_VALUE" \
    PREVIEW_PATH_PATTERN="$PREVIEW_PATH_PATTERN" \
    RECALL_PATH_PATTERN="$RECALL_PATH_PATTERN" \
    "$NODE_BIN" - "$rules_json" <<'NODE'
const { readFileSync } = require('node:fs');
const [file] = process.argv.slice(2);
const env = process.env;
const rules = JSON.parse(readFileSync(file, 'utf8')).Rules ?? [];

const valuesOf = (rule) =>
  (rule.Conditions ?? []).flatMap((c) => c.Values ?? c.PathPatternConfig?.Values ?? []);
const headersOf = (rule) =>
  (rule.Conditions ?? [])
    .filter((c) => c.Field === 'http-header')
    .map((c) => ({ name: c.HttpHeaderConfig?.HttpHeaderName, values: c.HttpHeaderConfig?.Values ?? [] }));
const targetGroupsOf = (rule) =>
  (rule.Actions ?? []).flatMap((a) =>
    a.TargetGroupArn ? [a.TargetGroupArn] : (a.ForwardConfig?.TargetGroups ?? []).map((t) => t.TargetGroupArn),
  );
const hasRewrite = (rule) => (rule.Actions ?? []).some((a) => a.Type && a.Type !== 'forward');
const hasWeighting = (rule) =>
  (rule.Actions ?? []).some((a) => (a.ForwardConfig?.TargetGroups ?? []).length > 1);

const previewPriority = String(env.PREVIEW_RULE_PRIORITY);
const genericPriority = String(env.GENERIC_API_RULE_PRIORITY);

const engagementRules = rules.filter((r) =>
  valuesOf(r).some((v) => String(v).startsWith('/api/engagement')),
);
const recallToEngagement = rules.filter(
  (r) =>
    valuesOf(r).some((v) => String(v) === env.RECALL_PATH_PATTERN) &&
    targetGroupsOf(r).includes(env.ENGAGEMENT_TARGET_GROUP_ARN),
);
const previewPriorityRule = rules.find((r) => String(r.Priority) === previewPriority);
const genericRule = rules.find((r) => String(r.Priority) === genericPriority);

const exactPreviewRule = rules.find((rule) => {
  if (String(rule.Priority) !== previewPriority) return false;
  const values = valuesOf(rule);
  const headers = headersOf(rule);
  const targetGroups = targetGroupsOf(rule);
  return (
    values.length === 1 &&
    values[0] === env.PREVIEW_PATH_PATTERN &&
    headers.length === 1 &&
    headers[0].name?.toLowerCase() === env.PREVIEW_HEADER_NAME.toLowerCase() &&
    headers[0].values.length === 1 &&
    headers[0].values[0] === env.PREVIEW_HEADER_VALUE &&
    targetGroups.length === 1 &&
    targetGroups[0] === env.ENGAGEMENT_TARGET_GROUP_ARN &&
    !hasRewrite(rule) &&
    !hasWeighting(rule)
  );
});

console.log(
  JSON.stringify({
    ruleCount: rules.length,
    previewPriorityOccupied: Boolean(previewPriorityRule),
    previewPriorityRuleArn: previewPriorityRule?.RuleArn ?? null,
    previewPriorityRuleIsExactMatch: Boolean(exactPreviewRule),
    exactPreviewRuleArn: exactPreviewRule?.RuleArn ?? null,
    genericRuleFound: Boolean(genericRule),
    genericRuleHasApiStar: genericRule ? valuesOf(genericRule).includes('/api/*') : false,
    genericRuleTargetGroups: genericRule ? targetGroupsOf(genericRule) : [],
    genericRuleTargetsOnlyMainApi: genericRule
      ? targetGroupsOf(genericRule).length === 1 &&
        targetGroupsOf(genericRule)[0] === env.MAIN_API_TARGET_GROUP_ARN
      : false,
    engagementRuleCount: engagementRules.length,
    engagementRuleArns: engagementRules.map((r) => r.RuleArn),
    recallToEngagementCount: recallToEngagement.length,
  }),
);
NODE
}

# ── list ──────────────────────────────────────────────────────────────────
cmd_list() {
  verify_caller
  local rules
  rules="$(fetch_rules)"
  echo "$rules" > "${OUT_DIR}/alb-rules-current.json"
  "$NODE_BIN" -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).Rules ?? [];
    for (const rule of r.sort((a, b) => Number(a.Priority) - Number(b.Priority))) {
      const conds = (rule.Conditions ?? []).map((c) =>
        c.Field === "http-header"
          ? `header:${c.HttpHeaderConfig?.HttpHeaderName}=${(c.HttpHeaderConfig?.Values ?? []).join(",")}`
          : `path:${(c.Values ?? c.PathPatternConfig?.Values ?? []).join(",")}`,
      ).join(" AND ");
      const targets = (rule.Actions ?? []).flatMap((a) =>
        a.TargetGroupArn ? [a.TargetGroupArn] : (a.ForwardConfig?.TargetGroups ?? []).map((t) => t.TargetGroupArn),
      );
      console.log(`priority=${rule.Priority}  ${conds || "(default)"}  -> ${targets.join(",") || "(none)"}`);
    }
  ' "${OUT_DIR}/alb-rules-current.json"
}

# ── verify-baseline: the 12 pre-create checks ────────────────────────────────
cmd_verify_baseline() {
  verify_caller

  local target_group_json target_group_ok
  target_group_json="$(fetch_target_group)"
  target_group_ok="$("$NODE_BIN" -e '
    const g = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).TargetGroups?.[0];
    if (!g) { console.log("false:not found"); process.exit(0); }
    const nameOk = /engagement-api/i.test(g.TargetGroupName ?? "");
    const portOk = g.Port === 4500;
    console.log(`${nameOk && portOk}:name=${g.TargetGroupName} port=${g.Port}`);
  ' "$(write_json target-group "$target_group_json")")"
  local target_group_pass="${target_group_ok%%:*}"
  local target_group_detail="${target_group_ok#*:}"

  local rules_json analysis
  rules_json="$(fetch_rules)"
  analysis="$(analyze_rules "$(write_json rules "$rules_json")")"
  echo "$analysis" > "${OUT_DIR}/verify-baseline.json"

  local failures=0
  check() {
    local ok="$1" message="$2"
    if [ "$ok" = "true" ]; then
      echo "  OK    $message"
    else
      echo "  FAIL  $message"
      failures=$((failures + 1))
    fi
  }

  local field
  field() { "$NODE_BIN" -e 'console.log(JSON.parse(process.argv[2])[process.argv[1]])' "$1" "$analysis"; }

  echo "1-2. caller/account verified, listener rules described"
  check "true" "AWS caller and account verified"

  check "$([ "$(field previewPriorityOccupied)" = "false" ] && echo true || echo false)" \
    "preview priority ${PREVIEW_RULE_PRIORITY} is unoccupied"
  check "$(field genericRuleFound)" "generic API rule at priority ${GENERIC_API_RULE_PRIORITY} exists"
  check "$(field genericRuleHasApiStar)" "generic API rule includes /api/*"
  check "$(field genericRuleTargetsOnlyMainApi)" "generic API rule forwards only to the main API target group"
  check "$([ "$(field engagementRuleCount)" = "0" ] && echo true || echo false)" \
    "no existing rule matches /api/engagement/*"
  check "$([ "$(field recallToEngagementCount)" = "0" ] && echo true || echo false)" \
    "no rule routes /webhooks/recall to engagement-api"
  check "$target_group_pass" "target group belongs to engagement-api and uses port 4500 ($target_group_detail)"

  echo "12. current web/main API health: not checked by this script — run the live acceptance harness first"

  if [ "$failures" -gt 0 ]; then
    refuse "$failures baseline check(s) failed; see ${OUT_DIR}/verify-baseline.json"
  fi
  echo "ENGAGEMENT_ALB_BASELINE_CLEAN"
}

# ── create-preview ────────────────────────────────────────────────────────
cmd_create_preview() {
  local expected_token="${EXPECTED_AWS_ACCOUNT_ID}:${AWS_REGION}:${PREVIEW_RULE_PRIORITY}"
  [ "${CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE:-}" = "$expected_token" ] ||
    die "set CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE=${expected_token} to create the preview rule"

  verify_caller

  local target_group_json target_group_ok
  target_group_json="$(fetch_target_group)"
  target_group_ok="$("$NODE_BIN" -e '
    const g = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).TargetGroups?.[0];
    if (!g) { console.log("false:not found"); process.exit(0); }
    const nameOk = /engagement-api/i.test(g.TargetGroupName ?? "");
    const portOk = g.Port === 4500;
    console.log(`${nameOk && portOk}:name=${g.TargetGroupName} port=${g.Port}`);
  ' "$(write_json target-group "$target_group_json")")"
  [ "${target_group_ok%%:*}" = "true" ] ||
    refuse "ENGAGEMENT_TARGET_GROUP_ARN does not resolve to an engagement-api target group on port 4500 (${target_group_ok#*:})"

  local rules_json analysis
  rules_json="$(fetch_rules)"
  analysis="$(analyze_rules "$(write_json rules "$rules_json")")"
  field() { "$NODE_BIN" -e 'console.log(JSON.parse(process.argv[2])[process.argv[1]])' "$1" "$analysis"; }

  [ "$(field previewPriorityOccupied)" = "false" ] ||
    refuse "priority ${PREVIEW_RULE_PRIORITY} is already occupied — run verify-baseline"
  [ "$(field genericRuleTargetsOnlyMainApi)" = "true" ] ||
    refuse "generic API rule has drifted from the expected main API target group"
  [ "$(field engagementRuleCount)" = "0" ] ||
    refuse "a rule already matches /api/engagement/* — run verify-baseline"
  [ "$(field recallToEngagementCount)" = "0" ] ||
    refuse "a rule already routes Recall to engagement-api"

  echo "==> creating exact preview rule: priority ${PREVIEW_RULE_PRIORITY}"
  local created
  created="$(aws_call create-rule \
    --listener-arn "$HTTPS_LISTENER_ARN" \
    --priority "$PREVIEW_RULE_PRIORITY" \
    --conditions "$(build_conditions_json)" \
    --actions "$(build_actions_json)" \
    --output json)" || refuse "create-rule failed"

  echo "$created" > "${OUT_DIR}/preview-rule-created.json"
  echo "ENGAGEMENT_PREVIEW_RULE_CREATED"
}

build_conditions_json() {
  cat <<JSON
[{"Field":"path-pattern","PathPatternConfig":{"Values":["${PREVIEW_PATH_PATTERN}"]}},{"Field":"http-header","HttpHeaderConfig":{"HttpHeaderName":"${PREVIEW_HEADER_NAME}","Values":["${PREVIEW_HEADER_VALUE}"]}}]
JSON
}

build_actions_json() {
  cat <<JSON
[{"Type":"forward","TargetGroupArn":"${ENGAGEMENT_TARGET_GROUP_ARN}"}]
JSON
}

# ── verify-preview ───────────────────────────────────────────────────────
cmd_verify_preview() {
  verify_caller
  local rules_json analysis
  rules_json="$(fetch_rules)"
  analysis="$(analyze_rules "$(write_json rules "$rules_json")")"
  echo "$analysis" > "${OUT_DIR}/verify-preview.json"
  field() { "$NODE_BIN" -e 'console.log(JSON.parse(process.argv[2])[process.argv[1]])' "$1" "$analysis"; }

  [ "$(field previewPriorityRuleIsExactMatch)" = "true" ] ||
    refuse "the rule at priority ${PREVIEW_RULE_PRIORITY} is not the exact expected shape"
  [ "$(field engagementRuleCount)" = "1" ] ||
    refuse "expected exactly one /api/engagement/* rule, found $(field engagementRuleCount)"

  echo "verified exact rule: $(field exactPreviewRuleArn)"
  echo "ENGAGEMENT_PREVIEW_RULE_VERIFIED"
}

# ── delete-preview ────────────────────────────────────────────────────────
cmd_delete_preview() {
  local target="${CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE:-}"
  [ -n "$target" ] || die "set CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE=<exact-rule-arn> to delete"

  verify_caller
  local rules_json analysis
  rules_json="$(fetch_rules)"
  analysis="$(analyze_rules "$(write_json rules "$rules_json")")"
  field() { "$NODE_BIN" -e 'console.log(JSON.parse(process.argv[2])[process.argv[1]])' "$1" "$analysis"; }

  local exact_arn
  exact_arn="$(field exactPreviewRuleArn)"

  [ "$target" = "$exact_arn" ] ||
    refuse "CONFIRM_ENGAGEMENT_PREVIEW_RULE_DELETE (${target}) does not equal the exact expected rule (${exact_arn:-none}); the rule may have drifted — refusing to delete"

  echo "$rules_json" > "${OUT_DIR}/preview-rule-before-delete.json"

  echo "==> deleting exactly ${target}"
  aws_call delete-rule --rule-arn "$target" >/dev/null || refuse "delete-rule failed"

  local after_json after_analysis
  after_json="$("$AWS_BIN" elbv2 describe-rules --listener-arn "$HTTPS_LISTENER_ARN" --region "$AWS_REGION" --output json 2>/dev/null)" || true
  if [ -n "$after_json" ]; then
    after_analysis="$(analyze_rules "$(write_json after-rules "$after_json")")"
    local generic_ok
    generic_ok="$("$NODE_BIN" -e 'console.log(JSON.parse(process.argv[2])[process.argv[1]])' genericRuleTargetsOnlyMainApi "$after_analysis")"
    [ "$generic_ok" = "true" ] || refuse "post-delete: the generic API rule no longer targets only the main API — investigate before proceeding"
  fi

  echo "ENGAGEMENT_PREVIEW_RULE_DELETED"
}

case "$command" in
  list) cmd_list ;;
  verify-baseline) cmd_verify_baseline ;;
  create-preview) cmd_create_preview ;;
  verify-preview) cmd_verify_preview ;;
  delete-preview) cmd_delete_preview ;;
esac
