# MeriV2 Phase 5 — Scheduled Failure-Aware Memory Projection Worker

## Scope

Phase 5 makes durable memory projection/index obligations executable out of band. It
adds no production deployment, migration execution, backfill, flag change, AWS API
operation, or customer-data mutation.

Implementation branch: `agent/meriv2-world-class-closeout`  
Primary draft PR: `#679`

Phase 5 does **not** migrate every request-time caller to strict completion semantics;
that remains Phase 6. The existing fast path stays non-blocking, but its durable outbox
obligation is now consumable by a strict scheduled worker.

## Runtime architecture

1. `MemoryCandidateService` commits `index_memory_item` in the same transaction as the
   `clio_memory` write. A failed immediate projection leaves the row pending.
2. `MemoryProjectionWorkerService` claims bounded batches with
   `FOR UPDATE SKIP LOCKED`, increments attempts, and records an opaque expiring lease.
3. Projection and Bedrock embedding occur after the claim transaction commits.
4. `StrictMemoryProjectorService` invokes the existing single projector and verifies
   the exact canonical `memory_items` row and expected embedding content hash before
   allowing completion.
5. Terminal updates require the same opaque lease token. A stale worker cannot complete
   a job another invocation reclaimed.
6. Failed jobs use bounded exponential backoff. Exhausted jobs enter `dead_letter` and
   retain bounded error codes without memory bodies or provider responses.

Supported operations:

- `index_memory_item`
- `revoke_projections`
- `supersede_projections`
- `expire_projections`
- `purge_projections`

## Database contract

Migration: `20260812020000_memory_cleanup_worker_leases`

Additive fields:

- `lease_owner`
- `lease_expires_at`
- `started_at`
- `dead_lettered_at`

The migration widens the existing status vocabulary with `dead_letter`, enforces that
only running rows can hold leases, and adds partial indexes for due/stale claims and
terminal dead-letter inspection. The worker deliberately accesses these operational
fields through raw SQL; the migration and worker are validated together in the focused
gate. The migration is committed but was not applied by this phase.

## Scheduling and operations

CDK stack: `Capiro-<env>-MemoryProjectionWorker`

The stack consumes existing network, ECS, ECR, database-secret, and KMS outputs. It
creates:

- a dedicated ARM64 Fargate task definition;
- a five-minute EventBridge schedule;
- the app database credential, not the migration/master writer credential;
- task-role permission limited to Titan v2 embedding invocation;
- a dedicated one-year CloudWatch log group;
- metrics and alarms for retrying failures, dead-lettered jobs, and process crashes.

The container command is:

```text
drain-memory-cleanup-outbox 200 300
```

This means a maximum claim batch of 200 and a five-minute lease. EventBridge retry is
bounded separately and database leases make overlapping invocations safe.

## Invariants covered by automated tests

- failed fast-path projection leaves the durable job pending;
- the scheduled worker can claim and complete the same `index_memory_item` contract;
- the injected strict projector is always used for forward indexing;
- two concurrent drains do not both process one claim;
- stale running claims are recoverable after lease expiry;
- final-attempt stale leases move to dead-letter;
- missing/deleted subjects complete idempotently instead of retrying forever;
- retry backoff is bounded and exhausted jobs are terminal;
- completion and failure require the current lease owner;
- canonical item and expected embedding are verified before completion;
- logs and persisted errors do not contain memory bodies or provider responses;
- the scheduled task, app credential, Titan-only IAM, retention, metrics, alarms, and
  entrypoint verb are statically gated.

## Rollback

1. Disable the `capiro-<env>-memory-projection-worker` EventBridge rule.
2. Roll back or remove the `MemoryProjectionWorker` stack/task definition.
3. Preserve every pending, failed, running, completed, and dead-letter outbox row.
4. Do not delete immutable memory history or run a destructive down migration.
5. Request-time behavior remains on the existing non-blocking path until Phase 6, so
   disabling the schedule does not change user-facing save semantics; it pauses only
   out-of-band completion.

## Release evidence

Final exact-head SHA, focused suite counts, and required workflow run IDs are recorded
on PR #679 only after all gates succeed. Until then, this document describes the
implemented contract but is not a production release certificate.
