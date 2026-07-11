#!/usr/bin/env bash
###############################################################################
# Capiro ingestion — one-shot out-of-band deploy (run in AWS CloudShell or any
# machine with creds for account 967807252336 / us-east-1).
#
# Gets DATA FLOWING without touching the frozen Capiro-dev-Compute CFN stack.
# Auto-discovers cluster / subnets / security group / task-def from the live
# account, so you fill in NOTHING. Idempotent + phased.
#
# 2026-07-11 NOTE: verified against the live capiro-dev account that this
# script's `schedules` phase (EventBridge *Scheduler*, `aws scheduler
# create-schedule`) was never actually adopted — `aws scheduler list-schedules`
# returns zero rows. Every one of Capiro's ~55 live ingestion jobs instead runs
# on a dedicated per-job ECS task-def family invoked by a plain EventBridge
# *Rule* (`aws events put-rule`/`put-targets`). For the state-legislation
# platform's activation, use scripts/activate-state-ingestion.sh, which follows
# that verified live pattern. This script's `preflight`/`register`/`smoke`/
# `backfill` phases (plain `ecs run-task`, no scheduler) are still valid for
# one-off ad hoc runs.
#
# USAGE (phases — run in order, or pick one):
#   bash deploy-ingestion-out-of-band.sh preflight     # check API keys only
#   bash deploy-ingestion-out-of-band.sh register      # register sync task def
#   bash deploy-ingestion-out-of-band.sh smoke         # run ONE job (sync-congress), verify rows
#   bash deploy-ingestion-out-of-band.sh backfill      # run full ordered backfill once
#   bash deploy-ingestion-out-of-band.sh schedules     # create EventBridge schedules (recurring)
#   bash deploy-ingestion-out-of-band.sh all           # register -> smoke -> (prompts) backfill -> schedules
#
# SAFETY: read-mostly. The only writes are: register-task-definition (new td,
# never edits existing), iam create-role/put-role-policy (scoped), ecs run-task,
# scheduler create-schedule. It NEVER calls cloudformation, never edits the ALB,
# Aurora, cert, or running services. Re-running is safe.
###############################################################################
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="${CAPIRO_ACCOUNT:-967807252336}"
ENV="${CAPIRO_ENV:-dev}"
CLUSTER="${CAPIRO_CLUSTER:-capiro-${ENV}}"
CLONE_FROM="${CLONE_FROM:-capiro-${ENV}-api-migrate}"   # td to clone (same image/secrets/roles)
SYNC_FAMILY="capiro-${ENV}-api-sync"
CONTAINER="api"                                          # container name in the migrate td
SCHED_ROLE="capiro-${ENV}-ingestion-scheduler"
AWS="aws --region $REGION"

log(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die(){ printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

###############################################################################
discover() {
  log "Discovering live networking from cluster $CLUSTER"
  command -v aws >/dev/null || die "aws CLI not found"
  command -v jq  >/dev/null || die "jq not found (CloudShell has it; else: yum install -y jq)"

  # Find the running API service to copy its subnets + security group.
  local svc_arn
  svc_arn=$($AWS ecs list-services --cluster "$CLUSTER" --query 'serviceArns[]' --output text \
            | tr '\t' '\n' | grep -iE 'api' | head -1 || true)
  [ -n "$svc_arn" ] || die "No API service found in cluster $CLUSTER"

  local netcfg
  netcfg=$($AWS ecs describe-services --cluster "$CLUSTER" --services "$svc_arn" \
           --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)
  SUBNETS_JSON=$(echo "$netcfg" | jq -c '.subnets')
  SG_JSON=$(echo "$netcfg" | jq -c '.securityGroups')
  CLUSTER_ARN=$($AWS ecs describe-clusters --clusters "$CLUSTER" --query 'clusters[0].clusterArn' --output text)
  [ "$SUBNETS_JSON" != "null" ] || die "Could not read subnets from $svc_arn"
  echo "  cluster:  $CLUSTER_ARN"
  echo "  subnets:  $SUBNETS_JSON"
  echo "  sg:       $SG_JSON"
}

###############################################################################
cmd_preflight() {
  log "Pre-flight: API keys (runs preflight-ingestion as a one-off task)"
  discover
  ensure_td
  run_job_wait "preflight-ingestion" "preflight-ingestion"
  echo "Check the task logs above. A non-zero exit = a REQUIRED key is missing."
}

###############################################################################
ensure_td() {
  # Register the sync task def by cloning the migrate td (idempotent: a new
  # revision each run is fine; we always use :latest revision after).
  log "Registering $SYNC_FAMILY (clone of $CLONE_FROM)"
  local src
  src=$($AWS ecs describe-task-definition --task-definition "$CLONE_FROM" --query 'taskDefinition' --output json) \
    || die "Cannot read $CLONE_FROM — is the name right? (set CLONE_FROM=...)"
  echo "$src" | jq \
    'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy) | .family="'"$SYNC_FAMILY"'"' \
    > /tmp/sync-td.json
  TD_ARN=$($AWS ecs register-task-definition --cli-input-json file:///tmp/sync-td.json \
           --query 'taskDefinition.taskDefinitionArn' --output text)
  EXEC_ROLE=$(jq -r '.executionRoleArn // empty' /tmp/sync-td.json)
  TASK_ROLE=$(jq -r '.taskRoleArn // empty' /tmp/sync-td.json)
  echo "  task def: $TD_ARN"
}

###############################################################################
# Run a job as a one-off ECS task and wait for it; print logs + exit code.
run_job_wait() {  # $1=label  $2..=command args
  local label="$1"; shift
  local cmd_json; cmd_json=$(printf '%s\n' "$@" | jq -R . | jq -cs .)
  log "run-task: $label  ($*)"
  local task_arn
  task_arn=$($AWS ecs run-task --cluster "$CLUSTER" --launch-type FARGATE \
    --task-definition "$TD_ARN" \
    --network-configuration "awsvpcConfiguration={subnets=$SUBNETS_JSON,securityGroups=$SG_JSON,assignPublicIp=DISABLED}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"$CONTAINER\",\"command\":$cmd_json}]}" \
    --query 'tasks[0].taskArn' --output text)
  [ -n "$task_arn" ] && [ "$task_arn" != "None" ] || die "run-task failed for $label"
  echo "  task: $task_arn — waiting for it to stop..."
  $AWS ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"
  local code
  code=$($AWS ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
         --query 'tasks[0].containers[0].exitCode' --output text)
  echo "  $label exit code: $code"
  echo "  logs: CloudWatch /capiro/${ENV}/api-migrate (or api-sync) — search task id ${task_arn##*/}"
  return 0
}

cmd_register() { discover; ensure_td; }

cmd_smoke() {
  discover; ensure_td
  log "SMOKE TEST — one job (sync-congress). If rows land, the pipeline works."
  run_job_wait "sync-congress" "sync-congress"
  echo "Verify in DB:  SELECT COUNT(*) FROM congress_bill;   -- expect > 0"
  echo "               SELECT * FROM sync_run ORDER BY started_at DESC LIMIT 3;"
}

cmd_backfill() {
  discover; ensure_td
  log "FULL BACKFILL — runs backfill-all (dependency-ordered, resumable, ~30-90min)"
  run_job_wait "backfill-all" "backfill-all"
  echo "When done: SELECT source,status,rows_inserted,rows_updated,finished_at FROM sync_run ORDER BY started_at DESC LIMIT 40;"
}

###############################################################################
cmd_schedules() {
  discover
  ensure_td
  log "Creating EventBridge Scheduler role + schedules (recurring autonomous ingestion)"

  # Scheduler-invoke role (idempotent).
  if ! $AWS iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
    cat > /tmp/sched-trust.json <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
    $AWS iam create-role --role-name "$SCHED_ROLE" --assume-role-policy-document file:///tmp/sched-trust.json >/dev/null
    echo "  created role $SCHED_ROLE"
  else echo "  role $SCHED_ROLE exists"; fi
  cat > /tmp/sched-policy.json <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"ecs:RunTask","Resource":"arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${SYNC_FAMILY}:*"},
 {"Effect":"Allow","Action":"iam:PassRole","Resource":["${EXEC_ROLE:-*}","${TASK_ROLE:-*}"]}
]}
JSON
  $AWS iam put-role-policy --role-name "$SCHED_ROLE" --policy-name run-sync-tasks \
    --policy-document file:///tmp/sched-policy.json
  local role_arn="arn:aws:iam::${ACCOUNT}:role/${SCHED_ROLE}"

  # Schedule definitions: "name|cron|cmd". Mirrors infra/cdk/lib/ingestion-schedule.ts.
  # AWS Scheduler cron: cron(min hr day-of-month month day-of-week year), one '?' required.
  local SCHEDULES=(
    # daily sources
    "sync-congress|cron(0 6 * * ? *)|sync-congress"
    "sync-federal-register|cron(15 6 * * ? *)|sync-federal-register"
    "sync-regulations|cron(30 6 * * ? *)|sync-regulations"
    "sync-hearings|cron(45 6 * * ? *)|sync-hearings"
    "sync-rss-intel|cron(0 0/6 * * ? *)|sync-rss-intel"
    "sync-fec|cron(0 7 * * ? *)|sync-fec"
    "sync-fec-pac|cron(20 7 * * ? *)|sync-fec-pac"
    "sync-federal-award|cron(40 7 * * ? *)|sync-federal-award"
    "enrich-award-districts|cron(0 8 * * ? *)|enrich-award-districts"
    # weekly sources (Mon)
    "sync-lda|cron(0 5 ? * MON *)|sync-lda"
    "sync-openlobby|cron(30 5 ? * MON *)|sync-openlobby"
    "sync-fara|cron(0 6 ? * MON *)|sync-fara"
    "sync-gao|cron(30 6 ? * MON *)|sync-gao"
    "sync-crs|cron(0 7 ? * MON *)|sync-crs"
    "sync-grants|cron(30 7 ? * MON *)|sync-grants"
    "sync-openstates|cron(0 8 ? * MON *)|sync-openstates"
    "sync-sec-edgar|cron(30 8 ? * MON *)|sync-sec-edgar"
    # weekly personnel (Tue)
    "sync-peo-rosters|cron(0 9 ? * TUE *)|sync-peo-rosters"
    "sync-dod-orgcharts|cron(30 9 ? * TUE *)|sync-dod-orgcharts"
    "sync-dod-press-personnel|cron(0 10 ? * TUE *)|sync-dod-press-personnel"
    "extract-press-personnel|cron(30 10 ? * TUE *)|extract-press-personnel"
    "extract-gao-interviewees|cron(0 11 ? * TUE *)|extract-gao-interviewees"
    "extract-hearing-witnesses|cron(30 11 ? * TUE *)|extract-hearing-witnesses"
    "sync-sam-personnel|cron(0 12 ? * TUE *)|sync-sam-personnel"
    # monthly (1st)
    "sync-bea|cron(0 4 1 * ? *)|sync-bea"
    "sync-bls|cron(30 4 1 * ? *)|sync-bls"
    "sync-census|cron(0 5 1 * ? *)|sync-census"
    "sync-openspending|cron(30 5 1 * ? *)|sync-openspending"
    "sync-cpe-roster|cron(0 6 1 * ? *)|sync-cpe-roster"
    "import-dow-directory|cron(30 6 1 * ? *)|import-dow-directory"
    "sync-lobby-trending|cron(0 7 1 * ? *)|sync-lobby-trending"
    # derived / emitters (daily, after sources)
    "extract-bill-pe-codes|cron(0 9 * * ? *)|extract-bill-pe-codes"
    "refresh-lobby-intel-mv|cron(30 9 * * ? *)|refresh-lobby-intel-mv"
    "emit-changes|cron(0 10 * * ? *)|emit-changes"
    "emit-bill-alerts|cron(20 10 * * ? *)|emit-bill-alerts"
    "check-comment-periods|cron(40 10 * * ? *)|check-comment-periods"
    "compute-health-scores|cron(0 11 * * ? *)|compute-health-scores"
    "generate-briefings|cron(30 11 * * ? *)|generate-briefings"
    "recompute-conference-probability|cron(50 11 * * ? *)|recompute-conference-probability"
    # embeddings (daily, last)
    "embed-backfill|cron(0 13 * * ? *)|embed-backfill --source all"
  )

  local n=0
  for row in "${SCHEDULES[@]}"; do
    IFS='|' read -r name cron cmd <<< "$row"
    # shellcheck disable=SC2206
    local arr=($cmd)
    local cmd_json; cmd_json=$(printf '%s\n' "${arr[@]}" | jq -R . | jq -cs .)
    local input; input=$(jq -cn --argjson c "$cmd_json" --arg cn "$CONTAINER" \
      '{containerOverrides:[{name:$cn,command:$c}]}')
    local target; target=$(jq -cn \
      --arg arn "$CLUSTER_ARN" --arg role "$role_arn" --arg td "$TD_ARN" \
      --argjson subs "$SUBNETS_JSON" --argjson sgs "$SG_JSON" --arg input "$input" \
      '{Arn:$arn,RoleArn:$role,EcsParameters:{TaskDefinitionArn:$td,LaunchType:"FARGATE",NetworkConfiguration:{awsvpcConfiguration:{Subnets:$subs,SecurityGroups:$sgs,AssignPublicIp:"DISABLED"}}},Input:$input}')
    # create-or-update
    if $AWS scheduler get-schedule --name "capiro-${ENV}-${name}" >/dev/null 2>&1; then
      $AWS scheduler update-schedule --name "capiro-${ENV}-${name}" \
        --schedule-expression "$cron" --schedule-expression-timezone UTC \
        --flexible-time-window '{"Mode":"OFF"}' --target "$target" >/dev/null
      echo "  updated capiro-${ENV}-${name}"
    else
      $AWS scheduler create-schedule --name "capiro-${ENV}-${name}" \
        --schedule-expression "$cron" --schedule-expression-timezone UTC \
        --flexible-time-window '{"Mode":"OFF"}' --target "$target" >/dev/null
      echo "  created capiro-${ENV}-${name}"
    fi
    n=$((n+1))
  done
  log "Done: $n schedules created/updated. Ingestion is now autonomous."
}

###############################################################################
cmd_all() {
  cmd_register
  cmd_smoke
  echo; read -r -p "Smoke test done. Run FULL backfill now? [y/N] " yn
  [ "${yn:-N}" = "y" ] && cmd_backfill || echo "Skipped backfill (run later: $0 backfill)."
  cmd_schedules
}

###############################################################################
ACTION="${1:-help}"
case "$ACTION" in
  preflight) cmd_preflight ;;
  register)  cmd_register ;;
  smoke)     cmd_smoke ;;
  backfill)  cmd_backfill ;;
  schedules) cmd_schedules ;;
  all)       cmd_all ;;
  *) sed -n '2,20p' "$0"; exit 0 ;;
esac
