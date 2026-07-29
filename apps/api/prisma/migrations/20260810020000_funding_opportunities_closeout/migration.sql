-- Funding Opportunities final closeout: durable mapping review state, explicit
-- client set-aside certifications, and source lifecycle snapshots for alerts.
-- Additive and retry-safe.

ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "set_aside_certifications" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "client_intel_mapping"
  ADD COLUMN IF NOT EXISTS "review_status" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "reviewed_by" UUID,
  ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;

UPDATE "client_intel_mapping"
SET "review_status" = CASE WHEN "confirmed" THEN 'confirmed' ELSE 'candidate' END
WHERE "review_status" IS NULL;

ALTER TABLE "client_intel_mapping"
  ALTER COLUMN "review_status" SET DEFAULT 'candidate',
  ALTER COLUMN "review_status" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_intel_mapping_review_status_chk'
  ) THEN
    ALTER TABLE "client_intel_mapping"
      ADD CONSTRAINT "client_intel_mapping_review_status_chk"
      CHECK ("review_status" IN ('candidate','confirmed','rejected','superseded'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "client_intel_mapping_tenant_source_review_idx"
  ON "client_intel_mapping" ("tenant_id", "source", "review_status");

ALTER TABLE "client_funding_opportunity"
  ADD COLUMN IF NOT EXISTS "source_status_snapshot" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "response_deadline_snapshot" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "source_updated_at_snapshot" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "alert_state_jsonb" JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE INDEX IF NOT EXISTS "client_funding_opportunity_lifecycle_idx"
  ON "client_funding_opportunity" ("tenant_id", "workflow_status", "response_deadline_snapshot");
