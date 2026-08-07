#!/usr/bin/env bash
#
# engagement-api read-only infrastructure discovery.
#
# Observes the intended environment and writes an evidence file. It performs NO
# mutation: every AWS call goes through `aws_ro`, which refuses any operation
# that is not describe/list/get/lookup. Adding a mutating call without also
# editing that allowlist fails loudly instead of silently changing AWS.
#
# JSON is assembled with node rather than jq. Sibling deploy scripts use jq, but
# node is a hard dependency of this repo and jq is not, so the spec for this
# script can run anywhere CI or a laptop can run the monorepo.
#
# Required environment:
#   AWS_REGION
#   CAPIRO_ENV                          dev | staging | prod
#   EXPECTED_AWS_ACCOUNT_ID
#   EXPECTED_VPC_ID
#   EXPECTED_ECS_CLUSTER_ARN
#   EXPECTED_HTTPS_LISTENER_ARN
#   EXPECTED_MAIN_API_TARGET_GROUP_ARN
#   EXPECTED_GENERIC_API_RULE_PRIORITY  live value, e.g. 10 on capiro-prod-alb
#
# Optional:
#   AWS_BIN                             aws binary (the spec injects a fake)
#   NODE_BIN                            node binary
#   ENGAGEMENT_DISCOVERY_OUT_DIR        default .artifacts/engagement-phase2/<env>
#   PREVIEW_RULE_PRIORITY               default 6
#
# Exit: 0 clean · 1 usage error · 2 one or more stop conditions
set -euo pipefail
export MSYS_NO_PATHCONV=1

AWS_BIN="${AWS_BIN:-aws}"
NODE_BIN="${NODE_BIN:-node}"
PREVIEW_RULE_PRIORITY="${PREVIEW_RULE_PRIORITY:-6}"

die() { printf 'ERROR %s\n' "$*" >&2; exit 1; }

# ── read-only enforcement ────────────────────────────────────────────────────
aws_ro() {
  local service="$1" operation="$2"
  shift 2
  case "$operation" in
    describe-*|list-*|get-*|lookup-*) ;;
    *) die "refusing non read-only AWS call: ${service} ${operation}" ;;
  esac
  "$AWS_BIN" "$service" "$operation" --region "$AWS_REGION" "$@"
}

# Best-effort call: a denied or empty listing must not abort discovery, because
# "cannot see it" and "it does not exist" are different findings and the report
# distinguishes them.
aws_ro_soft() {
  aws_ro "$@" 2>/dev/null || echo 'null'
}

for var in AWS_REGION CAPIRO_ENV EXPECTED_AWS_ACCOUNT_ID EXPECTED_VPC_ID \
           EXPECTED_ECS_CLUSTER_ARN EXPECTED_HTTPS_LISTENER_ARN \
           EXPECTED_MAIN_API_TARGET_GROUP_ARN EXPECTED_GENERIC_API_RULE_PRIORITY; do
  [ -n "${!var:-}" ] || die "$var is required"
done

case "$CAPIRO_ENV" in
  dev|staging|prod) ;;
  *) die "CAPIRO_ENV must be dev, staging or prod (got '$CAPIRO_ENV')" ;;
esac

OUT_DIR="${ENGAGEMENT_DISCOVERY_OUT_DIR:-.artifacts/engagement-phase2/${CAPIRO_ENV}}"
mkdir -p "$OUT_DIR"
OUT_JSON="${OUT_DIR}/discovery.json"
OUT_SHA="${OUT_DIR}/discovery.sha256"

# Raw responses live beside the evidence, NOT in `mktemp -d`. On Git Bash
# mktemp returns a POSIX path such as /tmp/tmp.XXXX, which Windows node then
# resolves against the current drive root — every response would read as null
# and discovery would invent stop conditions from an empty report.
RAW="${OUT_DIR}/.raw"
rm -rf "$RAW"
mkdir -p "$RAW"
cleanup() { rm -rf "$RAW"; }
trap cleanup EXIT

echo "==> engagement-api read-only discovery (${CAPIRO_ENV} / ${AWS_REGION})"

# ── collect (read-only) ──────────────────────────────────────────────────────
aws_ro sts get-caller-identity --output json > "$RAW/caller.json"
aws_ro_soft ec2 describe-vpcs --vpc-ids "$EXPECTED_VPC_ID" --output json > "$RAW/vpcs.json"
aws_ro_soft ec2 describe-subnets \
  --filters "Name=vpc-id,Values=${EXPECTED_VPC_ID}" --output json > "$RAW/subnets.json"
aws_ro_soft ecs describe-clusters \
  --clusters "$EXPECTED_ECS_CLUSTER_ARN" --output json > "$RAW/clusters.json"
aws_ro_soft elbv2 describe-listeners \
  --listener-arns "$EXPECTED_HTTPS_LISTENER_ARN" --output json > "$RAW/listeners.json"
aws_ro_soft elbv2 describe-rules \
  --listener-arn "$EXPECTED_HTTPS_LISTENER_ARN" --output json > "$RAW/rules.json"
aws_ro_soft elbv2 describe-target-groups --output json > "$RAW/target-groups.json"
aws_ro_soft ecr describe-repositories --output json > "$RAW/ecr.json"
aws_ro_soft ecs list-services \
  --cluster "$EXPECTED_ECS_CLUSTER_ARN" --output json > "$RAW/services.json"
aws_ro_soft cloudformation list-stacks --output json > "$RAW/stacks.json"
aws_ro_soft rds describe-db-clusters --output json > "$RAW/aurora.json"

# ── assemble and evaluate ────────────────────────────────────────────────────
# Secret VALUES are never read. Only ARNs and identifiers are recorded.
# `|| NODE_STATUS=$?` is load-bearing: under `set -e` a nonzero exit would abort
# the script before the report hash is written and the summary is printed.
NODE_STATUS=0
"$NODE_BIN" - "$RAW" "$OUT_JSON" <<'NODE' || NODE_STATUS=$?
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const [raw, outFile] = process.argv.slice(2);
const load = (name) => {
  try {
    const text = readFileSync(path.join(raw, name), 'utf8').trim();
    return text && text !== 'null' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const env = process.env;
const previewPriority = String(env.PREVIEW_RULE_PRIORITY || '6');
const genericPriority = String(env.EXPECTED_GENERIC_API_RULE_PRIORITY);
const stops = [];
const stop = (message) => stops.push(message);

// identity. An unreadable response is reported as such rather than surfacing
// as a confusing "account null does not match" further down.
const caller = load('caller.json');
if (caller === null) {
  stop('could not read the caller-identity response; discovery collected nothing');
}
const account = caller?.Account ?? null;
if (account !== env.EXPECTED_AWS_ACCOUNT_ID) {
  stop(`account ${account} does not match expected ${env.EXPECTED_AWS_ACCOUNT_ID}`);
}

// network
const vpcs = load('vpcs.json')?.Vpcs ?? [];
if (vpcs.length !== 1) stop(`VPC ${env.EXPECTED_VPC_ID} was not found`);

const privateSubnets = (load('subnets.json')?.Subnets ?? [])
  .filter((s) => s.MapPublicIpOnLaunch === false)
  .map((s) => ({ id: s.SubnetId, az: s.AvailabilityZone }))
  .sort((a, b) => a.id.localeCompare(b.id));
const azCount = new Set(privateSubnets.map((s) => s.az)).size;
if (privateSubnets.length < 2 || azCount < 2) {
  stop(
    `need at least two private subnets across two AZs; found ` +
      `${privateSubnets.length} subnet(s) in ${azCount} AZ(s)`,
  );
}

// cluster
const clusterStatus = load('clusters.json')?.clusters?.[0]?.status ?? 'MISSING';
if (clusterStatus !== 'ACTIVE') stop(`ECS cluster is ${clusterStatus}, expected ACTIVE`);

// listener must be unambiguous
const listeners = load('listeners.json')?.Listeners ?? [];
if (listeners.length !== 1) {
  stop(
    `expected exactly one HTTPS listener, found ${listeners.length} — ` +
      `resolve the ambiguity before deploying`,
  );
}

// rules
const rules = (load('rules.json')?.Rules ?? []).map((r) => ({
  arn: r.RuleArn,
  priority: String(r.Priority),
  conditions: (r.Conditions ?? []).map((c) => ({
    field: c.Field,
    values: c.Values ?? c.PathPatternConfig?.Values ?? [],
    header: c.HttpHeaderConfig?.HttpHeaderName ?? null,
    headerValues: c.HttpHeaderConfig?.Values ?? [],
  })),
  targetGroups: (r.Actions ?? []).flatMap((a) =>
    a.TargetGroupArn
      ? [a.TargetGroupArn]
      : (a.ForwardConfig?.TargetGroups ?? []).map((t) => t.TargetGroupArn),
  ),
}));
rules.sort((a, b) => a.priority.localeCompare(b.priority, undefined, { numeric: true }));

const valuesOf = (rule) => rule.conditions.flatMap((c) => c.values ?? []);

if (rules.some((r) => r.priority === previewPriority)) {
  stop(`preview priority ${previewPriority} is already occupied`);
}

const generic = rules.find((r) => r.priority === genericPriority);
if (!generic) {
  stop(`generic /api/* rule at priority ${genericPriority} was not found`);
} else {
  if (!valuesOf(generic).includes('/api/*')) stop('generic rule does not match /api/*');
  if (generic.targetGroups.length !== 1 || generic.targetGroups[0] !== env.EXPECTED_MAIN_API_TARGET_GROUP_ARN) {
    stop('generic /api/* rule does not forward solely to the expected main API target group');
  }
}

const engagementRules = rules.filter((r) =>
  valuesOf(r).some((v) => String(v).startsWith('/api/engagement')),
);
if (engagementRules.length > 0) {
  stop(`an /api/engagement/* listener rule already exists (${engagementRules.length})`);
}

const recallRules = rules.filter((r) =>
  valuesOf(r).some((v) => String(v).startsWith('/webhooks/recall')),
);

// collisions — an unknown engagement-api resource must never be adopted
const matches = (list, pick) =>
  (list ?? []).map(pick).filter((n) => typeof n === 'string' && n.includes('engagement-api'));

const collisions = {
  ecrRepositories: matches(load('ecr.json')?.repositories, (r) => r.repositoryName),
  targetGroups: matches(load('target-groups.json')?.TargetGroups, (t) => t.TargetGroupName),
  ecsServices: matches(load('services.json')?.serviceArns, (a) => a),
  cloudFormationStacks: (load('stacks.json')?.StackSummaries ?? [])
    .filter((s) => s.StackStatus !== 'DELETE_COMPLETE' && /EngagementApi/.test(s.StackName ?? ''))
    .map((s) => s.StackName),
};
for (const [label, found] of Object.entries(collisions)) {
  if (found.length > 0) stop(`unexpected existing engagement-api ${label}: ${found.join(', ')}`);
}

const report = {
  schemaVersion: 1,
  readOnly: true,
  environment: env.CAPIRO_ENV,
  region: env.AWS_REGION,
  account,
  callerArn: caller.Arn ?? null,
  vpcId: env.EXPECTED_VPC_ID,
  privateSubnets,
  ecsClusterArn: env.EXPECTED_ECS_CLUSTER_ARN,
  ecsClusterStatus: clusterStatus,
  httpsListenerArn: env.EXPECTED_HTTPS_LISTENER_ARN,
  mainApiTargetGroupArn: env.EXPECTED_MAIN_API_TARGET_GROUP_ARN,
  genericApiRulePriority: genericPriority,
  previewRulePriority: previewPriority,
  previewHeader: { name: 'X-Capiro-Engagement-Preview', value: 'v3' },
  listenerRules: rules,
  existingEngagementRules: engagementRules,
  recallRules,
  collisions,
  auroraClusters: (load('aurora.json')?.DBClusters ?? []).map((c) => ({
    id: c.DBClusterIdentifier,
    engine: c.Engine,
    status: c.Status,
  })),
  stopConditions: stops,
};

writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
for (const message of stops) console.error(`STOP  ${message}`);
process.exit(stops.length > 0 ? 2 : 0);
NODE

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT_JSON" | awk '{print $1}' > "$OUT_SHA"
else
  shasum -a 256 "$OUT_JSON" | awk '{print $1}' > "$OUT_SHA"
fi

echo "==> wrote ${OUT_JSON}"
echo "==> sha256 $(cat "$OUT_SHA")"

if [ "$NODE_STATUS" -ne 0 ]; then
  echo ""
  echo "NOT_APPROVED — see stopConditions in ${OUT_JSON}" >&2
  exit 2
fi

echo ""
echo "ENGAGEMENT_API_DISCOVERY_CLEAN"
