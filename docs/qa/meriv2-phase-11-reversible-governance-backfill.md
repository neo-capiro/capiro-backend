# MeriV2 Phase 11 — Reversible, Drift-Safe Governance Backfill

## Status

**Implementation present; cumulative acceptance blocked by the repository-level GitHub Actions `BuildFailed` control-plane defect.**

PR #679 remains draft and unmerged. This phase did not execute a tenant backfill, apply a shared or production migration, deploy an AWS service, change a production flag, retrieve a secret, mutate customer data, or send an external communication.

## Objective

Replace the legacy one-step governance classifier with an operator-controlled state machine that:

1. prepares a durable dry-run snapshot;
2. executes only that exact confirmed snapshot;
3. detects drift before any canonical mutation;
4. rolls back only rows that still match the job's expected post-state; and
5. preserves later human or system corrections instead of overwriting them.

## Additive persistence

Migration `20260814010000_memory_governance_backfill_jobs` adds three tenant-scoped, RLS-forced control tables:

- `memory_governance_backfill_job` — immutable job identity, classifier version, plan hash, counts, and terminal lifecycle;
- `memory_governance_backfill_row` — exact before-state and expected-post-state snapshots for every row under the tenant/job identity; and
- `memory_governance_backfill_event` — bounded append-only operational evidence.

The migration is additive. It contains no `UPDATE`, `INSERT`, or `DELETE` against `memory_items`.

The snapshot contains governance metadata only:

- memory class;
- authority;
- scope;
- governed lifecycle status;
- source type;
- source ID; and
- review due timestamp.

It does not copy memory bodies, titles, prompts, provider payloads, email content, or other generated content.

## Operator contract

### 1. Prepare / dry-run

```bash
pnpm --filter @capiro/api exec tsx \
  scripts/backfill-memory-governance-v2.ts \
  --tenant-id <tenant-uuid>
```

Prepare creates a new job ID, snapshots exact prior governance state, records the deterministic expected post-state and hashes, and returns the plan hash and counts. It performs **zero canonical `memory_items` mutations**.

### 2. Execute the exact prepared job

```bash
pnpm --filter @capiro/api exec tsx \
  scripts/backfill-memory-governance-v2.ts \
  --tenant-id <tenant-uuid> \
  --execute \
  --job-id <job-uuid> \
  --confirm-tenant <tenant-uuid> \
  --confirm-job <job-uuid>
```

Execution requires both confirmation values to match exactly. It never recomputes classification. The job and all covered memory rows are locked, and every row selected for mutation must still match its stored before-state hash.

If any covered row drifted after prepare:

- no `memory_items` row is changed;
- the job terminates as `execute_blocked_drift`;
- the affected row evidence records expected and observed hashes; and
- the operator must prepare a new job after reviewing the changed data.

If no row drifted, the expected state, transition audit, row ledger, and job completion commit in one transaction.

### 3. Roll back the exact executed job

```bash
pnpm --filter @capiro/api exec tsx \
  scripts/backfill-memory-governance-v2.ts \
  --tenant-id <tenant-uuid> \
  --rollback \
  --job-id <job-uuid> \
  --confirm-tenant <tenant-uuid> \
  --confirm-job <job-uuid>
```

Rollback compares each applied row with its stored expected-post-state hash while holding the row lock:

- exact match — restore the exact stored before-state and record transition evidence;
- changed or missing row — skip it and record `row_skipped_drift` evidence.

A complete rollback ends as `rolled_back`. A rollback that preserves one or more later changes ends truthfully as `rollback_partial`. Both are terminal and idempotent; a later invocation does not retry skipped rows or overwrite subsequent decisions.

## Audit and privacy properties

- Every prepare, execute, blocked execute, applied row, rollback, restored row, and skipped row receives bounded operational evidence.
- Applied and restored lifecycle changes also write `memory_transition_audit` with the backfill job ID, classifier version, and state hashes.
- The Phase 11 event table rejects `UPDATE` and `DELETE` at the database boundary.
- Reports contain IDs, counts, statuses, versions, hashes, and reason codes—not memory content.
- All three control tables use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with the server-resolved tenant GUC.

## Permanent regression gates

The cumulative `memory-governance-ci` workflow now includes:

- clean migration replay;
- the Phase 11 migration contract test;
- argument, canonical-hash, and exact-state tests;
- a disposable PostgreSQL rehearsal that proves:
  - prepare does not mutate canonical rows;
  - exact confirmed execution applies the prepared job;
  - one unchanged row is restored;
  - one later-modified row is preserved and marked `skipped_drift`;
  - the job ends as `rollback_partial`; and
  - append-only event evidence rejects mutation.

The rehearsal operates only on a fixed disposable tenant in clean CI PostgreSQL.

## Rollback of the release itself

Before any environment rollout:

1. keep governed-memory enforcement dark for the tenant;
2. prepare and review the job report;
3. execute only the reviewed exact job ID;
4. retain the job and event ledgers permanently; and
5. use the same job ID for rollback if needed.

Do not drop the additive tables or delete audit evidence as a rollback mechanism. Do not restore a row whose expected post-state hash no longer matches.

## Acceptance blocker

GitHub workflow identity `324351375` remains a deleted synthetic `BuildFailed` registration that creates zero-job `startup_failure` runs and prevents real workflows from scheduling. Until GitHub repairs that repository control-plane state, Phase 11 cannot receive final exact-head CI acceptance even though the permanent tests and rehearsal are present.
