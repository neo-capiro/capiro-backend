# MeriV2 Memory, Context, and Assurance Rollback

## Status and environment warning

This runbook is executable operator guidance, but **none of its mutating steps were run by the Phase 20 implementation task**.

The AWS environment named `dev` currently serves production traffic. There is no accepted staging environment in the Phase 17–20 evidence. Treat `capiro-dev` as production and do not use it for an alarm demonstration or rollback rehearsal.

## Safety principle

**Stop expansion, remove the smallest canary, and turn behavior off before rolling code back. Never drop additive columns during an incident.**

The schema is expand-only and older code ignores the new columns. A destructive down migration removes governance and audit evidence and is not the normal rollback mechanism.

## Incident roles

- **Incident commander:** authorizes rollback rung and customer-impact communication.
- **Release operator:** executes commands and records exact task definitions, flags, timestamps, and results.
- **Security reviewer:** approves any reduction in authorization, wall, legal-hold, or release-verification controls.
- **Database reviewer:** approves backfill rollback and any migration-recovery action.
- **Product owner:** validates restored user behavior and held/degraded messaging.

No implementer may be the sole approver for a production rollback.

## Rollback ladder

| Rung | Action | Typical blast radius | Schema action |
|---|---|---|---|
| 0 | Stop rollout expansion and preserve evidence | none | none |
| 1 | Remove one tenant/surface canary | one tenant or surface | none |
| 2 | Move enforce → shadow/off for one subsystem | one behavior family | none |
| 3 | Disable a scheduled rule | worker/monitor only | none |
| 4 | Restore previous service task definitions | affected services | none |
| 5 | Roll back one confirmed backfill job | exact tenant/job rows that have not drifted | no migration |
| 6 | Roll back a policy pack to a prior independently reviewed version | one tenant/pack key | no migration |
| 7 | Failed-migration recovery under a separate change | deployment | forward repair only |
| 8 | Drop columns/tables | destructive and normally prohibited | destructive |

Do not skip to a lower rung while a higher rung can contain the incident.

## Step 0 — Freeze and capture

```bash
export AWS_REGION=us-east-1
export CAPIRO_ENV=<approved-environment>
export CLUSTER="capiro-${CAPIRO_ENV}"
export INCIDENT_ID=<ticket-or-incident-id>
export EVIDENCE_DIR="evidence/${INCIDENT_ID}"
mkdir -p "$EVIDENCE_DIR"
```

Capture current services, alarms, and schedules before mutation:

```bash
for service in api web workspace meriv2-orchestrator api-strategy; do
  aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "capiro-${CAPIRO_ENV}-${service}" \
    --query 'services[0].{service:serviceName,taskDefinition:taskDefinition,desired:desiredCount,running:runningCount,pending:pendingCount,deployments:deployments}' \
    > "$EVIDENCE_DIR/${service}-before.json"
done

aws cloudwatch describe-alarms \
  --alarm-name-prefix "capiro-${CAPIRO_ENV}-meriv2-" \
  > "$EVIDENCE_DIR/alarms-before.json"

for rule in memory-projection-worker meriv2-control-monitor; do
  aws events describe-rule \
    --name "capiro-${CAPIRO_ENV}-${rule}" \
    > "$EVIDENCE_DIR/${rule}-before.json" 2>&1 || true
done
```

Record the customer-visible symptom, first observed time, affected tenant/surface, current release SHA, and rollback decision owner.

## Step 1 — Remove the smallest canary

### Assurance gate

Prefer removing the affected tenant or surface from the canary lists over changing the global mode:

```text
MERI_RELEASE_GATE_TENANTS=<remove-affected-tenant>
MERI_RELEASE_GATE_SURFACES=<remove-affected-surface>
```

A tenant/surface not present in both lists resolves to `off`. Use this for a false-positive hold or surface-specific outage.

**Do not remove assurance enforcement when the incident is unsupported or unsafe output.** In that case, stop the affected surface or hold the release rather than restoring unverified delivery.

### Context Packet v2

Clear the exact tenant/surface feature flag first:

```text
clioFeatureFlags.meriv2.contextPacketV2.<surface>=false or absent
```

If all v2 surfaces for the tenant are affected, clear:

```text
clioFeatureFlags.meriv2.contextPacketV2=false or absent
```

The global ceiling can remain `shadow` or `enforce`; a tenant without its canary stays on v1.

## Step 2 — Move one subsystem to shadow or off

Change the task-definition environment through the approved deployment mechanism, then restart only the affected services. Capture old and new task-definition ARNs.

| Subsystem | Armed value | First rollback | Full rollback | Important consequence |
|---|---|---|---|---|
| Context Packet v2 | `MERIV2_CONTEXT_PACKET_V2=enforce` | `shadow` | `off` or unset | v1 output remains authoritative; persisted packet metadata remains for evidence |
| Persisted policy packs | `MERI_POLICY_PACK_SOURCE=enforce` | `shadow` | `off` or unset | reviewed static product policy becomes authoritative; persisted pack remains auditable |
| Assurance release gate | `MERI_RELEASE_GATE=enforce` | `shadow` | `off` or unset | hold/repair enforcement stops; use only when accuracy/security impact is understood |
| Governance Center | `MEMORY_GOVERNANCE_CENTER=enforce` | n/a | `off` or unset | administrators fall back to legacy review queues |
| Review/withdrawal surface | `MEMORY_CLIENT_REVIEW=enforce` | n/a | `off` or unset | new reviewer/proposer surface hides; canonical rows are unchanged |
| Governed authorization | `MEMORY_GOVERNANCE_ENFORCE=enforce` | n/a | `off` or unset | governed grant/role enforcement stops; requires Security approval |
| Governed lifecycle/suppression | `MEMORY_GOVERNANCE_LIFECYCLE=enforce` | n/a | `off` or unset | governed bookkeeping and suppression stop; **do not disable blindly** |
| Control EMF | default on | n/a | `MERIV2_CONTROL_METRICS=off` | stops runtime metrics only; use only if logging itself is causing harm |

### Lifecycle warning

`MEMORY_GOVERNANCE_LIFECYCLE` controls terminal-state suppression and durable cleanup bookkeeping. Turning it off can make a row whose legacy status still appears active eligible to older recall paths. Leave it on during ordinary UI, policy, context, or assurance rollback.

Disable it only when:

1. the migration/schema is unavailable or lifecycle writes are causing an outage;
2. Security and Database reviewers approve;
3. a read-only query confirms there are no governed-only revoked, superseded, rejected, expired, stale, or conflicted rows that legacy status would incorrectly expose;
4. the resulting recall behavior is tested before traffic resumes.

## Step 3 — Disable scheduled rules without deleting work

### Projection worker

```bash
aws events disable-rule \
  --name "capiro-${CAPIRO_ENV}-memory-projection-worker"
```

Stopping the worker does not roll back canonical status. It permits projection obligations to accumulate. Do not delete, complete, or rewrite outbox rows to make the queue look healthy.

Read-only backlog check:

```sql
SELECT status,
       count(*) AS jobs,
       min(created_at) AS oldest_created_at,
       max(attempts) AS max_attempts
FROM memory_cleanup_outbox
GROUP BY status
ORDER BY status;
```

### MeriV2 control monitor

```bash
aws events disable-rule \
  --name "capiro-${CAPIRO_ENV}-meriv2-control-monitor"
```

Disable the monitor only if its read-only queries create measurable database pressure or the task definition is faulty. Runtime authorization, persistence, assurance, and drift metrics continue independently.

Re-enable a rule only after the task succeeds manually and its alarm state is understood:

```bash
aws events enable-rule --name "capiro-${CAPIRO_ENV}-<rule-name>"
```

## Step 4 — Restore previous task definitions

Read the previous task-definition ARNs from the rollout baseline. Do not guess revisions.

```bash
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "capiro-${CAPIRO_ENV}-api" \
  --task-definition <approved-previous-api-task-definition>
```

Repeat for the affected services. When a context, policy, or assurance wire contract changed, roll the coordinated set together:

- API;
- MeriV2 orchestrator;
- Workspace;
- Strategy API;
- web client where its display contract changed.

Wait for stability after each approved group:

```bash
aws ecs wait services-stable \
  --cluster "$CLUSTER" \
  --services "capiro-${CAPIRO_ENV}-api"
```

The additive migrations stay applied. Do not make the database “match” old code by dropping new columns.

## Step 5 — Roll back one governance backfill job

Use only the exact job produced by the prepare step. The operator must provide tenant ID, job ID, and both confirmations:

```bash
pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
  --tenant-id <tenant-uuid> \
  --rollback \
  --job-id <job-uuid> \
  --confirm-tenant <same-tenant-uuid> \
  --confirm-job <same-job-uuid> \
  | tee "$EVIDENCE_DIR/backfill-rollback.json"
```

The rollback restores only rows that still match the job’s expected post-state. A later human/system change is reported as `skipped_drift` and is not overwritten. `rollback_partial` requires Database and Security review; do not manually force the skipped rows.

See `docs/runbooks/meriv2-memory-backfill.md` for verification queries and evidence requirements.

## Step 6 — Roll back a policy pack

Policy packs are immutable after review. Rollback republishes an earlier independently reviewed target; it never edits the current published row in place.

Authorized administrator API call:

```http
POST /api/clio/policy-packs/<current-pack-row-id>/rollback/<target-pack-row-id>
Content-Type: application/json

{"reason":"<incident/change-ticket reason>"}
```

Verify:

1. the current version is retired;
2. the target version is published;
3. the rollback event names both rows;
4. future policy decisions bind the target pack/version/rule;
5. stale action approvals are invalidated and reapproved rather than silently reused.

If the policy service itself is unavailable, set `MERI_POLICY_PACK_SOURCE=shadow` or `off` first. Do not update pack status with manual SQL.

## Step 7 — Failed migration handling

A failed migration blocks release. The normal rollback remains application rollback with the additive schema retained.

Prohibited during the incident:

- direct `_prisma_migrations` edits;
- automatic `prisma migrate resolve`;
- deleting a migration directory;
- manual SQL that makes `migrate status` appear green without a reviewed forward repair.

Use `docs/runbooks/prisma-failed-migration-recovery.md` under a separate approved database change.

## Step 8 — Destructive schema rollback

Dropping governed columns or tables is not an emergency default. It destroys policy, approval, transition, backfill, and recovery evidence.

It requires all of the following:

- confirmed database snapshot and restore test;
- Legal/Security review of evidence loss;
- Database reviewer-approved down plan;
- incident commander and executive approval;
- customer-impact and audit-impact record;
- proof that rungs 1–7 cannot contain the incident.

No destructive rollback SQL is included in this runbook intentionally.

## Verification after rollback

Capture each result in the incident evidence directory:

1. Every affected ECS service is stable on the intended previous task definition and image digest.
2. The exact tenant/surface canary and global mode values match the rollback decision.
3. A real authorized user can complete the affected workflow.
4. A denied user remains unable to access walled/private content, and the denied response contains no confidential text.
5. Shared proposals still require an independent reviewer unless Security explicitly accepted an authorization rollback.
6. Legal-held memory still exposes no destructive action.
7. Context output either uses v1 or truthfully identifies a persisted v2 packet; no generated-only ID is presented as durable.
8. Policy decisions bind the expected source and pack version.
9. Assurance output matches the chosen mode; unsupported high-risk output is not silently released.
10. Outbox age/retry/dead-letter state is stable or recovering.
11. No control/audit log contains memory bodies, prompts, source excerpts, provider payloads, Clerk cookies, JWTs, or secrets.
12. MeriV2 alarms are `OK`, or every remaining `ALARM` has a named owner and incident disposition.

## Evidence closeout

The incident commander signs the rollback complete only after recording:

- trigger and impact;
- exact rollback rungs used;
- before/after task definitions and flags;
- database/backfill/policy outcomes;
- alarm timeline;
- user and confidentiality verification;
- follow-up owner and due date;
- explicit decision on whether rollout may resume.
