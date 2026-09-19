-- Strategy generation timeout fix — async draft-from-goal job (additive only).
--
-- POST /strategies/draft used to be one fully synchronous HTTP call all the way
-- through the orchestrator's own repair/retry loop (up to ~3 attempts x up to 8
-- rounds x 120s per call) — no single client/ALB timeout is both safe and a
-- good UX for that shape. The endpoint now enqueues a sp_draft_job row and
-- returns 202; DraftJobWorkerService's claim-sweep (FOR UPDATE SKIP LOCKED,
-- multi-replica safe) runs the generation off the request path and streams
-- progress into stage/progress_text/stream_preview. GET
-- /strategies/draft-jobs/:jobId polls it.
--
-- (tenant_id, request_key) is UNIQUE — request_key is a hash of the submitted
-- input (clientId/type/goal/meriContext/targetDate/attachmentIds), so a
-- double-submit (client retry, double-click) resolves to the SAME job via
-- catch-P2002-and-refetch instead of starting a second generation.
--
-- ROLLBACK (manual, forward-only migrate; nothing else references this table):
--   DROP TABLE IF EXISTS "sp_draft_job" CASCADE;
--   DROP TYPE IF EXISTS "sp_draft_job_status";

-- CreateEnum
CREATE TYPE "sp_draft_job_status" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "sp_draft_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "status" "sp_draft_job_status" NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "progress_text" TEXT,
    "stream_preview" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "strategy_id" UUID,
    "error_message" TEXT,
    "claimed_by" TEXT,
    "claimed_at" TIMESTAMP(3),
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_draft_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sp_draft_job_tenant_id_request_key_key" ON "sp_draft_job"("tenant_id", "request_key");

-- CreateIndex
CREATE INDEX "sp_draft_job_tenant_id_status_idx" ON "sp_draft_job"("tenant_id", "status");

-- CreateIndex
-- Claim-sweep candidate scan (queued) and stale-claim reclaim (running, ordered
-- by last progress) both key off status; updated_at bumps on every progress
-- write, so "stale" means "no progress", not merely "claimed a while ago".
CREATE INDEX "sp_draft_job_status_updated_at_idx" ON "sp_draft_job"("status", "updated_at");

-- ---------------------------------------------------------------------------
-- Row-Level Security (same tenant-isolation policy as every other sp_* table).
-- ---------------------------------------------------------------------------

ALTER TABLE "sp_draft_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_draft_job" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_draft_job_isolation" ON "sp_draft_job"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
