#!/usr/bin/env bash
#
# Onboard API — ALB listener rules (out-of-band, like workspace / meriv2 /
# intel-api). The prod ALB (capiro-prod-alb) is hand-managed: rules are NOT in
# CloudFormation and a `cdk deploy` must never own them.
#
# Adds two rules on the HTTPS listener:
#   priority 9   host-header onboarding.capiro.ai -> onboard-api TG (SPA + API)
#   priority 16  path /onboard-api/*              -> onboard-api TG (API from app.capiro.ai)
#
# Shared priority reservation: infra/routing/capiro-prod-alb-priorities.json.
# These defaults describe the SOURCE CANDIDATE, not the current live listener.
# The reviewed operator sequence must move the existing physical rules in place
# before this script's mutating modes are used. ALWAYS re-check with --list.
#
# Usage:
#   scripts/onboard-alb-rules.sh --list
#   scripts/onboard-alb-rules.sh --create <TARGET_GROUP_ARN>
#   scripts/onboard-alb-rules.sh --delete
#
# Env overrides: ALB_NAME (default capiro-prod-alb), REGION, HOST, PATH_PATTERN.
set -euo pipefail
export MSYS_NO_PATHCONV=1

ALB_NAME="${ALB_NAME:-capiro-prod-alb}"
REGION="${REGION:-us-east-1}"
HOST="${HOST:-onboarding.capiro.ai}"
PATH_PATTERN="${PATH_PATTERN:-/onboard-api/*}"
HOST_PRIORITY="${HOST_PRIORITY:-9}"
PATH_PRIORITY="${PATH_PRIORITY:-16}"

listener_arn() {
  local alb_arn
  alb_arn=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$REGION" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  aws elbv2 describe-listeners --load-balancer-arn "$alb_arn" --region "$REGION" \
    --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text
}

assert_reserved_priorities() {
  if [ "$HOST_PRIORITY" != 9 ] || [ "$PATH_PRIORITY" != 16 ]; then
    echo "!! shared-listener source reserves onboard host 9 and path 16; refusing priority override" >&2
    exit 1
  fi
}

case "${1:-}" in
  --list)
    L=$(listener_arn)
    echo "HTTPS listener: $L"
    aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" \
      --query 'Rules[].{P:Priority,Cond:Conditions[].Values|[]|join(`,`,@),TG:Actions[0].TargetGroupArn}' \
      --output table
    ;;
  --create)
    assert_reserved_priorities
    TG_ARN="${2:?target group ARN required}"
    L=$(listener_arn)
    echo "Creating rules on $L -> $TG_ARN"
    # Fail loudly if the priorities are taken (never clobber existing rules).
    TAKEN=$(aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" \
      --query "Rules[?Priority=='${HOST_PRIORITY}' || Priority=='${PATH_PRIORITY}'].Priority" --output text)
    if [ -n "$TAKEN" ]; then
      echo "!! priorities already in use: $TAKEN - stop, run --list, and follow the reviewed relocation/readback procedure"; exit 1
    fi
    aws elbv2 create-rule --listener-arn "$L" --region "$REGION" --priority "$HOST_PRIORITY" \
      --conditions "Field=host-header,Values=$HOST" \
      --actions "Type=forward,TargetGroupArn=$TG_ARN"
    aws elbv2 create-rule --listener-arn "$L" --region "$REGION" --priority "$PATH_PRIORITY" \
      --conditions "Field=path-pattern,Values=$PATH_PATTERN" \
      --actions "Type=forward,TargetGroupArn=$TG_ARN"
    echo "Created. Verify routing:"
    echo "  curl -s -o /dev/null -w '%{http_code}' https://$HOST/health   # expect 200 (health sits outside the prefix)"
    echo "  curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai/onboard-api/public/config  # expect 200"
    echo "  curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai/api/health   # expect 200 (unchanged)"
    ;;
  --delete)
    assert_reserved_priorities
    L=$(listener_arn)
    # Validate BOTH physical rules before either delete. In particular, the
    # old live priority 9 is a path rule; deleting by priority+target alone
    # would remove it while mistaking it for the proposed host rule.
    RULES_JSON=$(aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" --output json)
    SNAPSHOT_JSON=$(cat "$(dirname -- "${BASH_SOURCE[0]}")/../infra/routing/capiro-prod-alb-snapshot.json")
    VERIFIED_ARNS=$(RULES_JSON="$RULES_JSON" HOST_PRIORITY="$HOST_PRIORITY" \
      SNAPSHOT_JSON="$SNAPSHOT_JSON" LISTENER_ARN="$L" \
      PATH_PRIORITY="$PATH_PRIORITY" HOST="$HOST" PATH_PATTERN="$PATH_PATTERN" node <<'NODE'
const rules = JSON.parse(process.env.RULES_JSON).Rules;
const snapshot = JSON.parse(process.env.SNAPSHOT_JSON);
if (process.env.LISTENER_ARN !== snapshot.listenerArn) {
  console.error('!! listener differs from the pinned snapshot - refusing to delete');
  process.exit(1);
}
const targetArn = snapshot.targetGroupArns['onboard-api'];
const ruleArn = (id) =>
  `${snapshot.listenerArn.replace(':listener/', ':listener-rule/')}/${snapshot.ruleArnSuffixes[id]}`;
function owned(priority, field, value, expectedArn) {
  const matches = rules.filter((rule) => String(rule.Priority) === priority);
  if (matches.length !== 1) throw new Error(`priority ${priority} is not unique`);
  const rule = matches[0];
  const conditions = rule.Conditions ?? [];
  const condition = conditions[0];
  const values = condition?.Values ?? condition?.HostHeaderConfig?.Values ??
    condition?.PathPatternConfig?.Values;
  const actions = rule.Actions ?? [];
  const target = actions[0]?.TargetGroupArn;
  if (conditions.length !== 1 || condition?.Field !== field ||
      JSON.stringify(values) !== JSON.stringify([value]) ||
      actions.length !== 1 || actions[0]?.Type !== 'forward' ||
      target !== targetArn || rule.RuleArn !== expectedArn) {
    throw new Error(`priority ${priority} is not the exact onboard rule`);
  }
  return { arn: rule.RuleArn, target };
}
try {
  const host = owned(process.env.HOST_PRIORITY, 'host-header', process.env.HOST, ruleArn('onboard-host'));
  const path = owned(process.env.PATH_PRIORITY, 'path-pattern', process.env.PATH_PATTERN, ruleArn('onboard-path'));
  if (host.target !== path.target) throw new Error('onboard target groups differ');
  console.log(host.arn);
  console.log(path.arn);
} catch (error) {
  console.error(`!! ${error.message} - refusing to delete`);
  process.exitCode = 1;
}
NODE
    ) || exit 1
    HOST_RULE_ARN=${VERIFIED_ARNS%%$'\n'*}
    PATH_RULE_ARN=${VERIFIED_ARNS#*$'\n'}
    aws elbv2 delete-rule --rule-arn "$HOST_RULE_ARN" --region "$REGION"
    aws elbv2 delete-rule --rule-arn "$PATH_RULE_ARN" --region "$REGION"
    echo "deleted exact onboard rules at priorities $HOST_PRIORITY and $PATH_PRIORITY"
    ;;
  *)
    echo "usage: $0 --list | --create <TG_ARN> | --delete"; exit 2 ;;
esac
