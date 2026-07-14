#!/usr/bin/env bash
#
# MeriV2 orchestrator — ALB listener rule (out-of-band, like onboard / workspace
# / intel-api). The prod ALB (capiro-prod-alb) is hand-managed: its rules are
# NOT in CloudFormation and a `cdk deploy` must never own them (the CDK
# ComputeStack attaches an equivalent MeriApi rule to a DIFFERENT, deleted
# phantom ALB — see compute-stack.ts). This script codifies the real prod rule
# so it can be re-created for DR without archaeology.
#
# Adds ONE rule on the HTTPS listener:
#   priority 13  path /meri-api/*  -> capiro-prod-meriv2-orch-tg
#
# LIVE-VERIFIED 2026-07-14 (`aws elbv2 describe-rules` on capiro-prod-alb 443):
#   8  onboarding.capiro.ai   9 /onboard-api/*   10 /api/*   12 /workspace-api/*
#   13 /meri-api/*            14 /intel-api/*    15 /webhooks/*   20 capiro.ai
#   default -> web
# `/meri-api/*` anchors at the path start, so it does not collide with /api/*.
# ALWAYS re-check with --list before --create; the target group name
# capiro-prod-meriv2-orch-tg is 26 chars (AWS's TG-name cap is 32 — the CDK
# comment's "…orchestrator-tg" at 34 chars is impossible and was never real).
#
# Usage:
#   scripts/meri-alb-rules.sh --list
#   scripts/meri-alb-rules.sh --create <TARGET_GROUP_ARN>   # DR / re-create only; the rule already exists
#   scripts/meri-alb-rules.sh --delete
#
# Env overrides: ALB_NAME (default capiro-prod-alb), REGION, PATH_PATTERN, PATH_PRIORITY.
set -euo pipefail
export MSYS_NO_PATHCONV=1

ALB_NAME="${ALB_NAME:-capiro-prod-alb}"
REGION="${REGION:-us-east-1}"
PATH_PATTERN="${PATH_PATTERN:-/meri-api/*}"
PATH_PRIORITY="${PATH_PRIORITY:-13}"

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
    TG_ARN="${2:?target group ARN required (expected a *meriv2* / *meri-orch* TG)}"
    L=$(listener_arn)
    echo "Creating rule on $L -> $TG_ARN"
    # Fail loudly if the priority is taken (never clobber existing rules).
    TAKEN=$(aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" \
      --query "Rules[?Priority=='${PATH_PRIORITY}'].Priority" --output text)
    if [ -n "$TAKEN" ]; then
      echo "!! priority ${PATH_PRIORITY} already in use — run --list and pick a free one via PATH_PRIORITY env"; exit 1
    fi
    aws elbv2 create-rule --listener-arn "$L" --region "$REGION" --priority "$PATH_PRIORITY" \
      --conditions "Field=path-pattern,Values=$PATH_PATTERN" \
      --actions "Type=forward,TargetGroupArn=$TG_ARN"
    echo "Created. Verify routing:"
    echo "  curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai/meri-api/health   # expect 200"
    echo "  curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai/meri-api/tools    # expect 401 (no JWT)"
    ;;
  --delete)
    L=$(listener_arn)
    R=$(aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" \
      --query "Rules[?Priority=='$PATH_PRIORITY'].RuleArn | [0]" --output text)
    if [ "$R" != "None" ] && [ -n "$R" ]; then
      # Safety: only delete if the rule targets a meriv2 orchestrator TG.
      TG=$(aws elbv2 describe-rules --listener-arn "$L" --region "$REGION" \
        --query "Rules[?Priority=='$PATH_PRIORITY'].Actions[0].TargetGroupArn | [0]" --output text)
      case "$TG" in
        *meriv2*|*meri-orch*) aws elbv2 delete-rule --rule-arn "$R" --region "$REGION"; echo "deleted priority $PATH_PRIORITY" ;;
        *) echo "!! priority $PATH_PRIORITY targets $TG (not a meriv2 orchestrator TG) — refusing to delete"; exit 1 ;;
      esac
    else
      echo "no rule at priority $PATH_PRIORITY"
    fi
    ;;
  *)
    echo "usage: $0 --list | --create <TG_ARN> | --delete"; exit 2 ;;
esac
