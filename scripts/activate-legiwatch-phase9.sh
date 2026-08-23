#!/usr/bin/env bash
# LegiWatch Live Hearings Phase 9 — out-of-band runtime registration.
#
# This script follows Capiro's verified live pattern: dedicated ECS task
# definitions + plain EventBridge Rules. It never calls CloudFormation and never
# edits the running API/intel services, ALB, Aurora, certificates, or VPC.
#
# SAFETY:
#   plan/status are read-only.
#   register-dark creates task definitions, IAM role, DISABLED rules and alarms.
#   enable-shadow requires an exact confirmation and updates the guarded DB
#   runtime registry before enabling rules.
#   disable rules first, then marks the DB registry dark.
#   no command performs CANARY, CUTOVER, capture-all, merge, or deploy.
#
# Usage:
#   bash scripts/activate-legiwatch-phase9.sh plan
#   CONFIRM=CREATE_LEGIWATCH_PHASE9_DARK bash ... register-dark
#   CONFIRM=ENABLE_LEGIWATCH_PHASE9_SHADOW bash ... enable-shadow
#   CONFIRM=DISABLE_LEGIWATCH_PHASE9_SCHEDULES bash ... disable
#   bash ... smoke metrics
#   bash ... status
set -euo pipefail

REGION="${AWS_REGION:-${AWS_REGION_DEFAULT:-us-east-1}}"
ENVIRONMENT="${CAPIRO_ENV:-dev}"
CLUSTER="${CAPIRO_CLUSTER:-capiro-${ENVIRONMENT}}"
API_SERVICE_OVERRIDE="${CAPIRO_API_SERVICE:-}"
INTEL_SERVICE_OVERRIDE="${CAPIRO_INTEL_SERVICE:-}"
API_FAMILY="capiro-${ENVIRONMENT}-legiwatch-phase9-api"
INTEL_FAMILY="capiro-${ENVIRONMENT}-legiwatch-phase9-intel"
EVENT_ROLE="capiro-${ENVIRONMENT}-legiwatch-phase9-events"
AWS=(aws --region "$REGION")
PREFIX="capiro-${ENVIRONMENT}-legiwatch"

log(){ printf '\n== %s ==\n' "$*"; }
die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null || die "$1 is required"; }
# Normalize a path for tools that need a native OS path (AWS CLI file://, jq).
# On Windows Git Bash, `/tmp/x` must become `C:/Users/.../Temp/x` for the native
# AWS CLI to read it; `cygpath -m` does that. On Linux/CI cygpath is absent and
# the path passes through unchanged — no Windows dependency at runtime.
norm_path(){ if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
confirm(){ [ "${CONFIRM:-}" = "$1" ] || die "Set CONFIRM=$1"; }

RULE_ROWS=(
  "central-discovery|rate(10 minutes)|api|central-discovery"
  "committee-enrichment|rate(15 minutes)|api|committee-enrichment"
  "committee-updates|rate(30 minutes)|api|committee-updates"
  "source-probe|rate(20 minutes)|api|source-probe"
  "coverage-audit|rate(6 hours)|api|coverage-audit"
  "stream-preflight|rate(2 minutes)|api|stream-preflight"
  "capture-worker|rate(1 minute)|intel|capture-worker"
  "archive-reconciliation|rate(30 minutes)|api|archive-reconciliation"
  "intelligence-worker|rate(1 minute)|intel|intelligence-worker"
  "parallel-comparison|rate(6 hours)|api|parallel-comparison"
  "metrics|rate(5 minutes)|api|metrics"
)

api_command(){
  printf '%s\n' legiwatch-phase9-job "$1"
}
intel_command(){
  case "$1" in
    capture-worker) printf '%s\n' legiwatch-phase9-capture both --limit=10 ;;
    intelligence-worker) printf '%s\n' legiwatch-phase9-intelligence --max-passes 20 ;;
    *) die "unknown intel job $1" ;;
  esac
}

find_service(){
  local kind="$1" override="$2" rows exact
  if [ -n "$override" ]; then echo "$override"; return; fi
  rows=$("${AWS[@]}" ecs list-services --cluster "$CLUSTER" --query 'serviceArns[]' --output text | tr '\t' '\n' | sed 's#.*/##')
  if [ "$kind" = intel ]; then
    # Prefer the exact known name; never fall back to a broad grep that could
    # match the plain API service.
    exact="capiro-${ENVIRONMENT}-intel-api"
    if echo "$rows" | grep -qx "$exact"; then echo "$exact"; return; fi
    echo "$rows" | grep -xE "capiro-${ENVIRONMENT}-intel-api" | head -1
  else
    # Prefer the exact API service name. The old grep ('api' minus a deny-list)
    # mis-selected capiro-<env>-web; anchor to the exact name and only fall
    # back to a strict suffix match that still excludes intel/engagement/etc.
    exact="capiro-${ENVIRONMENT}-api"
    if echo "$rows" | grep -qx "$exact"; then echo "$exact"; return; fi
    echo "$rows" | grep -xE "capiro-${ENVIRONMENT}-api" \
      | grep -viE 'web|intel|engagement|onboard|workspace|strategy|marketing|orchestrator|clio' | head -1
  fi
}

assert_service(){
  # Hard safety gate: refuse to proceed if discovery did not resolve exactly the
  # expected API/intel service. Prevents cloning a task def from the wrong
  # service (e.g. web) into the Phase 9 dark runtime.
  local kind="$1" resolved="$2" expected
  if [ "$kind" = intel ]; then expected="capiro-${ENVIRONMENT}-intel-api"; else expected="capiro-${ENVIRONMENT}-api"; fi
  if [ "$resolved" != "$expected" ]; then
    die "resolved $kind service '$resolved' != expected '$expected'; set CAPIRO_$( [ "$kind" = intel ] && echo INTEL || echo API )_SERVICE explicitly"
  fi
}

service_value(){
  local service="$1" query="$2"
  "${AWS[@]}" ecs describe-services --cluster "$CLUSTER" --services "$service" --query "$query" --output text
}

discover(){
  need aws; need jq
  API_SERVICE=$(find_service api "$API_SERVICE_OVERRIDE")
  INTEL_SERVICE=$(find_service intel "$INTEL_SERVICE_OVERRIDE")
  [ -n "$API_SERVICE" ] || die "API service not found; set CAPIRO_API_SERVICE"
  [ -n "$INTEL_SERVICE" ] || die "intel-api service not found; set CAPIRO_INTEL_SERVICE"
  assert_service api "$API_SERVICE"
  assert_service intel "$INTEL_SERVICE"
  CLUSTER_ARN=$("${AWS[@]}" ecs describe-clusters --clusters "$CLUSTER" --query 'clusters[0].clusterArn' --output text)
  API_SOURCE_TD=$(service_value "$API_SERVICE" 'services[0].taskDefinition')
  INTEL_SOURCE_TD=$(service_value "$INTEL_SERVICE" 'services[0].taskDefinition')
  local network
  network=$("${AWS[@]}" ecs describe-services --cluster "$CLUSTER" --services "$API_SERVICE" --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)
  SUBNETS=$(echo "$network" | jq -c '.subnets')
  SECURITY_GROUPS=$(echo "$network" | jq -c '.securityGroups')
  ASSIGN_PUBLIC_IP=$(echo "$network" | jq -r '.assignPublicIp // "DISABLED"')
  API_CONTAINER=$("${AWS[@]}" ecs describe-task-definition --task-definition "$API_SOURCE_TD" --query 'taskDefinition.containerDefinitions[0].name' --output text)
  INTEL_CONTAINER=$("${AWS[@]}" ecs describe-task-definition --task-definition "$INTEL_SOURCE_TD" --query 'taskDefinition.containerDefinitions[0].name' --output text)
  echo "cluster=$CLUSTER_ARN"
  echo "api_service=$API_SERVICE api_source_td=$API_SOURCE_TD container=$API_CONTAINER"
  echo "intel_service=$INTEL_SERVICE intel_source_td=$INTEL_SOURCE_TD container=$INTEL_CONTAINER"
  echo "subnets=$SUBNETS security_groups=$SECURITY_GROUPS"
}

clone_td(){
  # $4 (container) is optional for backward compatibility, but register-dark
  # always passes it so the cloned Phase 9 TD carries an explicit CAPIRO_ENV
  # matching this script's own ENVIRONMENT (the same value used for rule
  # naming, alarm dimensions, and task-family naming). Without this, the
  # Phase 9 metrics service falls back to NODE_ENV ("development") while
  # alarms are dimensioned on ENVIRONMENT ("dev"), and every alarm sits in
  # ALARM on a dimension mismatch regardless of real health.
  #
  # Only the named container's environment array is touched: any existing
  # CAPIRO_ENV entry on that container is replaced, every other env var is
  # preserved verbatim, and secrets/other containers are untouched entirely.
  local source="$1" family="$2" outfile="$3" container="${4:-}"
  "${AWS[@]}" ecs describe-task-definition --task-definition "$source" --query taskDefinition --output json \
    | jq --arg family "$family" --arg container "$container" --arg envName CAPIRO_ENV --arg envValue "$ENVIRONMENT" '
      del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
      | .family=$family
      | if $container == "" then . else
          .containerDefinitions = [.containerDefinitions[] |
            if .name == $container then
              .environment = ((.environment // []) | map(select(.name != $envName)) + [{name:$envName,value:$envValue}])
            else . end]
        end' > "$outfile"
  "${AWS[@]}" ecs register-task-definition --cli-input-json "file://$(norm_path "$outfile")" --query 'taskDefinition.taskDefinitionArn' --output text
}

latest_td(){
  "${AWS[@]}" ecs describe-task-definition --task-definition "$1" --query 'taskDefinition.taskDefinitionArn' --output text
}

ensure_role(){
  local account trust policy api_exec api_task intel_exec intel_task
  account=$("${AWS[@]}" sts get-caller-identity --query Account --output text)
  cat >/tmp/legiwatch-phase9-events-trust.json <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"events.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
  if ! "${AWS[@]}" iam get-role --role-name "$EVENT_ROLE" >/dev/null 2>&1; then
    "${AWS[@]}" iam create-role --role-name "$EVENT_ROLE" --assume-role-policy-document "file://$(norm_path /tmp/legiwatch-phase9-events-trust.json)" >/dev/null
  fi
  api_exec=$(jq -r '.executionRoleArn // empty' "$(norm_path /tmp/legiwatch-phase9-api-td.json)")
  api_task=$(jq -r '.taskRoleArn // empty' "$(norm_path /tmp/legiwatch-phase9-api-td.json)")
  intel_exec=$(jq -r '.executionRoleArn // empty' "$(norm_path /tmp/legiwatch-phase9-intel-td.json)")
  intel_task=$(jq -r '.taskRoleArn // empty' "$(norm_path /tmp/legiwatch-phase9-intel-td.json)")
  cat >/tmp/legiwatch-phase9-events-policy.json <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"ecs:RunTask","Resource":[
   "arn:aws:ecs:${REGION}:${account}:task-definition/${API_FAMILY}:*",
   "arn:aws:ecs:${REGION}:${account}:task-definition/${INTEL_FAMILY}:*"
 ]},
 {"Effect":"Allow","Action":"iam:PassRole","Resource":[
   "${api_exec:-arn:aws:iam::${account}:role/never}",
   "${api_task:-arn:aws:iam::${account}:role/never}",
   "${intel_exec:-arn:aws:iam::${account}:role/never}",
   "${intel_task:-arn:aws:iam::${account}:role/never}"
 ]}
]}
JSON
  "${AWS[@]}" iam put-role-policy --role-name "$EVENT_ROLE" --policy-name run-legiwatch-phase9 --policy-document "file://$(norm_path /tmp/legiwatch-phase9-events-policy.json)"
  EVENT_ROLE_ARN="arn:aws:iam::${account}:role/${EVENT_ROLE}"
}

command_json(){ printf '%s\n' "$@" | jq -R . | jq -cs .; }

target_json(){
  local kind="$1" job="$2" td container command input
  if [ "$kind" = api ]; then
    td="$API_TD"; container="$API_CONTAINER"; mapfile -t command < <(api_command "$job")
  else
    td="$INTEL_TD"; container="$INTEL_CONTAINER"; mapfile -t command < <(intel_command "$job")
  fi
  input=$(jq -cn --arg name "$container" --argjson command "$(command_json "${command[@]}")" '{containerOverrides:[{name:$name,command:$command}]}')
  jq -cn \
    --arg id "$job" --arg arn "$CLUSTER_ARN" --arg role "$EVENT_ROLE_ARN" --arg td "$td" \
    --arg input "$input" --argjson subnets "$SUBNETS" --argjson sgs "$SECURITY_GROUPS" --arg assign "$ASSIGN_PUBLIC_IP" '
    [{Id:$id,Arn:$arn,RoleArn:$role,
      EcsParameters:{TaskDefinitionArn:$td,TaskCount:1,LaunchType:"FARGATE",
        NetworkConfiguration:{awsvpcConfiguration:{Subnets:$subnets,SecurityGroups:$sgs,AssignPublicIp:$assign}}},
      Input:$input}]'
}

ensure_rules_disabled(){
  local row job schedule kind command rule
  for row in "${RULE_ROWS[@]}"; do
    IFS='|' read -r job schedule kind command <<<"$row"
    rule="${PREFIX}-${job}"
    "${AWS[@]}" events put-rule --name "$rule" --schedule-expression "$schedule" --state DISABLED \
      --description "LegiWatch Phase 9 $job (dark until guarded shadow activation)" >/dev/null
    "${AWS[@]}" events put-targets --rule "$rule" --targets "$(target_json "$kind" "$command")" >/dev/null
    echo "dark rule: $rule $schedule"
  done
}

all_rule_names(){
  local row job rest
  for row in "${RULE_ROWS[@]}"; do IFS='|' read -r job rest <<<"$row"; echo "${PREFIX}-${job}"; done
}

runtime_registrations(){
  local enabled="$1" rows='[]' row job schedule kind command family
  for row in "${RULE_ROWS[@]}"; do
    IFS='|' read -r job schedule kind command <<<"$row"
    if [ "$kind" = api ]; then family="$API_FAMILY"; else family="$INTEL_FAMILY"; fi
    rows=$(echo "$rows" | jq \
      --arg key "$job" --arg rule "${PREFIX}-${job}" --arg family "$family" --argjson enabled "$enabled" \
      '. + [{jobKey:$key,enabled:$enabled,scheduleEnabled:$enabled,ruleName:$rule,taskFamily:$family}]')
  done
  echo "$rows"
}

run_task_wait(){
  local kind="$1" label="$2" env_json="$3"; shift 3
  local td container command input task exit_code
  if [ "$kind" = api ]; then td="$API_TD"; container="$API_CONTAINER"; else td="$INTEL_TD"; container="$INTEL_CONTAINER"; fi
  command=$(command_json "$@")
  input=$(jq -cn --arg name "$container" --argjson command "$command" --argjson environment "$env_json" '{containerOverrides:[{name:$name,command:$command,environment:$environment}]}')
  task=$("${AWS[@]}" ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$td" \
    --network-configuration "awsvpcConfiguration={subnets=$SUBNETS,securityGroups=$SECURITY_GROUPS,assignPublicIp=$ASSIGN_PUBLIC_IP}" \
    --overrides "$input" --query 'tasks[0].taskArn' --output text)
  [ -n "$task" ] && [ "$task" != None ] || die "run-task failed: $label"
  "${AWS[@]}" ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
  exit_code=$("${AWS[@]}" ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
  echo "$label task=$task exit=$exit_code"
  [ "$exit_code" = 0 ] || die "$label failed"
}

operator_env(){
  local registrations="$1" confirmation="$2"
  jq -cn --arg registrations "$registrations" --arg confirmation "$confirmation" '[
    {name:"LEGIWATCH_RUNTIME_REGISTRATIONS_JSON",value:$registrations},
    {name:"LEGIWATCH_CONFIRMATION",value:$confirmation},
    {name:"LEGIWATCH_OPERATOR_ID",value:"activate-legiwatch-phase9.sh"}
  ]'
}

register_db_runtime(){
  local enabled="$1" confirmation registrations env
  if [ "$enabled" = true ]; then confirmation="ENABLE LEGIWATCH SCHEDULES"; else confirmation="DISABLE LEGIWATCH SCHEDULES"; fi
  registrations=$(runtime_registrations "$enabled")
  env=$(operator_env "$registrations" "$confirmation")
  run_task_wait api "register-runtime-$enabled" "$env" legiwatch-phase9-operator register-runtime
}

put_alarms(){
  local metric alarm threshold
  while IFS='|' read -r metric alarm threshold; do
    "${AWS[@]}" cloudwatch put-metric-alarm \
      --alarm-name "${PREFIX}-${alarm}" \
      --namespace Capiro/LegiWatch --metric-name "$metric" \
      --dimensions "Name=Environment,Value=${ENVIRONMENT}" \
      --statistic Maximum --period 300 --evaluation-periods 1 --datapoints-to-alarm 1 \
      --threshold "$threshold" --comparison-operator GreaterThanOrEqualToThreshold \
      --treat-missing-data breaching >/dev/null
  done <<'ALARMS'
ReadinessBlockers|readiness-blocked|1
UnresolvedUpcoming2h|upcoming-unresolved|1
DuplicateCanonicalEvents|duplicate-events|1
DuplicateGlobalCaptures|duplicate-captures|1
StaleRequiredJobs|stale-jobs|1
FailedRuntimeJobs|failed-jobs|1
CaptureFailed|capture-queue-failed|1
IntelligenceFailed|intelligence-queue-failed|1
RelevanceFailed|relevance-queue-failed|1
FailedCaptures24h|capture-failures|1
ALARMS
}

prepare(){
  discover
  API_TD=$(latest_td "$API_FAMILY" 2>/dev/null || true)
  INTEL_TD=$(latest_td "$INTEL_FAMILY" 2>/dev/null || true)
}

cmd_plan(){
  discover
  printf '%-28s %-18s %-7s %s\n' JOB CADENCE APP COMMAND
  local row job schedule kind command
  for row in "${RULE_ROWS[@]}"; do
    IFS='|' read -r job schedule kind command <<<"$row"
    printf '%-28s %-18s %-7s %s\n' "$job" "$schedule" "$kind" "$command"
  done
  echo 'No resources changed.'
}

cmd_register_dark(){
  confirm CREATE_LEGIWATCH_PHASE9_DARK
  discover
  API_TD=$(clone_td "$API_SOURCE_TD" "$API_FAMILY" /tmp/legiwatch-phase9-api-td.json "$API_CONTAINER")
  INTEL_TD=$(clone_td "$INTEL_SOURCE_TD" "$INTEL_FAMILY" /tmp/legiwatch-phase9-intel-td.json "$INTEL_CONTAINER")
  ensure_role
  ensure_rules_disabled
  put_alarms
  echo "Registered dark. API=$API_TD INTEL=$INTEL_TD. No rule was enabled."
}

cmd_enable_shadow(){
  confirm ENABLE_LEGIWATCH_PHASE9_SHADOW
  prepare
  [ -n "$API_TD" ] && [ -n "$INTEL_TD" ] || die 'Run register-dark first'
  register_db_runtime true
  local rule
  if ! while read -r rule; do "${AWS[@]}" events enable-rule --name "$rule"; done < <(all_rule_names); then
    while read -r rule; do "${AWS[@]}" events disable-rule --name "$rule" || true; done < <(all_rule_names)
    register_db_runtime false || true
    die 'Rule activation failed; rollback to dark attempted'
  fi
  echo 'Shadow schedules enabled. Production default, kill switch, and the public-events blanket-capture flag are all left exactly as they were.'
}

cmd_disable(){
  confirm DISABLE_LEGIWATCH_PHASE9_SCHEDULES
  prepare
  local rule
  while read -r rule; do "${AWS[@]}" events disable-rule --name "$rule" 2>/dev/null || true; done < <(all_rule_names)
  register_db_runtime false
  echo 'All Phase 9 schedules are dark.'
}

cmd_smoke(){
  prepare
  [ -n "$API_TD" ] && [ -n "$INTEL_TD" ] || die 'Run register-dark first'
  local job="${1:-metrics}" env='[]'
  case "$job" in
    capture-worker) run_task_wait intel "$job" "$env" legiwatch-phase9-capture status --manual ;;
    intelligence-worker) run_task_wait intel "$job" "$env" legiwatch-phase9-intelligence --manual --max-passes 1 ;;
    *) run_task_wait api "$job" "$env" legiwatch-phase9-job "$job" --manual --limit 10 ;;
  esac
}

cmd_status(){
  discover
  "${AWS[@]}" events list-rules --name-prefix "$PREFIX" --query 'Rules[].{Name:Name,State:State,Schedule:ScheduleExpression}' --output table
  echo "api_td=$(latest_td "$API_FAMILY" 2>/dev/null || echo missing)"
  echo "intel_td=$(latest_td "$INTEL_FAMILY" 2>/dev/null || echo missing)"
}

case "${1:-plan}" in
  plan) cmd_plan ;;
  register-dark) cmd_register_dark ;;
  enable-shadow) cmd_enable_shadow ;;
  disable) cmd_disable ;;
  smoke) shift; cmd_smoke "${1:-metrics}" ;;
  status) cmd_status ;;
  *) die 'usage: activate-legiwatch-phase9.sh <plan|register-dark|enable-shadow|disable|smoke|status>' ;;
esac
