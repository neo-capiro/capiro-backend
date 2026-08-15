#!/usr/bin/env bash
#
# Capiro dev deploy — SAFE ORDERING enforced.
# ============================================================================
# Why this script exists
# ----------------------------------------------------------------------------
# CI (api-image.yml / web-image.yml) builds and pushes the :latest images to
# ECR on merge to main, but it DOES NOT deploy and DOES NOT run migrations.
# A human then has to roll the ECS services — and if a merged PR added a DB
# column, rolling the API BEFORE applying the migration makes the new code
# SELECT a column that doesn't exist yet → every affected query 500s in prod.
# (This bit us on `meetings.is_internal`, 2026-06-07.)
#
# The fix is an ordering invariant, not detection logic:
#
#     1. (image already in ECR via CI, or build+push with --build)
#     2. MIGRATE   — apply pending migrations, wait for STOP success
#     3. API ROLL  — force-new-deployment, wait services-stable
#     4. WEB ROLL  — force-new-deployment, wait services-stable (order-independent)
#
# `prisma migrate deploy` is IDEMPOTENT: when nothing is pending it's a no-op.
# So we ALWAYS migrate before rolling the API — there's no "does this PR have a
# migration?" decision to get wrong. Migrating first is always safe; rolling
# first is sometimes catastrophic.
#
# Usage
# ----------------------------------------------------------------------------
#   scripts/deploy-dev.sh                 # migrate, then roll api + web (uses CI-pushed :latest)
#   scripts/deploy-dev.sh --api-only      # migrate, then roll api only
#   scripts/deploy-dev.sh --web-only       # roll web only (NO migrate, NO api roll)
#   scripts/deploy-dev.sh --build          # build+push arm64 api & web images locally first
#   scripts/deploy-dev.sh --migrate-only   # just apply migrations and exit
#   scripts/deploy-dev.sh --dry-run        # print what it would do, touch nothing
#
# Env: ACCOUNT 967807252336 · REGION us-east-1 · CLUSTER capiro-dev · arch arm64
# Requires: aws cli v2, jq, (docker only with --build), git-bash/MSYS on Windows.
# On Windows/MSYS, MSYS_NO_PATHCONV=1 is exported for you (ARN colons survive).
# ============================================================================
set -euo pipefail
export MSYS_NO_PATHCONV=1

# ---- config ----------------------------------------------------------------
ACCOUNT="967807252336"
REGION="us-east-1"
CLUSTER="capiro-dev"
ECR="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
API_SVC="capiro-dev-api"
WEB_SVC="capiro-dev-web"
MIGRATE_TD="capiro-dev-api-admin-migrate"   # task def family; latest ACTIVE revision is used
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- flags -----------------------------------------------------------------
DO_BUILD=false; DO_API=true; DO_WEB=true; DO_MIGRATE=true; DRY=false
case "${1:-}" in
  --build)        DO_BUILD=true ;;
  --api-only)     DO_WEB=false ;;
  --web-only)     DO_API=false; DO_MIGRATE=false ;;   # web is order-independent, no schema dep
  --migrate-only) DO_API=false; DO_WEB=false ;;
  --dry-run)      DRY=true ;;
  "")             ;;
  *) echo "unknown flag: $1"; sed -n '30,40p' "$0"; exit 2 ;;
esac

log(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
run(){ if $DRY; then echo "DRY: $*"; else eval "$*"; fi; }

# ---- 0. preflight (read-only) ---------------------------------------------
log "Preflight"
aws sts get-caller-identity --query 'Account' --output text | grep -qx "$ACCOUNT" \
  || { echo "WRONG AWS ACCOUNT (expected $ACCOUNT). Aborting."; exit 1; }
APP_HTTP=$(curl -s -o /dev/null -w '%{http_code}' https://app.capiro.ai || echo 000)
echo "app.capiro.ai -> HTTP $APP_HTTP"
# `cd` then plain `git`, NOT `git -C "$REPO_ROOT"`. MSYS_NO_PATHCONV=1 above is
# required so ECS ARN colons survive, but it also stops MSYS rewriting POSIX
# paths for native binaries — so Windows git.exe receives a literal
# `/c/Users/...` for -C and fails with "cannot change to". The failure is
# swallowed by `|| echo unknown`, and with --build that silently tags and pushes
# the images as `:unknown`, destroying the SHA→image traceability this script
# exists to protect. `cd` is a bash builtin, so no conversion is involved.
GIT_SHA=$( (cd "$REPO_ROOT" && git rev-parse --short HEAD) 2>/dev/null || echo unknown)
echo "deploying from git $GIT_SHA"

# ---- 1. (optional) build + push arm64 images -------------------------------
if $DO_BUILD; then
  log "Build + push arm64 images (api + web) to ECR"
  run "aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR"
  # IMPORTANT: Fargate here is arm64. Never push an amd64 :latest.
  run "docker buildx build --platform linux/arm64 -f $REPO_ROOT/apps/api/Dockerfile \
        -t $ECR/capiro/dev/api:latest -t $ECR/capiro/dev/api:$GIT_SHA --push $REPO_ROOT"
  run "docker buildx build --platform linux/arm64 -f $REPO_ROOT/apps/web/Dockerfile \
        --build-arg GIT_SHA=$GIT_SHA \
        -t $ECR/capiro/dev/web:latest -t $ECR/capiro/dev/web:$GIT_SHA --push $REPO_ROOT"
else
  echo "(skipping local build — assuming CI already pushed :latest for $GIT_SHA)"
fi

# ---- 2. MIGRATE (always before API roll; idempotent if nothing pending) ----
if $DO_MIGRATE; then
  log "Apply DB migrations (prisma migrate deploy) — runs to completion BEFORE API roll"
  NET=$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" \
        --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)
  SUBNETS=$(echo "$NET" | jq -r '.subnets|join(",")')
  SGS=$(echo "$NET"     | jq -r '.securityGroups|join(",")')
  NETCFG="awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SGS],assignPublicIp=DISABLED}"
  if $DRY; then
    echo "DRY: run-task $MIGRATE_TD (latest revision) with $NETCFG"
  else
    TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
      --task-definition "$MIGRATE_TD" \
      --network-configuration "$NETCFG" \
      --query 'tasks[0].taskArn' --output text)
    TID="${TASK_ARN##*/}"
    # Poll instead of `aws ecs wait tasks-stopped` (whose fixed ~600s budget can
    # expire on a slow Fargate image pull, aborting a deploy whose migration is
    # actually fine). Wait up to 30 min for the task to STOP.
    echo "migrate task: $TID — waiting for STOP (up to 30 min)..."
    DEADLINE=$(( $(date +%s) + 1800 ))
    while :; do
      ST=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TID" \
             --query 'tasks[0].lastStatus' --output text 2>/dev/null || echo UNKNOWN)
      [ "$ST" = "STOPPED" ] && break
      if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "!! migrate task did not STOP within 30 min (last status: $ST). NOT rolling the API."
        exit 1
      fi
      sleep 10
    done
    EXIT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TID" \
           --query 'tasks[0].containers[0].exitCode' --output text)
    echo "migrate exit code: $EXIT"
    if [ "$EXIT" != "0" ]; then
      echo "!! MIGRATION FAILED (exit $EXIT). NOT rolling the API. Inspect:"
      echo "   aws logs get-log-events --log-group-name /capiro/dev/api \\"
      echo "     --log-stream-name api/api-admin-migrate/$TID --start-from-head"
      exit 1
    fi
    # surface the applied-migrations summary
    aws logs get-log-events --log-group-name /capiro/dev/api \
      --log-stream-name "api/api-admin-migrate/$TID" --start-from-head \
      --query 'events[*].message' --output text 2>/dev/null \
      | grep -Ei 'applying migration|successfully applied|No pending' | tail -5 || true
  fi
fi

# ---- 3. API rollout (only AFTER migration succeeded) -----------------------
if $DO_API; then
  log "Force new deployment: $API_SVC (image already current; migration is in)"
  run "aws ecs update-service --cluster $CLUSTER --service $API_SVC --force-new-deployment >/dev/null"
  if ! $DRY; then
    echo "waiting for $API_SVC to reach steady state..."
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$API_SVC"
    echo "$API_SVC stable."
  fi
fi

# ---- 4. Web rollout (order-independent — no schema dependency) -------------
if $DO_WEB; then
  log "Force new deployment: $WEB_SVC"
  run "aws ecs update-service --cluster $CLUSTER --service $WEB_SVC --force-new-deployment >/dev/null"
  if ! $DRY; then
    echo "waiting for $WEB_SVC to reach steady state..."
    aws ecs wait services-stable --cluster "$CLUSTER" --services "$WEB_SVC"
    echo "$WEB_SVC stable."
  fi
fi

# ---- 5. post-deploy verification hint --------------------------------------
log "Done. Verify no new exceptions in the API logs:"
cat <<'EOF'
  MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name /capiro/dev/api \
    --start-time $(( $(date +%s)000 - 300000 )) \
    --filter-pattern '?ExceptionsHandler ?PrismaClientKnownRequestError ?"does not exist"' \
    --query 'length(events)' --output text     # expect 0
EOF
