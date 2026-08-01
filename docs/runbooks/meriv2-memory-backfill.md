# MeriV2 Governed-Memory Backfill

## Purpose and safety contract

This runbook classifies legacy `memory_items` into the governed-memory vocabulary using a durable, tenant-scoped, hash-bound job. The operator always prepares first. Preparation writes only the control-plane snapshot and does **not** mutate canonical memory.

Execution and rollback require the exact tenant ID, job ID, and two matching confirmations. A row that changes after preparation is not overwritten. A row that changes after execution is not forcibly restored during rollback.

No command in this runbook was executed against a shared or production database by the Phase 20 implementation task.

## Preconditions

1. The Phase 18 clean and upgrade migration rehearsals passed on the exact release SHA.
2. The migrations containing `memory_governance_backfill_job`, `memory_governance_backfill_row`, `memory_governance_backfill_event`, and delete/immutability guards are applied.
3. `prisma migrate status` is green; no migration is running or failed.
4. The target tenant UUID is confirmed from a server-owned source.
5. A database reviewer and a tenant/security reviewer are named.
6. A current database snapshot and restore procedure are verified.
7. No concurrent bulk memory migration, purge, or tenant deletion is running.
8. The operator has a secure application-role or approved one-off ECS path. Do not paste database credentials into evidence.

## Operator variables

```bash
export TENANT_ID=<tenant-uuid>
export EVIDENCE_DIR="evidence/memory-backfill-${TENANT_ID}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_DIR"
```

Validate UUID form before continuing:

```bash
printf '%s' "$TENANT_ID" | grep -Eq '^[0-9a-fA-F-]{36}$'
```

## Step 1 — Confirm migration and tenant readiness

```bash
pnpm --filter @capiro/api exec prisma migrate status \
  | tee "$EVIDENCE_DIR/01-migrate-status.txt"
```

Read-only tenant and memory counts:

```sql
SELECT id, slug, name, status
FROM tenants
WHERE id = '<tenant-uuid>'::uuid;

SELECT memory_class, memory_scope, governed_status, count(*)
FROM memory_items
WHERE tenant_id = '<tenant-uuid>'::uuid
GROUP BY memory_class, memory_scope, governed_status
ORDER BY memory_class, memory_scope, governed_status;
```

Stop if the tenant does not resolve exactly once or is undergoing deletion/suspension work that would invalidate the snapshot.

## Step 2 — Prepare the durable dry-run job

Preparation is the default action. Do not pass execution or confirmation flags:

```bash
pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
  --tenant-id "$TENANT_ID" \
  | tee "$EVIDENCE_DIR/02-prepare.json"
```

Expected top-level fields include:

```text
ok=true
mode=prepare
status=prepared
jobId=<uuid>
planHash=<sha256>
totalRows=<count>
wouldUpdate=<count>
quarantineCount=<count>
canonicalRowsMutated=0
```

Extract the exact returned values:

```bash
export JOB_ID=$(node -e "const x=require('./$EVIDENCE_DIR/02-prepare.json');process.stdout.write(x.jobId)")
export PLAN_HASH=$(node -e "const x=require('./$EVIDENCE_DIR/02-prepare.json');process.stdout.write(x.planHash)")
printf 'JOB_ID=%s\nPLAN_HASH=%s\n' "$JOB_ID" "$PLAN_HASH" \
  | tee "$EVIDENCE_DIR/02-job-identity.txt"
```

If the output contains non-JSON logging before the JSON body, copy only the final JSON object into a separate reviewed file rather than weakening the parser.

## Step 3 — Review the prepared plan

The database reviewer must inspect the stored snapshot under the same tenant context:

```sql
SELECT id,
       tenant_id,
       classifier_version,
       status,
       plan_hash,
       row_count,
       change_count,
       quarantine_count,
       prepared_at
FROM memory_governance_backfill_job
WHERE tenant_id = '<tenant-uuid>'::uuid
  AND id = '<job-uuid>'::uuid;

SELECT apply_status,
       rollback_status,
       quarantined,
       count(*)
FROM memory_governance_backfill_row
WHERE tenant_id = '<tenant-uuid>'::uuid
  AND job_id = '<job-uuid>'::uuid
GROUP BY apply_status, rollback_status, quarantined
ORDER BY apply_status, rollback_status, quarantined;
```

Review the quarantine reasons without exporting memory bodies:

```sql
SELECT reason, count(*)
FROM memory_governance_backfill_row
WHERE tenant_id = '<tenant-uuid>'::uuid
  AND job_id = '<job-uuid>'::uuid
  AND quarantined = true
GROUP BY reason
ORDER BY count(*) DESC, reason;
```

Required approval record:

- tenant ID;
- job ID;
- classifier version;
- plan hash;
- row/change/quarantine counts;
- reviewer names and timestamps;
- disposition of every quarantine reason category;
- confirmation that canonical rows remain unchanged.

Do not execute when the plan hash or counts differ from the prepared output, duplicate/ambiguous client identity is unresolved, source identity is missing without an approved quarantine disposition, or a reviewer cannot explain the class/scope mapping.

## Step 4 — Execute the exact prepared job

Execution requires all four controls:

```bash
pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
  --tenant-id "$TENANT_ID" \
  --execute \
  --job-id "$JOB_ID" \
  --confirm-tenant "$TENANT_ID" \
  --confirm-job "$JOB_ID" \
  | tee "$EVIDENCE_DIR/04-execute.json"
```

Expected successful status:

```text
ok=true
mode=execute
status=executed
planHash=<same hash>
applied=<prepared changeCount>
notNeeded=<prepared rowCount - changeCount>
```

A repeated execute against an already executed job must return an idempotent result and must not create a second classification change.

### Drift-blocked result

If any prepared row no longer matches its stored `before_hash`, execution returns:

```text
ok=false
status=execute_blocked_drift
mutatedRows=0
```

Stop. Do not prepare SQL to bypass the hash. Review the drift events, abandon the terminal blocked job, resolve the source of change, and prepare a new job under a new change approval.

## Step 5 — Verify exact convergence

```sql
SELECT status,
       plan_hash,
       row_count,
       change_count,
       quarantine_count,
       executed_at
FROM memory_governance_backfill_job
WHERE tenant_id = '<tenant-uuid>'::uuid
  AND id = '<job-uuid>'::uuid;

SELECT apply_status, count(*)
FROM memory_governance_backfill_row
WHERE tenant_id = '<tenant-uuid>'::uuid
  AND job_id = '<job-uuid>'::uuid
GROUP BY apply_status
ORDER BY apply_status;

SELECT event_type, reason_code, count(*)
FROM memory_governance_backfill_event
WHERE tenant_id = '<tenant-uuid>'::uuid
  AND job_id = '<job-uuid>'::uuid
GROUP BY event_type, reason_code
ORDER BY event_type, reason_code;
```

Required invariants:

1. job status is `executed`;
2. applied row count equals prepared `change_count`;
3. no row remains `planned` when it should update;
4. every applied row has a corresponding transition and backfill event;
5. quarantined rows remain conservative (`legacy_unclassified` / `pending_review`) as planned;
6. no memory body, title, prompt, or provider payload appears in the backfill ledgers;
7. tenant isolation remains intact;
8. the control monitor reports the expected quarantine count and zero unexplained drift.

Run the same command again and retain the idempotent output:

```bash
pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
  --tenant-id "$TENANT_ID" \
  --execute \
  --job-id "$JOB_ID" \
  --confirm-tenant "$TENANT_ID" \
  --confirm-job "$JOB_ID" \
  | tee "$EVIDENCE_DIR/05-idempotent-execute.json"
```

## Step 6 — Roll back the job when required

Rollback is a separate approved action. It is not a down migration and it does not delete the job ledger.

```bash
pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
  --tenant-id "$TENANT_ID" \
  --rollback \
  --job-id "$JOB_ID" \
  --confirm-tenant "$TENANT_ID" \
  --confirm-job "$JOB_ID" \
  | tee "$EVIDENCE_DIR/06-rollback.json"
```

The operator must expect one of two terminal states:

- `rolled_back`: every applied row still matched its expected post-hash and was restored;
- `rollback_partial`: one or more rows changed after execution and were recorded as `skipped_drift` rather than overwritten.

Never force a `skipped_drift` row back to its pre-job state. It may contain a later human review, correction, legal-hold change, conflict resolution, or other authoritative mutation.

Verify:

```sql
SELECT status, rolled_back_at
FROM memory_governance_backfill_job
WHERE tenant_id = '<tenant-uuid>'::uuid
  AND id = '<job-uuid>'::uuid;

SELECT rollback_status, count(*)
FROM memory_governance_backfill_row
WHERE tenant_id = '<tenant-uuid>'::uuid
  AND job_id = '<job-uuid>'::uuid
GROUP BY rollback_status
ORDER BY rollback_status;
```

Repeat the rollback command once and retain the idempotent terminal response.

## ECS one-off execution

The API image exposes the entrypoint verb:

```text
backfill-memory-governance
```

When using ECS, override the existing approved API one-off task container command with the same arguments shown above. Record task definition, image digest, network configuration source, task ARN, exit code, and log stream. Do not create an ad-hoc task definition with broader database credentials.

## Prohibited actions

- running `--execute` without a stored prepared job;
- changing the tenant or job confirmation strings;
- editing `plan_hash`, before/post JSON, or row hashes;
- manually changing `apply_status` or `rollback_status`;
- deleting a job to hide drift or quarantine;
- copying memory bodies into evidence;
- running all tenants in one unreviewed bulk command;
- executing against the live `dev` environment as a rehearsal.

## Evidence retention and closeout

Retain the prepare, review, execute, idempotency, verification, and rollback outputs with the change ticket. The database job/row/event ledgers remain the durable authority. CI/rehearsal artifacts use their configured retention; do not treat a 30-day artifact as the only backfill record.

The database reviewer closes the job only after recording its terminal state, quarantine disposition, drift disposition, and whether tenant rollout may proceed.
