#!/usr/bin/env bash
#
# Onboard API — ALB listener rules (out-of-band, like workspace / meriv2 /
# intel-api). The prod ALB (capiro-prod-alb) is hand-managed: rules are NOT in
# CloudFormation and a `cdk deploy` must never own them.
#
# Adds two rules on the HTTPS listener:
#   priority 8  host-header onboarding.capiro.ai  -> onboard-api TG (SPA + API)
#   priority 9  path /onboard-api/*               -> onboard-api TG (API from app.capiro.ai)
#
# `/onboard-api/*` does NOT collide with the existing priority-3 rule
# (`/api/*`, `/webhooks/*`, `/health`): ALB path patterns anchor at the path
# start, and `/onboard-api/...` does not match `/api/*`. Verified priorities
# free as of 2026-07-06: 3 (api), 5 (marketing), 15 (meri), 20 (web default),
# plus the workspace rule — ALWAYS re-check with --list before --create.
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
HOST_PRIORITY="${HOST_PRIORITY:-8}"
PATH_PRIORITY="${PATH_PRIORITY:-9}"

listener_arn() {
  local alb_arn
  alb_arn=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$REGION" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  aws elbv2 describe-listeners --load-balancer-arn "$alb_arn" --region "$REGION" \
    --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text
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
    TG_ARN="${2:?target group ARN required}"
    L=$(listener_arn)
    echo "Creating rules on $L -> $TG_ARN"
    # Fail loudly if the priorities are taken (never clobber existing rules).
    TAKEN=$(aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" \
      --query "Rules[?Priority=='${HOST_PRIORITY}' || Priority=='${PATH_PRIORITY}'].Priority" --output text)
    if [ -n "$TAKEN" ]; then
      echo "!! priorities already in use: $TAKEN — run --list and pick free ones via HOST_PRIORITY/PATH_PRIORITY env"; exit 1
    fi
    aws elbv2 create-rule --listener-arn "$L" --region "$REGION" --priority "$HOST_PRIORITY" \
      --conditions "Field=host-header,Values=$HOST" \
      --actions "Type=forward,TargetGroupArn=$TG_ARN"
    aws elbv2 create-rule --listener-arn "$L" --region "$REGION" --priority "$PATH_PRIORITY" \
      --conditions "Field=path-pattern,Values=$PATH_PATTERN" \
      --actions "Type=forward,TargetGroupArn=$TG_ARN"
    echo "Created. Verify routing:"
    echo "  curl -s -o /dev/null -w '%{http_code}' https://$HOST/onboard-api/health   # expect 200"
    echo "  curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai/onboard-api/health  # expect 200"
    echo "  curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai/api/health   # expect 200 (unchanged)"
    ;;
  --delete)
    L=$(listener_arn)
    for P in "$HOST_PRIORITY" "$PATH_PRIORITY"; do
      R=$(aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" \
        --query "Rules[?Priority=='$P'].RuleArn | [0]" --output text)
      if [ "$R" != "None" ] && [ -n "$R" ]; then
        # Safety: only delete if the rule targets an onboard-api TG.
        TG=$(aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" \
          --query "Rules[?Priority=='$P'].Actions[0].TargetGroupArn | [0]" --output text)
        case "$TG" in
          *onboard*) aws elbv2 delete-rule --rule-arn "$R" --region "$REGION"; echo "deleted priority $P" ;;
          *) echo "!! priority $P targets $TG (not onboard) — refusing to delete"; exit 1 ;;
        esac
      fi
    done
    ;;
  *)
    echo "usage: $0 --list | --create <TG_ARN> | --delete"; exit 2 ;;
esac
