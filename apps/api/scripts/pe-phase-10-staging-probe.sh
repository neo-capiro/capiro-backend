#!/usr/bin/env bash
# Phase 10 — read-only inventory probe for the authorized sole live plane (env=dev).
#
# Target: ECS cluster capiro-dev + Capiro-dev-* stacks + live Aurora.
# NEVER: secrets GetSecretValue, ecs update-service, run-task migrate,
# prisma against shared Aurora, CDK deploy, or force-new-deployment.
#
# Usage (from repo root, with AWS credentials for expected account):
#   AWS_PROFILE=capiro-dev bash apps/api/scripts/pe-phase-10-staging-probe.sh
#   bash apps/api/scripts/pe-phase-10-staging-probe.sh --json > /tmp/pe10-inv.json
#
# Exit:
#   0  probe completed (plane may still be unhealthy — check JSON healthyCompute)
#   2  wrong/missing AWS credentials or fatal CLI error
#   3  wrong AWS account
set -euo pipefail
export MSYS_NO_PATHCONV=1

ACCOUNT_EXPECT="967807252336"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$REGION"
CLUSTER_EXPECT="capiro-dev"
API_SVC="capiro-dev-api"
WEB_SVC="capiro-dev-web"
COMPUTE_STACK="Capiro-dev-Compute"
DATA_STACK="Capiro-dev-Data"
NETWORK_STACK="Capiro-dev-Network"
JSON_OUT=false
for a in "$@"; do
  case "$a" in
    --json) JSON_OUT=true ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "FATAL: missing $1" >&2; exit 2; }; }
need aws
need python

ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [[ -z "${ACCOUNT}" || "${ACCOUNT}" == "None" ]]; then
  echo "FATAL: aws sts get-caller-identity failed (set AWS_PROFILE=capiro-dev)" >&2
  exit 2
fi
if [[ "$ACCOUNT" != "$ACCOUNT_EXPECT" ]]; then
  echo "FATAL: wrong AWS account $ACCOUNT (expected $ACCOUNT_EXPECT)" >&2
  exit 3
fi

cluster_status="$(aws ecs describe-clusters --clusters "$CLUSTER_EXPECT" \
  --query 'clusters[0].status' --output text 2>/dev/null || echo NONE)"
if [[ "$cluster_status" == "None" || "$cluster_status" == "NONE" || -z "$cluster_status" ]]; then
  cluster_status="MISSING"
  ecs_exists=false
else
  ecs_exists=true
fi

api_arn="$(aws ecs describe-services --cluster "$CLUSTER_EXPECT" --services "$API_SVC" \
  --query 'services[0].serviceArn' --output text 2>/dev/null || echo NONE)"
web_arn="$(aws ecs describe-services --cluster "$CLUSTER_EXPECT" --services "$WEB_SVC" \
  --query 'services[0].serviceArn' --output text 2>/dev/null || echo NONE)"
api_td="$(aws ecs describe-services --cluster "$CLUSTER_EXPECT" --services "$API_SVC" \
  --query 'services[0].taskDefinition' --output text 2>/dev/null || echo NONE)"
web_td="$(aws ecs describe-services --cluster "$CLUSTER_EXPECT" --services "$WEB_SVC" \
  --query 'services[0].taskDefinition' --output text 2>/dev/null || echo NONE)"
api_exists=false; web_exists=false
[[ -n "$api_arn" && "$api_arn" != "None" && "$api_arn" != "NONE" ]] && api_exists=true
[[ -n "$web_arn" && "$web_arn" != "None" && "$web_arn" != "NONE" ]] && web_exists=true

stack_status() {
  local n="$1"
  aws cloudformation describe-stacks --stack-name "$n" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING
}
compute_st="$(stack_status "$COMPUTE_STACK")"
data_st="$(stack_status "$DATA_STACK")"
network_st="$(stack_status "$NETWORK_STACK")"

cf_aurora_phys="$(aws cloudformation describe-stack-resource \
  --stack-name "$DATA_STACK" --logical-resource-id AuroraCluster23D869C0 \
  --query 'StackResourceDetail.PhysicalResourceId' --output text 2>/dev/null || echo NONE)"

aurora_live=false
aurora_id=""
if [[ -n "$cf_aurora_phys" && "$cf_aurora_phys" != "None" && "$cf_aurora_phys" != "NONE" ]]; then
  live="$(aws rds describe-db-clusters --db-cluster-identifier "$cf_aurora_phys" \
    --query 'DBClusters[0].Status' --output text 2>/dev/null || echo NOTFOUND)"
  if [[ "$live" != "NOTFOUND" && "$live" != "None" && -n "$live" && "$live" != "MISSING" ]]; then
    if [[ "$live" == "available" || "$live" == "backing-up" || "$live" == "modifying" ]]; then
      aurora_live=true
      aurora_id="$cf_aurora_phys"
    fi
  fi
fi
if ! $aurora_live; then
  scan="$(aws rds describe-db-clusters --query "DBClusters[?contains(DBClusterIdentifier, 'capiro-dev')].DBClusterIdentifier" --output text 2>/dev/null || true)"
  if [[ -n "${scan// /}" ]]; then
    aurora_live=true
    aurora_id="$(echo "$scan" | awk '{print $1}')"
  fi
fi

# Forbidden / unintended clusters (must never deploy here)
forbidden_present=false
for fc in capiro-staging capiro-prod-os-capiro; do
  st="$(aws ecs describe-clusters --clusters "$fc" --query 'clusters[0].status' --output text 2>/dev/null || echo NONE)"
  if [[ "$st" != "None" && "$st" != "NONE" && "$st" != "MISSING" && -n "$st" ]]; then
    forbidden_present=true
  fi
done

secret_count="$(aws secretsmanager list-secrets --output json 2>/dev/null \
  | python -c 'import json,sys
try:
  d=json.load(sys.stdin)
  n=sum(1 for s in d.get("SecretList",[]) if str(s.get("Name","")).startswith("/capiro/dev/"))
  print(n)
except Exception:
  print(0)' || echo 0)"

captured="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u)"

export PE10_ACCOUNT="$ACCOUNT"
export PE10_REGION="$REGION"
export PE10_ECS_EXISTS="$ecs_exists"
export PE10_ECS_STATUS="$cluster_status"
export PE10_API_EXISTS="$api_exists"
export PE10_WEB_EXISTS="$web_exists"
export PE10_API_TD="$api_td"
export PE10_WEB_TD="$web_td"
export PE10_COMPUTE="$compute_st"
export PE10_DATA="$data_st"
export PE10_NETWORK="$network_st"
export PE10_AURORA_LIVE="$aurora_live"
export PE10_AURORA_ID="$aurora_id"
export PE10_CF_AURORA="$cf_aurora_phys"
export PE10_FORBIDDEN="$forbidden_present"
export PE10_SECRET_COUNT="$secret_count"
export PE10_CAPTURED="$captured"
export PE10_CLUSTER="$CLUSTER_EXPECT"
export PE10_API_SVC="$API_SVC"
export PE10_WEB_SVC="$WEB_SVC"

python - <<'PY'
import json, os

def b(name):
    return str(os.environ.get(name, "")).lower() in ("true", "1", "yes")

ecs_exists = b("PE10_ECS_EXISTS")
api = b("PE10_API_EXISTS")
web = b("PE10_WEB_EXISTS")
aurora = b("PE10_AURORA_LIVE")
compute = os.environ.get("PE10_COMPUTE") or "MISSING"
data = os.environ.get("PE10_DATA") or "MISSING"
network = os.environ.get("PE10_NETWORK") or "MISSING"
ecs_status = os.environ.get("PE10_ECS_STATUS") or "MISSING"
account = os.environ.get("PE10_ACCOUNT")
cluster = os.environ.get("PE10_CLUSTER") or "capiro-dev"
api_svc = os.environ.get("PE10_API_SVC") or "capiro-dev-api"
web_svc = os.environ.get("PE10_WEB_SVC") or "capiro-dev-web"
blockers = []
warnings = []
if not ecs_exists:
    blockers.append(f"ECS cluster {cluster} does not exist (status={ecs_status})")
elif ecs_status != "ACTIVE":
    blockers.append(f"ECS cluster {cluster} status={ecs_status} (want ACTIVE)")
# CF compute rollback is advisory when ECS is live (known out-of-band drift)
if compute == "MISSING":
    warnings.append(f"Compute stack missing (advisory)")
elif "ROLLBACK" in compute or "FAILED" in compute:
    warnings.append(f"Compute stack status={compute} — known drift; ECS live health authoritative")
elif not compute.endswith("COMPLETE"):
    blockers.append(f"Compute stack status={compute}")
if not api:
    blockers.append(f"API service {api_svc} missing")
if not web:
    blockers.append(f"WEB service {web_svc} missing")
if not aurora:
    blockers.append(
        "Sole-live Aurora not live in RDS (CF physical id may be phantom: %s)"
        % (os.environ.get("PE10_CF_AURORA") or "n/a")
    )
if account and account != "967807252336":
    blockers.append(f"wrong account {account}")

healthy = (
    account == "967807252336"
    and ecs_exists
    and ecs_status == "ACTIVE"
    and api
    and web
    and aurora
    and len(blockers) == 0
)

if b("PE10_FORBIDDEN"):
    warnings.append(
        "Forbidden clusters capiro-staging / capiro-prod-os-capiro are present; Phase 10 must not deploy to them"
    )

prior = []
for fam, arn in (("capiro-dev-api", os.environ.get("PE10_API_TD")), ("capiro-dev-web", os.environ.get("PE10_WEB_TD"))):
    if arn and arn not in ("None", "NONE", ""):
        rev = None
        try:
            rev = int(str(arn).rsplit(":", 1)[-1])
        except Exception:
            rev = None
        prior.append({"family": fam, "revision": rev, "arn": arn, "image": None})

doc = {
    "probeVersion": 2,
    "planeName": "sole-live-env-dev",
    "workflowEnv": "dev",
    "accountId": account,
    "region": os.environ.get("PE10_REGION"),
    "probeOk": True,
    "ecsClusterName": cluster,
    "ecsClusterExists": ecs_exists,
    "ecsClusterStatus": None if ecs_status in ("MISSING", "None") else ecs_status,
    "apiServiceExists": api,
    "webServiceExists": web,
    "apiTaskDefinitionArn": os.environ.get("PE10_API_TD") if os.environ.get("PE10_API_TD") not in (None, "None", "NONE") else None,
    "webTaskDefinitionArn": os.environ.get("PE10_WEB_TD") if os.environ.get("PE10_WEB_TD") not in (None, "None", "NONE") else None,
    "priorTaskDefs": prior,
    "computeStackStatus": compute,
    "dataStackStatus": data,
    "networkStackStatus": network,
    "auroraClusterLive": aurora,
    "auroraClusterId": os.environ.get("PE10_AURORA_ID") or None,
    "cfAuroraPhysicalId": os.environ.get("PE10_CF_AURORA") or None,
    "forbiddenClusterPresent": b("PE10_FORBIDDEN"),
    "stagingSecretNameCount": int(os.environ.get("PE10_SECRET_COUNT") or "0"),
    "devSecretNameCount": int(os.environ.get("PE10_SECRET_COUNT") or "0"),
    "healthyCompute": healthy,
    "blockers": blockers,
    "warnings": warnings,
    "capturedAt": os.environ.get("PE10_CAPTURED"),
    "safety": {
        "secretsGetValue": False,
        "ecsUpdateService": False,
        "runTaskMigrate": False,
        "cdkDeploy": False,
    },
}
print(json.dumps(doc, indent=2, sort_keys=True))
PY

if ! $JSON_OUT; then
  echo "PE_PHASE_10_STAGING_PROBE_OK account=$ACCOUNT cluster=$cluster_status compute=$compute_st aurora_live=$aurora_live plane=capiro-dev" >&2
fi

exit 0
