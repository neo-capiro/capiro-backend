#!/usr/bin/env bash
###############################################################################
# Capiro STATE LEGISLATION ingestion — out-of-band activation.
#
# 2026-07-11: verified against the live capiro-dev account that
# scripts/deploy-ingestion-out-of-band.sh's EventBridge *Scheduler* approach is
# NOT the mechanism actually running any of Capiro's ~55 live ingestion jobs
# (`aws scheduler list-schedules` returns zero rows in this account). Every
# real job instead runs as: one dedicated ECS task-def family
# (`capiro-dev-api-sync-<job>` or `capiro-dev-api-<verb>-<job>`), cloned from a
# sibling job's task-def and carrying only the base app secrets
# (CLERK/DB) + whatever extra API key that specific job needs (least
# privilege — e.g. capiro-dev-api-sync-openstates carries OPENSTATES_API_KEY
# and nothing else), invoked by a plain EventBridge *Rule*
# (`aws events put-rule` + `put-targets`) whose target role
# (`capiro-dev-eventbridge-sync-invoker`) is already IAM-scoped to
# `task-definition/capiro-dev-api-*` wildcard — so no IAM change is needed for
# any new job in that family namespace. This script follows that verified
# live pattern instead of the untested Scheduler script.
#
# Derived/keyless jobs piggyback on a thematically-adjacent job's task-def
# rather than getting a pristine dedicated one — mirrors the live
# capiro-dev-derive-bill-status rule, which actually runs on the
# capiro-dev-api-sync-congress task-def (unused CONGRESS_API_KEY, harmless).
#
# SAFETY: creates NEW task-def revisions under NEW families only (never edits
# capiro-dev-api / capiro-dev-api-migrate / any existing live family) and NEW
# EventBridge rules only. Never touches ECS services, the ALB, CDK/CFN, or any
# existing rule. Idempotent — safe to re-run any phase.
#
# USAGE:
#   bash scripts/activate-state-ingestion.sh preflight   # confirm LEGISCAN_API_KEY resolves, no writes
#   bash scripts/activate-state-ingestion.sh register    # clone the 3 new task-def families
#   bash scripts/activate-state-ingestion.sh smoke       # 1 real LegiScan masterlist pull, verify rows
#   bash scripts/activate-state-ingestion.sh schedules   # create the 8 EventBridge rules (recurring)
#   bash scripts/activate-state-ingestion.sh all         # register -> smoke -> (confirm) -> schedules
#
# PREREQUISITE (blocks every phase — this script will not fabricate a key):
#   aws secretsmanager create-secret --region us-east-1 \
#     --name capiro/dev/legiscan_api_key --secret-string '<your LegiScan key>'
#
# Explicitly OUT OF SCOPE — never touched by this script: run-intel-workflows
# (the Tier-2 agentic writer). Stays dark per the remediation blueprint §6
# rollout ladder (R7) until a separate, later, deliberate decision.
###############################################################################
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ENV="${CAPIRO_ENV:-dev}"
CLUSTER_NAME="capiro-${ENV}"
AWS="aws --region $REGION"
LEGISCAN_SECRET_NAME="${LEGISCAN_SECRET_NAME:-capiro/dev/legiscan_api_key}"

# Template task-defs to clone from (already-live, closest analog per job).
TPL_SINGLE_KEY="capiro-${ENV}-api-sync-openstates"   # base secrets + exactly 1 extra key
TPL_NO_KEY="capiro-${ENV}-api-sync-fara"             # base secrets only, no extra key

log(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
die(){ printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

###############################################################################
discover() {
  command -v aws >/dev/null || die "aws CLI not found"
  command -v jq  >/dev/null || die "jq not found"

  log "Resolving LegiScan secret ($LEGISCAN_SECRET_NAME)"
  LEGISCAN_SECRET_ARN=$($AWS secretsmanager list-secrets \
    --filters Key=name,Values="$LEGISCAN_SECRET_NAME" \
    --query 'SecretList[0].ARN' --output text 2>/dev/null || true)
  [ -n "$LEGISCAN_SECRET_ARN" ] && [ "$LEGISCAN_SECRET_ARN" != "None" ] || die \
    "Secret '$LEGISCAN_SECRET_NAME' not found. Run:
  aws secretsmanager create-secret --region $REGION --name $LEGISCAN_SECRET_NAME --secret-string '<your LegiScan key>'
before re-running this script. Not fabricating a placeholder — see file header."
  echo "  LEGISCAN_API_KEY -> $LEGISCAN_SECRET_ARN"

  log "Discovering live networking + roles from $TPL_SINGLE_KEY"
  local netcfg
  netcfg=$($AWS events list-targets-by-rule --rule "capiro-${ENV}-sync-openstates" \
    --query 'Targets[0]' --output json) || die "Could not read the sync-openstates rule target"
  CLUSTER_ARN=$(echo "$netcfg" | jq -r '.Arn')
  SCHED_ROLE_ARN=$(echo "$netcfg" | jq -r '.RoleArn')
  SUBNETS_JSON=$(echo "$netcfg" | jq -c '.EcsParameters.NetworkConfiguration.awsvpcConfiguration.subnets')
  SG_JSON=$(echo "$netcfg" | jq -c '.EcsParameters.NetworkConfiguration.awsvpcConfiguration.securityGroups')
  echo "  cluster: $CLUSTER_ARN"
  echo "  invoker role: $SCHED_ROLE_ARN"
  echo "  subnets: $SUBNETS_JSON  sg: $SG_JSON"
}

###############################################################################
# clone_family <new_family> <template_family> <new_container_name> <command_json_array> [extra_secret_name]
clone_family() {
  local family="$1" template="$2" container="$3" cmd_json="$4" extra_secret_name="${5:-}"
  log "Registering $family (clone of $template)"
  local src
  src=$($AWS ecs describe-task-definition --task-definition "$template" --query 'taskDefinition' --output json)
  local filtered
  filtered=$(echo "$src" | jq \
    --arg family "$family" --arg cn "$container" --argjson cmd "$cmd_json" \
    'del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
     | .family = $family
     | .containerDefinitions[0].name = $cn
     | .containerDefinitions[0].command = $cmd')
  if [ -n "$extra_secret_name" ]; then
    filtered=$(echo "$filtered" | jq \
      --arg name "$extra_secret_name" --arg arn "$LEGISCAN_SECRET_ARN" \
      '.containerDefinitions[0].secrets = ((.containerDefinitions[0].secrets // []) | map(select(.name != $name)) + [{name:$name, valueFrom:$arn}])')
  fi
  echo "$filtered" > "/tmp/${family}.json"
  local td_arn
  td_arn=$($AWS ecs register-task-definition --cli-input-json "file:///tmp/${family}.json" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  echo "  registered: $td_arn"
}

cmd_register() {
  discover
  clone_family "capiro-${ENV}-api-sync-legiscan-masterlist" "$TPL_SINGLE_KEY" \
    "api-sync-legiscan-masterlist" '["sync-legiscan-masterlist"]' "LEGISCAN_API_KEY"
  clone_family "capiro-${ENV}-api-sync-legiscan-bills" "$TPL_SINGLE_KEY" \
    "api-sync-legiscan-bills" '["sync-legiscan-bills"]' "LEGISCAN_API_KEY"
  clone_family "capiro-${ENV}-api-sync-state-register" "$TPL_NO_KEY" \
    "api-sync-state-register" '["sync-state-register"]' ""
  log "Registered all 3 new task-def families."
}

###############################################################################
run_job_wait() {  # $1=family  $2=container  $3..=command  (env overrides via JOB_ENV, "K=V;K2=V2" or "")
  local family="$1" container="$2"; shift 2
  local cmd_json; cmd_json=$(printf '%s\n' "$@" | jq -R . | jq -cs .)
  local env_json='[]'
  if [ -n "${JOB_ENV:-}" ]; then
    env_json=$(printf '%s\n' "${JOB_ENV//;/$'\n'}" | awk -F= '{printf "{\"name\":\"%s\",\"value\":\"%s\"}\n", $1, $2}' | jq -cs .)
  fi
  log "run-task: $family ($*)  env=${JOB_ENV:-<none>}"
  local task_arn
  task_arn=$($AWS ecs run-task --cluster "$CLUSTER_ARN" --launch-type FARGATE \
    --task-definition "$family" \
    --network-configuration "awsvpcConfiguration={subnets=$SUBNETS_JSON,securityGroups=$SG_JSON,assignPublicIp=DISABLED}" \
    --overrides "$(jq -cn --arg cn "$container" --argjson cmd "$cmd_json" --argjson env "$env_json" \
      '{containerOverrides:[{name:$cn,command:$cmd,environment:$env}]}')" \
    --query 'tasks[0].taskArn' --output text)
  [ -n "$task_arn" ] && [ "$task_arn" != "None" ] || die "run-task failed for $family"
  echo "  task: $task_arn — waiting..."
  $AWS ecs wait tasks-stopped --cluster "$CLUSTER_ARN" --tasks "$task_arn"
  local code
  code=$($AWS ecs describe-tasks --cluster "$CLUSTER_ARN" --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  echo "  exit code: $code   logs: CloudWatch /capiro/${ENV}/api-sync-jobs (or per-family log group), task ${task_arn##*/}"
  [ "$code" = "0" ] || die "$family exited $code — inspect logs before proceeding"
}

cmd_smoke() {
  discover
  log "SMOKE — one real LegiScan masterlist pull (priority states only, no bill drain yet)"
  JOB_ENV="LEGISCAN_STATES=FL,CA,TX,NY,IL,MA,GA,VA;LEGISCAN_MASTERLIST_SOURCE_SUFFIX=priority" \
    run_job_wait "capiro-${ENV}-api-sync-legiscan-masterlist" "api-sync-legiscan-masterlist" "sync-legiscan-masterlist"
  echo "Verify:  SELECT COUNT(*) FROM state_bill;"
  echo "         SELECT source,status,rows_inserted,rows_updated FROM sync_run WHERE source LIKE 'sync-legiscan%' ORDER BY started_at DESC LIMIT 5;"
}

###############################################################################
cmd_schedules() {
  discover
  log "Creating EventBridge rules (recurring). Cadences mirror infra/cdk/lib/ingestion-schedule.ts."

  # name|family|container|cmd (space-sep)|cron|env (K=V;K2=V2 or empty)
  local WIDE_STATES="AL,AK,AZ,AR,CO,CT,DE,DC,HI,ID,IN,IA,KS,KY,LA,ME,MD,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,UT,VT,WA,WV,WI,WY"
  local JOBS=(
    "sync-legiscan-masterlist-priority|capiro-${ENV}-api-sync-legiscan-masterlist|api-sync-legiscan-masterlist|sync-legiscan-masterlist|cron(10 * * * ? *)|LEGISCAN_STATES=FL,CA,TX,NY,IL,MA,GA,VA;LEGISCAN_MASTERLIST_SOURCE_SUFFIX=priority"
    "sync-legiscan-masterlist-wide|capiro-${ENV}-api-sync-legiscan-masterlist|api-sync-legiscan-masterlist|sync-legiscan-masterlist|cron(25 1/6 * * ? *)|LEGISCAN_STATES=${WIDE_STATES};LEGISCAN_MASTERLIST_SOURCE_SUFFIX=wide"
    "sync-legiscan-bills|capiro-${ENV}-api-sync-legiscan-bills|api-sync-legiscan-bills|sync-legiscan-bills|cron(30 * * * ? *)|"
    "sync-state-register|capiro-${ENV}-api-sync-state-register|api-sync-state-register|sync-state-register|cron(45 6 * * ? *)|"
    "derive-state-bill-status|capiro-${ENV}-api-sync-legiscan-bills|api-sync-legiscan-bills|derive-state-bill-status|cron(50 0/6 * * ? *)|"
    "emit-state-changes|capiro-${ENV}-api-sync-legiscan-bills|api-sync-legiscan-bills|emit-state-changes|cron(55 0/6 * * ? *)|"
    "normalize-state-committees|capiro-${ENV}-api-sync-state-register|api-sync-state-register|normalize-state-committees|cron(30 8 ? * MON *)|"
    "geocode-facilities|capiro-${ENV}-api-sync-state-register|api-sync-state-register|geocode-facilities|cron(15 4 * * ? *)|"
  )

  local n=0
  for row in "${JOBS[@]}"; do
    IFS='|' read -r name family container cmd cron envvars <<< "$row"
    local rule="capiro-${ENV}-${name}"
    $AWS events put-rule --name "$rule" --schedule-expression "$cron" --state ENABLED \
      --description "State legislation platform — $cmd" >/dev/null

    local cmd_json; cmd_json=$(printf '%s\n' "$cmd" | jq -R . | jq -cs .)
    local env_json='[]'
    if [ -n "$envvars" ]; then
      env_json=$(printf '%s\n' "${envvars//;/$'\n'}" | awk -F= '{printf "{\"name\":\"%s\",\"value\":\"%s\"}\n", $1, $2}' | jq -cs .)
    fi
    local input; input=$(jq -cn --arg cn "$container" --argjson cmd "$cmd_json" --argjson env "$env_json" \
      '{containerOverrides:[{name:$cn,command:$cmd,environment:$env}]}')
    local target; target=$(jq -cn \
      --arg id "${name}-fargate-target" --arg arn "$CLUSTER_ARN" --arg role "$SCHED_ROLE_ARN" \
      --arg td "arn:aws:ecs:${REGION}:967807252336:task-definition/${family}" \
      --argjson subs "$SUBNETS_JSON" --argjson sgs "$SG_JSON" --arg input "$input" \
      '{Id:$id,Arn:$arn,RoleArn:$role,EcsParameters:{TaskDefinitionArn:$td,TaskCount:1,LaunchType:"FARGATE",NetworkConfiguration:{awsvpcConfiguration:{Subnets:$subs,SecurityGroups:$sgs,AssignPublicIp:"DISABLED"}}},Input:$input}')
    $AWS events put-targets --rule "$rule" --targets "$target" >/dev/null
    echo "  $rule -> $family ($cron)"
    n=$((n+1))
  done
  log "Done: $n rules created/updated."
  echo "run-intel-workflows was NOT created — stays dark per blueprint §6 (R7)."
}

###############################################################################
cmd_preflight() {
  discover
  echo "OK: LEGISCAN_API_KEY resolves to $LEGISCAN_SECRET_ARN. No writes performed."
}

cmd_all() {
  cmd_register
  cmd_smoke
  echo; read -r -p "Smoke passed. Create recurring schedules now? [y/N] " yn
  [ "${yn:-N}" = "y" ] && cmd_schedules || echo "Skipped (run later: $0 schedules)."
}

###############################################################################
ACTION="${1:-help}"
case "$ACTION" in
  preflight) cmd_preflight ;;
  register)  cmd_register ;;
  smoke)     cmd_smoke ;;
  schedules) cmd_schedules ;;
  all)       cmd_all ;;
  *) sed -n '2,40p' "$0"; exit 0 ;;
esac
