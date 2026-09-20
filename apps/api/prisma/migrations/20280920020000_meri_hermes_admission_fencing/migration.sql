-- Phase 1 ticket #1 continuation: single-writer-per-conversation admission
-- fencing + durable-dispatch tracking (P1-02 "Admission must atomically ...
-- claim its single writer ... and make dispatch durable"). Additive only.

ALTER TABLE "meri_agent_runs"
  ADD COLUMN "dispatch_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN "dispatch_attempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "meri_agent_runs"
  ADD CONSTRAINT "meri_agent_runs_dispatch_status_check"
  CHECK ("dispatch_status" IN ('pending', 'dispatched', 'failed'));

-- The single-writer-per-conversation lease: a partial unique index over
-- non-terminal runs. A second admission attempt on an already-occupied
-- conversation hits this constraint (P2002 in Prisma) rather than racing an
-- application-level check-then-act; the caller distinguishes idempotent
-- replay (same idempotency_key -> return existing run) from a genuinely
-- competing distinct submission (different content -> 409 conflict).
-- Different conversations are never blocked (scoped by conversation_id).
CREATE UNIQUE INDEX "meri_agent_runs_conversation_single_writer_idx"
  ON "meri_agent_runs" ("conversation_id")
  WHERE "status" NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired');

CREATE INDEX "meri_agent_runs_dispatch_status_idx"
  ON "meri_agent_runs" ("dispatch_status", "created_at")
  WHERE "dispatch_status" = 'pending';

COMMENT ON COLUMN "meri_agent_runs"."dispatch_status" IS
  'pending until the Hermes /v1/runs acceptance response is durably recorded; a row stuck pending past a timeout is ambiguous startup (P1-07), reconciled by MeriHermesPrismaRunRepository.reconcileStuckDispatches, never blindly retried.';
COMMENT ON INDEX "meri_agent_runs_conversation_single_writer_idx" IS
  'Single-writer-per-conversation lease (P1-02): at most one non-terminal run per conversation, enforced at the database, not app-level check-then-act.';
