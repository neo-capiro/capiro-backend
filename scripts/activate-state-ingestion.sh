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
# USAGE (run in order):
#   bash scripts/activate-state-ingestion.sh preflight   # confirm LEGISCAN_API_KEY resolves, no writes
#   bash scripts/activate-state-ingestion.sh register    # clone the 3 new task-def families + IAM grant
#   bash scripts/activate-state-ingestion.sh backfill    # MANDATORY seed: bulk-dataset ZIPs → state_bill (~28 queries)
#   bash scripts/activate-state-ingestion.sh smoke       # 1 real masterlist diff (proves cursor primed, ~0 changed)
#   bash scripts/activate-state-ingestion.sh derive      # compute canonical status + confirm emit surfaces 0 (no tracked bills)
#   bash scripts/activate-state-ingestion.sh schedules   # create the recurring EventBridge rules
#   bash scripts/activate-state-ingestion.sh all         # register -> backfill -> smoke -> derive -> (confirm) -> schedules
#
# WHY backfill is mandatory + FIRST: sync-legiscan-masterlist is a CHANGE
# detector — it diffs the live masterlist's change_hashes against
# state_sync_cursor.billHashes and only drains bills whose hash moved. On a
# never-seeded cursor it (correctly, W0.5 quota-governor) REFUSES the cold
# bill-by-bill drain (NY alone is 25k bills = 25k getBill queries, blowing the
# 30k/mo cap in one run) and logs "run backfill-legiscan-datasets first". The
# backfill seeds the whole corpus from LegiScan's weekly bulk-dataset ZIPs
# (~2-3 queries/state, not per-bill) AND primes billHashes so the masterlist
# diff then only picks up genuine post-seed changes.
#
# SCOPE (MVP, D2): the 8 Rev-2 priority states (FL,CA,TX,NY,IL,MA,GA,VA) only.
# The 43 "wide" states are NOT backfilled or scheduled here — scheduling their
# masterlist before they're seeded would burn ~5k queries/mo cold-cursor
# no-op polling for zero value. To add them later: LEGISCAN_STATES=<wide csv>
# backfill, then re-run schedules with INCLUDE_WIDE=1.
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
  SUBNETS_JSON=$(echo "$netcfg" | jq -c '.EcsParameters.NetworkConfiguration.awsvpcConfiguration.Subnets')
  SG_JSON=$(echo "$netcfg" | jq -c '.EcsParameters.NetworkConfiguration.awsvpcConfiguration.SecurityGroups')
  echo "  cluster: $CLUSTER_ARN"
  echo "  invoker role: $SCHED_ROLE_ARN"
  echo "  subnets: $SUBNETS_JSON  sg: $SG_JSON"

  # The cloned task-defs inherit the template's EXECUTION role, which resolves
  # each container secret at task-launch. That role grants GetSecretValue on a
  # FIXED allowlist of secret ARNs (per-key inline policies SyncTaskApiKeys /
  # SyncTaskApiKeysExtra, added out-of-band as new keys shipped). A brand-new
  # secret is NOT on it, so the task dies at launch with
  # ResourceInitializationError / AccessDeniedException GetSecretValue (exitCode
  # null, stopCode TaskFailedToStart). ensure_secret_grant() closes that gap.
  EXEC_ROLE_ARN=$($AWS ecs describe-task-definition --task-definition "$TPL_SINGLE_KEY" \
    --query 'taskDefinition.executionRoleArn' --output text)
  EXEC_ROLE_NAME="${EXEC_ROLE_ARN##*/}"
  echo "  execution role: $EXEC_ROLE_NAME"
}

###############################################################################
# Grant the execution role GetSecretValue on the LegiScan secret. Additive +
# idempotent: a dedicated inline policy (SyncTaskApiKeysState) mirroring the
# existing SyncTaskApiKeys/…Extra pattern, so re-running just overwrites it with
# the same doc and NEVER touches the other policies (rewriting a shared policy
# risks dropping a sibling ARN). No KMS grant needed: the secret uses the
# default aws/secretsmanager key, whose decrypt is auto-allowed for same-account
# principals holding secretsmanager perms (kms:ViaService). This is an IAM-only
# out-of-band change — it does NOT touch any task-def or the CDK-managed
# DefaultPolicy, so it is safe w.r.t. the cdk↔task-def drift landmine.
ensure_secret_grant() {
  [ -n "${EXEC_ROLE_NAME:-}" ] || die "ensure_secret_grant called before discover()"
  log "Granting $EXEC_ROLE_NAME GetSecretValue on $LEGISCAN_SECRET_NAME"
  local doc
  doc=$(jq -cn --arg arn "arn:aws:secretsmanager:${REGION}:967807252336:secret:${LEGISCAN_SECRET_NAME}*" \
    '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"],Resource:[$arn]}]}')
  $AWS iam put-role-policy --role-name "$EXEC_ROLE_NAME" \
    --policy-name SyncTaskApiKeysState --policy-document "$doc" >/dev/null
  echo "  granted (inline policy SyncTaskApiKeysState)"
  # IAM is eventually consistent; a task launched within a second or two of the
  # grant can still 400. Small settle window before any run-task in this run.
  sleep 8
}

###############################################################################
# clone_family <new_family> <template_family> <new_container_name> <command_json_array> [extra_secret_name] [cpu] [memory]
clone_family() {
  local family="$1" template="$2" container="$3" cmd_json="$4" extra_secret_name="${5:-}" cpu="${6:-}" mem="${7:-}"
  log "Registering $family (clone of $template)${cpu:+ [${cpu}cpu/${mem}mem]}"
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
  # Task-level cpu/memory override. The openstates/fara templates are 512/1024
  # — fine for a people/geo sync, but the LegiScan dataset backfill parses a
  # whole session's ZIP in memory (NY current session ≈ 25k bills), so those
  # two families get 1024/2048. Fargate valid combos: 1024 cpu pairs with 2048+.
  if [ -n "$cpu" ]; then
    filtered=$(echo "$filtered" | jq --arg cpu "$cpu" --arg mem "$mem" '.cpu=$cpu | .memory=$mem')
  fi
  local td_arn
  td_arn=$($AWS ecs register-task-definition --cli-input-json "$filtered" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  echo "  registered: $td_arn"
}

cmd_register() {
  discover
  ensure_secret_grant
  # LegiScan families sized up (1024/2048) for in-memory dataset-ZIP parsing.
  clone_family "capiro-${ENV}-api-sync-legiscan-masterlist" "$TPL_SINGLE_KEY" \
    "api-sync-legiscan-masterlist" '["sync-legiscan-masterlist"]' "LEGISCAN_API_KEY" "1024" "2048"
  clone_family "capiro-${ENV}-api-sync-legiscan-bills" "$TPL_SINGLE_KEY" \
    "api-sync-legiscan-bills" '["sync-legiscan-bills"]' "LEGISCAN_API_KEY" "1024" "2048"
  clone_family "capiro-${ENV}-api-sync-state-register" "$TPL_NO_KEY" \
    "api-sync-state-register" '["sync-state-register"]' "" "" ""
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
  echo "  task: $task_arn — waiting (budget ${WAIT_BUDGET:-900}s)..."
  # Manual poll instead of `aws ecs wait tasks-stopped` (fixed 10-min budget):
  # the dataset backfill of 8 large states can run longer, and a spurious
  # "Max attempts exceeded" would abort the sequence on a still-healthy task.
  local deadline=$(( ${WAIT_BUDGET:-900} / 10 )) status="" i=0
  while [ "$i" -lt "$deadline" ]; do
    status=$($AWS ecs describe-tasks --cluster "$CLUSTER_ARN" --tasks "$task_arn" \
      --query 'tasks[0].lastStatus' --output text 2>/dev/null || echo UNKNOWN)
    [ "$status" = "STOPPED" ] && break
    sleep 10; i=$((i+1))
  done
  [ "$status" = "STOPPED" ] || die "$family still $status after ${WAIT_BUDGET:-900}s — inspect the task, do not assume failure"
  local code reason
  code=$($AWS ecs describe-tasks --cluster "$CLUSTER_ARN" --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  reason=$($AWS ecs describe-tasks --cluster "$CLUSTER_ARN" --tasks "$task_arn" \
    --query 'tasks[0].stoppedReason' --output text)
  echo "  exit code: $code   stoppedReason: $reason"
  echo "  logs: CloudWatch /capiro/${ENV}/api-migrate, stream sync-openstates/${container}/${task_arn##*/}"
  [ "$code" = "0" ] || die "$family exited $code ($reason) — inspect logs before proceeding"
}

PRIORITY_STATES="FL,CA,TX,NY,IL,MA,GA,VA"

cmd_backfill() {
  discover
  ensure_secret_grant
  log "BACKFILL — bulk-dataset seed of the 8 priority states (current sessions)"
  echo "  This is the MANDATORY prerequisite for masterlist diffing. Bulk ZIPs,"
  echo "  ~2-3 queries/state, seeds state_bill + primes state_sync_cursor.billHashes."
  # Big states (NY≈25k bills) parse a whole ZIP in memory + upsert bill-by-bill;
  # give it a generous 40-min budget (it processes states sequentially).
  WAIT_BUDGET=2400 JOB_ENV="LEGISCAN_STATES=${PRIORITY_STATES};LEGISCAN_SESSIONS=current" \
    run_job_wait "capiro-${ENV}-api-sync-legiscan-masterlist" "api-sync-legiscan-masterlist" "backfill-legiscan-datasets"
  echo "Backfill complete. Per-state bill counts are in the task log (grep '[backfill-legiscan]')."
}

cmd_smoke() {
  discover
  ensure_secret_grant
  log "SMOKE — one masterlist diff (post-backfill: cursor primed, expect ~0 changed + NO 'never backfilled' warnings)"
  WAIT_BUDGET=900 JOB_ENV="LEGISCAN_STATES=${PRIORITY_STATES};LEGISCAN_MASTERLIST_SOURCE_SUFFIX=priority" \
    run_job_wait "capiro-${ENV}-api-sync-legiscan-masterlist" "api-sync-legiscan-masterlist" "sync-legiscan-masterlist"
  echo "Verify masterlist now diffs (not cold-skips): the log's per-state lines should"
  echo "NOT say 'never backfilled'; 'queued N changed bills' N≈0 right after a seed is correct."
}

cmd_derive() {
  discover
  log "DERIVE — canonical state_bill.status from seeded actions/votes, then a safe emit dry pass"
  WAIT_BUDGET=1200 \
    run_job_wait "capiro-${ENV}-api-sync-legiscan-bills" "api-sync-legiscan-bills" "derive-state-bill-status"
  log "EMIT — confirm the changes rail surfaces 0 (no client tracks a state bill yet → inherently gated)"
  WAIT_BUDGET=900 \
    run_job_wait "capiro-${ENV}-api-sync-legiscan-bills" "api-sync-legiscan-bills" "emit-state-changes"
  echo "Expected: emit-state-changes logs 'N material transitions, 0 emitted' (all skipped, no client). Safe to schedule."
}

###############################################################################
cmd_schedules() {
  discover
  ensure_secret_grant
  log "Creating EventBridge rules (recurring). Cadences mirror infra/cdk/lib/ingestion-schedule.ts."

  # name|family|container|cmd (space-sep)|cron|env (K=V;K2=V2 or empty)
  local WIDE_STATES="AL,AK,AZ,AR,CO,CT,DE,DC,HI,ID,IN,IA,KS,KY,LA,ME,MD,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,UT,VT,WA,WV,WI,WY"
  local JOBS=(
    "sync-legiscan-masterlist-priority|capiro-${ENV}-api-sync-legiscan-masterlist|api-sync-legiscan-masterlist|sync-legiscan-masterlist|cron(10 * * * ? *)|LEGISCAN_STATES=${PRIORITY_STATES};LEGISCAN_MASTERLIST_SOURCE_SUFFIX=priority"
    "sync-legiscan-bills|capiro-${ENV}-api-sync-legiscan-bills|api-sync-legiscan-bills|sync-legiscan-bills|cron(30 * * * ? *)|"
    "sync-state-register|capiro-${ENV}-api-sync-state-register|api-sync-state-register|sync-state-register|cron(45 6 * * ? *)|"
    "derive-state-bill-status|capiro-${ENV}-api-sync-legiscan-bills|api-sync-legiscan-bills|derive-state-bill-status|cron(50 0/6 * * ? *)|"
    "emit-state-changes|capiro-${ENV}-api-sync-legiscan-bills|api-sync-legiscan-bills|emit-state-changes|cron(55 0/6 * * ? *)|"
    "crosswalk-state-people|capiro-${ENV}-api-sync-legiscan-bills|api-sync-legiscan-bills|crosswalk-state-people|cron(20 5 * * ? *)|LEGISCAN_STATES=${PRIORITY_STATES}"
    "normalize-state-committees|capiro-${ENV}-api-sync-state-register|api-sync-state-register|normalize-state-committees|cron(30 8 ? * MON *)|"
    "geocode-facilities|capiro-${ENV}-api-sync-state-register|api-sync-state-register|geocode-facilities|cron(15 4 * * ? *)|"
  )
  # The wide-state masterlist is opt-in (INCLUDE_WIDE=1) and ONLY after the wide
  # states are backfilled — otherwise it burns ~5k queries/mo cold-cursor
  # no-op polling for zero value. Seed first: LEGISCAN_STATES="$WIDE_STATES"
  # backfill-legiscan-datasets, then re-run schedules with INCLUDE_WIDE=1.
  if [ "${INCLUDE_WIDE:-0}" = "1" ]; then
    JOBS+=("sync-legiscan-masterlist-wide|capiro-${ENV}-api-sync-legiscan-masterlist|api-sync-legiscan-masterlist|sync-legiscan-masterlist|cron(25 1/6 * * ? *)|LEGISCAN_STATES=${WIDE_STATES};LEGISCAN_MASTERLIST_SOURCE_SUFFIX=wide")
    echo "  INCLUDE_WIDE=1 → wide-state masterlist rule INCLUDED"
  else
    echo "  wide-state masterlist rule DEFERRED (set INCLUDE_WIDE=1 after wide backfill)"
  fi

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
  cmd_backfill
  cmd_smoke
  cmd_derive
  echo; read -r -p "Backfill+derive verified. Create recurring schedules now? [y/N] " yn
  [ "${yn:-N}" = "y" ] && cmd_schedules || echo "Skipped (run later: $0 schedules)."
}

###############################################################################
ACTION="${1:-help}"
case "$ACTION" in
  preflight) cmd_preflight ;;
  register)  cmd_register ;;
  backfill)  cmd_backfill ;;
  smoke)     cmd_smoke ;;
  derive)    cmd_derive ;;
  schedules) cmd_schedules ;;
  all)       cmd_all ;;
  *) sed -n '2,52p' "$0"; exit 0 ;;
esac
