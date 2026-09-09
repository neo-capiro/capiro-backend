-- GLOBAL FEC source tables, shared across tenants like fec_pac_contribution.
-- Do not mark existing rows complete: their legacy ingestion was capped and
-- included vendor spend. A successful atomic committee/cycle sync replaces them.
ALTER TABLE "fec_pac_contribution"
  ADD COLUMN "source_sub_id" TEXT,
  ADD COLUMN "source_transaction_id" TEXT,
  ADD COLUMN "source_file_number" TEXT;

-- Distinct source transactions can have the same recipient, amount and date.
ALTER TABLE "fec_pac_contribution" DROP CONSTRAINT IF EXISTS "fec_pac_contribution_dedup_key";
DROP INDEX IF EXISTS "fec_pac_contribution_dedup_key";
CREATE UNIQUE INDEX "fec_pac_contribution_source_key"
  ON "fec_pac_contribution" ("committee_id", "cycle", "source_sub_id");

CREATE TABLE "fec_pac_sync_state" (
  "committee_id" TEXT NOT NULL,
  "cycle" INTEGER NOT NULL,
  "run_id" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('running', 'complete', 'error')),
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "source_row_count" INTEGER NOT NULL DEFAULT 0,
  "contribution_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "fec_pac_sync_state_pkey" PRIMARY KEY ("committee_id", "cycle")
);
