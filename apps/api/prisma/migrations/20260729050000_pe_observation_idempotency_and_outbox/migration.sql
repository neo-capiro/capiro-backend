-- Program Elements Trust Phase D: additive observation identity, reconciliation
-- refresh metadata, and transactional change outbox. This migration never
-- changes ProgramElementYear canonical values and never deletes observations.

ALTER TABLE "program_element_year_source_value"
  ADD COLUMN "observation_key" TEXT,
  ADD COLUMN "parse_job_id" UUID,
  ADD COLUMN "page_number" INTEGER,
  ADD COLUMN "source_span_hash" TEXT,
  ADD COLUMN "extractor_version" TEXT,
  ADD COLUMN "original_value_decimal" DECIMAL(20,6),
  ADD COLUMN "original_unit" TEXT,
  ADD COLUMN "canonical_value_m" DECIMAL(18,6),
  ADD COLUMN "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "observation_count" INTEGER NOT NULL DEFAULT 1;

-- Legacy rows are intentionally not deduplicated. Each receives an immutable,
-- unique compatibility key so the new writer can use SHA-derived keys without
-- confusing historical duplicates with a replay of new evidence.
UPDATE "program_element_year_source_value"
SET
  "observation_key" = 'legacy:' || "id"::text,
  "canonical_value_m" = "value_decimal",
  "last_observed_at" = "recorded_at";

CREATE UNIQUE INDEX "program_element_year_source_value_observation_key_key"
  ON "program_element_year_source_value"("observation_key");
CREATE INDEX "program_element_year_source_value_parse_job_idx"
  ON "program_element_year_source_value"("parse_job_id");
CREATE INDEX "program_element_year_source_value_document_field_idx"
  ON "program_element_year_source_value"("source_document_id", "field_name");

ALTER TABLE "reconciliation_review_queue"
  ADD COLUMN "conflict_type" TEXT NOT NULL DEFAULT 'value_conflict',
  ADD COLUMN "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "observation_count" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "current_source" TEXT,
  ADD COLUMN "current_source_document_id" UUID,
  ADD COLUMN "conflicting_source_document_id" UUID;

CREATE TABLE "program_element_change_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "dedupe_key" TEXT NOT NULL,
  "pe_code" VARCHAR(16) NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload_jsonb" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "program_element_change_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "program_element_change_outbox_dedupe_key_key"
  ON "program_element_change_outbox"("dedupe_key");
CREATE INDEX "program_element_change_outbox_status_created_idx"
  ON "program_element_change_outbox"("status", "created_at");
