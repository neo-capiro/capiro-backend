# MeriV2 Memory, Context, and Assurance Rollout

## Status and authorization boundary

This is the operator procedure for the governed-memory and government-affairs assurance release. It is **not authorization to run it**. PR #679 must remain draft and unmerged until the Phase 21 release gate is satisfied.

The Capiro AWS environment named `dev` currently serves production traffic. Treat `dev` as production in every command, change ticket, and approval. Alarm demonstrations are expressly prohibited there.

## Required operators

| Role | Responsibility |
|---|---|
| Release operator | Owns command execution, timestamps, evidence capture, and stop/rollback decisions |
| Database reviewer | Approves migration replay and each backfill job plan hash |
| Security reviewer | Approves wall/grant, segregation-of-duties, audit-confidentiality, and alarm evidence |
| Product/UX reviewer | Accepts browser, accessibility, and held/degraded product states |
| Incident commander | Has authority to stop rollout and execute the rollback runbook |

The implementer may brief these operators but must not be the sole approver for migration, backfill, policy publication, or production release.

## Release prerequisites

Do not start unless every item is recorded in the change ticket:

1. One exact Git SHA passed the Phase 17 CI matrix.
2. The same SHA passed the Phase 18 clean and upgrade database rehearsals without manual SQL repair.
3. The same SHA passed every required Phase 19 authenticated browser/accessibility scenario.
4. Phase 20 control-system validation passed, including an isolated non-production alarm transition to `ALARM` and recovery to `OK`.
5. PR #679 is current with `main`, mergeable, reviewed by the four required roles, and has no unresolved blocker.
6. Current task definitions, service desired/running counts, database migration status, alarm state, and feature values have been captured.
7. A previous known-good API, MeriV2 orchestrator, Workspace, Strategy, and web image digest is recorded.
8. A named incident commander and rollback decision window are recorded.

## Operator variables

Use a new shell and set these values from the approved change ticket. Never paste secrets into the shell transcript.

```bash
export AWS_REGION=us-east-1
export CAPIRO_ENV=staging             # use dev only under explicit production approval
export AWS_ACCOUNT_ID=000000000000    # approved account
export RELEASE_SHA=<40-character-sha>
export EVIDENCE_DIR="evidence/meriv2-${RELEASE_SHA}"
mkdir -p "$EVIDENCE_DIR"
aws sts get-caller-identity | tee "$EVIDENCE_DIR/00-caller.json"
```

Fail closed if the account or region is not the approved target:

```bash
test "$(aws sts get-caller-identity --query Account --output text)" = "$AWS_ACCOUNT_ID"
test "$AWS_REGION" = "$(aws configure get region)" || export AWS_DEFAULT_REGION="$AWS_REGION"
test "$CAPIRO_ENV" != "dev" || test "${PRODUCTION_CHANGE_APPROVED:-}" = "YES"
```

## Step 1 — Reconfirm the exact release artifact

From a clean authenticated checkout:

```bash
git fetch origin main agent/meriv2-world-class-closeout
git checkout --detach "$RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
git status --short | tee "$EVIDENCE_DIR/01-git-status.txt"
pnpm install --frozen-lockfile
```

Run the committed release commands rather than an improvised subset:

```bash
pnpm --filter @capiro/meriv2-core typecheck
pnpm --filter @capiro/api typecheck
pnpm --filter @capiro/meriv2-orchestrator typecheck
pnpm --filter @capiro/workspace typecheck
pnpm --filter @capiro/api-strategy typecheck
pnpm --filter @capiro/web typecheck
pnpm --filter @capiro/infra-cdk typecheck
```

The Phase 17 workflow remains the authoritative full command matrix. Store its run URL and artifact identifiers in the change ticket.

## Step 2 — Capture the live baseline before any change

```bash
export CLUSTER="capiro-${CAPIRO_ENV}"
for service in api web workspace meriv2-orchestrator api-strategy; do
  aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "capiro-${CAPIRO_ENV}-${service}" \
    --query 'services[0].{service:serviceName,taskDefinition:taskDefinition,desired:desiredCount,running:runningCount,pending:pendingCount,deployments:deployments}' \
    > "$EVIDENCE_DIR/02-${service}-baseline.json"
done

aws cloudwatch describe-alarms \
  --alarm-name-prefix "capiro-${CAPIRO_ENV}-meriv2-" \
  > "$EVIDENCE_DIR/02-meriv2-alarm-baseline.json"

aws events describe-rule \
  --name "capiro-${CAPIRO_ENV}-memory-projection-worker" \
  > "$EVIDENCE_DIR/02-projection-rule.json"

aws events describe-rule \
  --name "capiro-${CAPIRO_ENV}-meriv2-control-monitor" \
  > "$EVIDENCE_DIR/02-control-monitor-rule.json" 2>&1 || true
```

Stop if any core service is already degraded, a migration is in progress, or an unexplained MeriV2 alarm is active.

## Step 3 — Deploy code with every new control dark

The deployment pipeline must publish images by immutable digest and update services without activating the controls. Required initial values are:

```text
MEMORY_GOVERNANCE_LIFECYCLE=off or unset
MEMORY_GOVERNANCE_ENFORCE=off or unset
MEMORY_GOVERNANCE_CENTER=off or unset
MEMORY_CLIENT_REVIEW=off or unset
MERIV2_CONTEXT_PACKET_V2=off or unset
MERI_POLICY_PACK_SOURCE=off or unset
MERI_RELEASE_GATE=off or unset
MERI_RELEASE_GATE_TENANTS=unset
MERI_RELEASE_GATE_SURFACES=unset
MEMORY_AUTOLEARN_GOVERNED=false or unset
MERIV2_CONTROL_METRICS=on or unset (observability only; `off` is its kill switch)
```

The MeriV2 control stack may be deployed at this point only with the monitor schedule disabled:

```bash
pnpm --filter @capiro/infra-cdk exec cdk synth \
  "Capiro-${CAPIRO_ENV}-MeriV2Control" \
  --context env="$CAPIRO_ENV" \
  --context account="$AWS_ACCOUNT_ID" \
  --context enableMeriV2ControlMonitor=false \
  > "$EVIDENCE_DIR/03-control-stack-synth.txt"
```

Use the repository’s authorized deployment pipeline for service/image updates. Do not deploy the full Compute stack solely to change environment variables when that stack is known to contain drifted live resources; use the approved task-definition/service-update procedure and preserve the baseline task-definition ARNs.

After the dark deployment, verify existing user-visible behavior is unchanged and all services stabilize before proceeding.

## Step 4 — Apply additive database migrations

Run the dedicated `capiro-${CAPIRO_ENV}-api-migrate` task definition through the approved one-off ECS procedure. The container command is `migrate`; it executes `prisma migrate deploy` and does not edit failed migration history.

Record:

- task ARN;
- task-definition ARN and image digest;
- start/stop timestamps;
- exit code;
- `/capiro/${CAPIRO_ENV}/api-migrate` log stream;
- `prisma migrate status` after completion.

Stop immediately on any failed migration. Do not use `prisma migrate resolve`, direct `_prisma_migrations` edits, or manual SQL repair during the release. Follow the failed-migration recovery runbook under a separate approved change.

## Step 5 — Run read-only post-migration diagnostics

Before any backfill or feature activation, run the monitor manually once using the new task definition or a secure operator shell:

```bash
pnpm --filter @capiro/api exec tsx scripts/emit-meriv2-control-metrics.ts \
  | tee "$EVIDENCE_DIR/05-control-snapshot.log"
```

Also run:

```bash
pnpm --filter @capiro/api exec tsx scripts/diag-memory-governance-v2.ts \
  --tenant-id <canary-tenant-uuid> \
  | tee "$EVIDENCE_DIR/05-canary-governance.json"
```

Expected state before backfill: legacy rows may be unclassified, but no migration/schema error, cross-tenant leakage, dead-letter obligation, or unexplained persistence failure may appear.

## Step 6 — Prepare and approve each tenant backfill

Use `docs/runbooks/meriv2-memory-backfill.md`. The sequence is tenant-by-tenant:

1. prepare/dry run;
2. retain job ID, plan hash, counts, and quarantine list;
3. database reviewer approves that exact job;
4. execute with both tenant and job confirmations;
5. verify exact convergence;
6. do not proceed to the next tenant if drift is blocked or quarantine is unexplained.

A code deployment never executes the backfill automatically.

## Step 7 — Enable the control monitor before product enforcement

After its task runs successfully on the migrated schema, enable only the separate control stack schedule:

```bash
pnpm --filter @capiro/infra-cdk exec cdk diff \
  "Capiro-${CAPIRO_ENV}-MeriV2Control" \
  --context env="$CAPIRO_ENV" \
  --context account="$AWS_ACCOUNT_ID" \
  --context enableMeriV2ControlMonitor=true \
  | tee "$EVIDENCE_DIR/07-control-stack-diff.txt"
```

Deploy that one stack under the approved pipeline. Verify two consecutive successful five-minute snapshots and that all expected metrics exist with only the `Environment` dimension.

## Step 8 — Activate controls in the approved order

Change one layer at a time. Complete the observation window and evidence checklist before advancing.

### 8.1 Governed lifecycle and recall suppression

Set:

```text
MEMORY_GOVERNANCE_LIFECYCLE=enforce
```

Verify candidate bookkeeping, governed statuses, transition evidence, terminal-state recall suppression, and outbox enqueue behavior. Stop on any recall regression or projection backlog.

### 8.2 Canonical authorization

Set:

```text
MEMORY_GOVERNANCE_ENFORCE=enforce
```

Verify private ownership, firm admin authority, client wall access, explicit review grants, archived-client denial, legal holds, and self-review denial.

### 8.3 Review and administrator surfaces

Set:

```text
MEMORY_CLIENT_REVIEW=enforce
MEMORY_GOVERNANCE_CENTER=enforce
```

Verify standard-user proposer history, independent reviewer queues, administrator Governance Center, transitions, grants, conflicts, and projection health.

### 8.4 Context Packet v2 shadow canary

Set global ceiling:

```text
MERIV2_CONTEXT_PACKET_V2=shadow
```

Then enable the exact canary tenant and surface flags in server-owned tenant settings:

```text
clioFeatureFlags.meriv2.contextPacketV2=true
clioFeatureFlags.meriv2.contextPacketV2.<surface>=true
```

Start with one internal tenant and one surface. Compare v1/v2 shadow evidence, persisted packet IDs, exclusions, health, and wall behavior. Expand surfaces only after the prior surface is accepted.

### 8.5 Persisted policy-pack shadow

Set:

```text
MERI_POLICY_PACK_SOURCE=shadow
```

The static reviewed product baseline remains authoritative. Verify selected persisted pack/version/rule, integrity rejection, shadow decision differences, and bounded decision audit before considering enforce.

### 8.6 Assurance release gate shadow

Set all three controls explicitly:

```text
MERI_RELEASE_GATE=shadow
MERI_RELEASE_GATE_TENANTS=<internal-tenant-uuid>
MERI_RELEASE_GATE_SURFACES=<one-surface>
```

Observe release decisions, unsupported high-risk rate, held/degraded posture, verification latency, and user-visible shadow parity. Do not use `all` tenants or `all` surfaces during the first canary.

### 8.7 Context, policy, and assurance enforcement

Only after shadow acceptance:

```text
MERIV2_CONTEXT_PACKET_V2=enforce
MERI_POLICY_PACK_SOURCE=enforce
MERI_RELEASE_GATE=enforce
```

Keep the exact tenant and surface canary lists. Enforce expansion order:

1. internal low-risk surface;
2. internal chat/in-editor;
3. Workspace generation;
4. Strategy/Steward;
5. memo/district brief;
6. outreach or external action surfaces last.

For every expansion, record the task definition, tenant/surface set, start time, dashboard screenshots, held/degraded counts, customer-impact review, and go/no-go decision.

## Stop conditions

Stop expansion and execute the rollback runbook when any of these occurs:

- tenant/user or ethical-wall isolation failure;
- a self-review or policy four-eyes bypass succeeds;
- required Context Packet persistence fails;
- unsupported high-risk prose is released or persisted;
- destination verification accepts stale context/policy binding;
- outbox oldest age exceeds 15 minutes, a job reaches dead-letter, or the worker crashes repeatedly;
- backfill drift or quarantine is unexplained;
- legal-held data is mutated destructively;
- audit/control evidence includes customer prose, source excerpts, session tokens, or secrets;
- a core ECS service does not stabilize on the new task definition;
- any Phase 20 alarm enters `ALARM` without a documented expected cause.

## Completion evidence

The release operator must attach:

- exact base/head/release SHAs;
- image digests and task-definition ARNs;
- migration task and status output;
- each backfill job/plan hash and reviewer approval;
- feature values and tenant/surface canary lists at every stage;
- dashboard and alarm-state exports;
- browser and accessibility evidence;
- Context Packet, policy-binding, and assurance summaries containing no content;
- final service stability and rollback-readiness confirmation.

A rollout is not complete while any acceptance item is described as “not executed,” “blocked,” “pending,” or “to be verified.”
