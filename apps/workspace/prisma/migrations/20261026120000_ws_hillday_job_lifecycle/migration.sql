-- WS-10 Hill Day durable job lifecycle: exact start request identity, the
-- conditional single-worker lease/claim, the attempt counter and an honest
-- cancellation marker.
--
-- Additive only: no existing column, index, row or applied migration is
-- altered or removed. `request_id` is nullable, so rows written before this
-- migration keep working and the unique index (which treats NULLs as distinct)
-- covers only jobs that carry an explicit start request.
-- `units` already persists per-unit progress; `unknown` is a new value of the
-- same JSON array, so no per-unit schema change is needed.

-- AlterTable
ALTER TABLE "ws_hillday_job"
    ADD COLUMN "request_id" UUID,
    ADD COLUMN "request_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "lease_holder" TEXT,
    ADD COLUMN "lease_expires_at" TIMESTAMP(3),
    ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "cancel_requested_at" TIMESTAMP(3);

-- Rows written before this migration take the column default, but backfill
-- defensively so every legacy row is a readable empty list rather than NULL.
UPDATE "ws_hillday_job" SET "request_ids" = ARRAY[]::TEXT[] WHERE "request_ids" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ws_hillday_job_request_key" ON "ws_hillday_job"("tenant_id", "document_id", "request_id");

-- CreateIndex
CREATE INDEX "ws_hillday_job_claim_idx" ON "ws_hillday_job"("status", "lease_expires_at");
