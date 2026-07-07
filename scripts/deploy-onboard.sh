#!/usr/bin/env bash
#
# Capiro onboard-api deploy — SAFE ORDERING enforced (mirrors deploy-dev.sh).
# ============================================================================
# CI (onboard-api-image.yml) builds and pushes :latest to ECR on merge to main
# but does NOT deploy and does NOT run migrations. Ordering invariant:
#
#     1. (image already in ECR via CI, or build+push with --build)
#     2. MIGRATE   — run the onboard migrate task, wait for STOP exit 0
#     3. ROLL      — force-new-deployment on capiro-dev-onboard-api,
#                    wait services-stable
#
# `prisma migrate deploy` is IDEMPOTENT; always migrate before rolling.
#
# Usage:
#   scripts/deploy-onboard.sh                # migrate, then roll onboard-api
#   scripts/deploy-onboard.sh --build        # build+push arm64 image locally first
#   scripts/deploy-onboard.sh --migrate-only # just apply migrations and exit
#   scripts/deploy-onboard.sh --serve-only   # roll only (NO migrate — use when
#                                            #   migrations are known-applied)
#   scripts/deploy-onboard.sh --dry-run      # print what it would do
#
# Env: ACCOUNT 967807252336 · REGION us-east-1 · CLUSTER capiro-dev · arm64
# ============================================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1

ACCOUNT="967807252336"
REGION="us-east-1"
CLUSTER="${CLUSTER:-capiro-dev}"
ECR="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
SVC="${ONBOARD_SVC:-capiro-dev-onboard-api}"
MIGRATE_TD="${ONBOARD_MIGRATE_TD:-capiro-dev-onboard-api-migrate}"
LOG_GROUP="/capiro/dev/onboard-api"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DO_BUILD=false; DO_MIGRATE=true; DO_SERVE=true; DRY=false
case "${1:-}" in
  --build)        DO_BUILD=true ;;
  --migrate-only) DO_SERVE=false ;;
  --serve-only)   DO_MIGRATE=false ;;
  --dry-run)      DRY=true ;;
  "")             ;;
  *) echo "unknown flag: $1"; exit 2 ;;
esac

log(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
run(){ if $DRY; then echo "DRY: $*"; else eval "$*"; fi; }

log "Preflight"
aws sts get-caller-identity --query 'Account' --output text | grep -qx "$ACCOUNT" \
  || { echo "WRONG AWS ACCOUNT (expected $ACCOUNT). Aborting."; exit 1; }
GIT_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
echo "deploying from git $GIT_SHA"

if $DO_BUILD; then
  log "Build + push arm64 onboard-api image to ECR"
  run "aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR"
  run "docker buildx build --platform linux/arm64 -f $REPO_ROOT/apps/onboard-api/Dockerfile \
        -t $ECR/capiro/dev/onboard-api:latest -t $ECR/capiro/dev/onboard-api:$GIT_SHA --push $REPO_ROOT"
else
  echo "(skipping local build — assuming CI already pushed :latest for $GIT_SHA)"
fi

if $DO_MIGRATE; then
  log "Apply onboard DB migrations (prisma migrate deploy) BEFORE service roll"
  NET=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" \
        --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)
  SUBNETS=$(echo "$NET" | jq -r '.subnets|join(",")')
  SGS=$(echo "$NET"     | jq -r '.securityGroups|join(",")')
  NETCFG="awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SGS],assignPublicIp=DISABLED}"
  if $DRY; then
    echo "DRY: run-task $MIGRATE_TD with $NETCFG"
  else
    TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
      --task-definition "$MIGRATE_TD" \
      --network-configuration "$NETCFG" \
      --query 'tasks[0].taskArn' --output text)
    TID="${TASK_ARN##*/}"
    echo "migrate task: $TID — waiting for STOP (up to 30 min)..."
    DEADLINE=$(( $(date +%s) + 1800 ))
    while :; do
      ST=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TID" \
             --query 'tasks[0].lastStatus' --output text 2>/dev/null || echo UNKNOWN)
      [ "$ST" = "STOPPED" ] && break
      if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "!! migrate task did not STOP within 30 min (last status: $ST). NOT rolling."
        exit 1
      fi
      sleep 10
    done
    EXIT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TID" \
           --query 'tasks[0].containers[0].exitCode' --output text)
    echo "migrate exit code: $EXIT"
    if [ "$EXIT" != "0" ]; then
      echo "!! MIGRATION FAILED (exit $EXIT). NOT rolling. Inspect:"
      echo "   aws logs get-log-events --log-group-name $LOG_GROUP \\"
      echo "     --log-stream-name onboard-api-migrate/onboard-api-migrate/$TID --start-from-head"
      exit 1
    fi
    aws logs get-log-events --log-group-name "$LOG_GROUP" \
      --log-stream-name "onboard-api-migrate/onboard-api-migrate/$TID" --start-from-head \
      --query 'events[*].message' --output text 2>/dev/null \
      | grep -Ei 'applying migration|successfully applied|No pending' | tail -5 || true
  fi
fi

if $DO_SERVE; then
  log "Force new deployment: $SVC"
  run "aws ecs update-service --cluster $CLUSTER --service $SVC --force-new-deployment >/dev/null"
  if ! $DRY; then
    echo "waiting for $SVC to reach steady state..."
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$SVC"
    echo "$SVC stable."
  fi
fi

log "Done. Verify:"
cat <<'EOF'
  curl -s https://onboarding.capiro.ai/onboard-api/health          # {"ok":true,...}
  curl -s https://app.capiro.ai/onboard-api/health                 # {"ok":true,...}
  curl -s -o /dev/null -w '%{http_code}\n' https://app.capiro.ai/api/health  # 200 (unchanged)
  MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name /capiro/dev/onboard-api \
    --start-time $(( $(date +%s)000 - 300000 )) \
    --filter-pattern '?ExceptionsHandler ?PrismaClientKnownRequestError' \
    --query 'length(events)' --output text     # expect 0
EOF
