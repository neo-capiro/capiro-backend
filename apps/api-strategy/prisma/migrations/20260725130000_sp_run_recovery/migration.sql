-- P0-2 (deep-audit finding "Execution runs can become permanently stranded").
--
-- Execution spans reservation -> generation -> external artifact create ->
-- back-link write -> run-state update. A failure between any two of those left a
-- run parked in `executing` / `waiting_for_input` with:
--   * no way to tell "still working" from "died 3 days ago" (no heartbeat),
--   * one undifferentiated `failed` state with no notion of recoverability,
--   * no retry, because (tenant_id, idempotency_key) is UNIQUE and the key is
--     derived from (node, kind) — so a second attempt could never be minted,
--   * no repair path at all.
--
-- Two additions, both additive and backward-compatible:
--
-- 1. FIVE NEW ENUM VALUES on sp_run_state. Postgres ADD VALUE is metadata-only —
--    no table rewrite, no lock on sp_agent_run's data. Existing rows are
--    untouched, so every pre-P0-2 row keeps reading exactly as it did. The old
--    `failed` value is deliberately RETAINED (rows carry it) but nothing
--    transitions into it any more; run-state.ts treats it as terminal legacy.
--    `canceled` is NOT renamed to the audit's `cancelled` spelling: renaming a
--    live enum value would churn every code reference and every stored findings
--    blob to no functional benefit.
--
-- 2. HEARTBEAT + RECONCILE + RETRY-LINEAGE COLUMNS on sp_agent_run. All nullable
--    or defaulted, so no backfill.
--
--    ROLLOUT NOTE, read this before enabling the sweep: heartbeat_at is NULL for
--    every pre-existing row, and run-recovery.ts deliberately falls back to
--    started_at then created_at when it is null. That is intentional — the
--    already-stuck runs this feature exists to rescue are exactly the ones with no
--    heartbeat — but it means the FIRST sweep over a backlog will move every
--    long-dead `executing`/`planning`/`queued` run to `failed_recoverable`.
--    Nothing is lost (failed_recoverable is non-terminal and reconcilable, and no
--    artifact is touched), but it is a visible bulk state change. This is why the
--    sweep is dark by default behind STRATEGY_RUN_RECONCILER: turn it on
--    deliberately, and expect that first pass.

-- PREREQUISITE: PostgreSQL 12+. Prisma runs each migration inside a transaction,
-- and ALTER TYPE ... ADD VALUE is only permitted in a transaction from PG 12. The
-- new values are NOT used by any statement in this file (only ALTER TABLE follows),
-- which is the other PG 12 requirement. Aurora PostgreSQL here is well past 12.

-- 1. New run states (order matters only for readability; ADD VALUE is additive).
ALTER TYPE "sp_run_state" ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE "sp_run_state" ADD VALUE IF NOT EXISTS 'staged';
ALTER TYPE "sp_run_state" ADD VALUE IF NOT EXISTS 'failed_recoverable';
ALTER TYPE "sp_run_state" ADD VALUE IF NOT EXISTS 'failed_terminal';
ALTER TYPE "sp_run_state" ADD VALUE IF NOT EXISTS 'superseded';

-- 2. Recovery bookkeeping.
--    heartbeat_at: the clock a state's timeout is measured against. NOT
--    updated_at — any unrelated column write bumps that, so it cannot
--    distinguish "the agent is alive" from "someone edited a field".
ALTER TABLE "sp_agent_run" ADD COLUMN "heartbeat_at" TIMESTAMP(3);
ALTER TABLE "sp_agent_run" ADD COLUMN "reconciled_at" TIMESTAMP(3);
ALTER TABLE "sp_agent_run" ADD COLUMN "reconcile_attempts" INTEGER NOT NULL DEFAULT 0;
--    Retry lineage: a retry mints a NEW run with a fresh idempotency key
--    (`exec:<nodeId>:<kind>#<attempt>`), which is what makes retry possible at
--    all under the (tenant_id, idempotency_key) unique constraint.
ALTER TABLE "sp_agent_run" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "sp_agent_run" ADD COLUMN "retry_of_run_id" UUID;
ALTER TABLE "sp_agent_run" ADD COLUMN "superseded_by_run_id" UUID;

-- The reconciler's sweep predicate: non-terminal runs, oldest heartbeat first.
-- Cross-tenant by design (the sweep runs under withSystem), hence no tenant_id
-- prefix — unlike every other index on this table.
CREATE INDEX "sp_agent_run_state_heartbeat_at_idx" ON "sp_agent_run"("state", "heartbeat_at");

-- Rollback (forward-only migrate; documented per plan). NOTE: Postgres cannot
-- DROP an enum value, so the enum additions are NOT reversible in place — a true
-- rollback would recreate the type. The column drops are:
--   DROP INDEX "sp_agent_run_state_heartbeat_at_idx";
--   ALTER TABLE "sp_agent_run" DROP COLUMN "superseded_by_run_id";
--   ALTER TABLE "sp_agent_run" DROP COLUMN "retry_of_run_id";
--   ALTER TABLE "sp_agent_run" DROP COLUMN "attempt";
--   ALTER TABLE "sp_agent_run" DROP COLUMN "reconcile_attempts";
--   ALTER TABLE "sp_agent_run" DROP COLUMN "reconciled_at";
--   ALTER TABLE "sp_agent_run" DROP COLUMN "heartbeat_at";
