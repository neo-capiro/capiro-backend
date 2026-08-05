-- Phase 4 post-merge audit repairs.
-- Forward-only, additive/expansive changes. This migration performs no
-- canonical Program Element value load or backfill.

-- Preserve source money at dollar-level precision when normalized to millions.
ALTER TABLE "program_element_project_budget_position"
  ALTER COLUMN "amount" TYPE NUMERIC(20,6) USING "amount"::NUMERIC(20,6),
  ALTER COLUMN "quantity" TYPE NUMERIC(20,6) USING "quantity"::NUMERIC(20,6);

-- Do not change the natural key of the live legacy milestone table. Existing
-- application code and its generated Prisma client still own PE-level
-- milestones by (pe_code, milestone_type). Project-scoped milestones get an
-- additive table so two projects may truthfully carry the same printed label
-- without making the legacy writer ambiguous during this deployment.
CREATE TABLE "program_element_project_milestone" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "pe_code" VARCHAR(16) NOT NULL,
  "project_code" VARCHAR(32) NOT NULL,
  "milestone_type" TEXT NOT NULL,
  "planned_date" DATE,
  "actual_date" DATE,
  "status" TEXT,
  "source" TEXT NOT NULL,
  "notes" TEXT,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source_document_id" UUID,
  "extraction_artifact_id" TEXT,
  "extraction_artifact_content_sha256" CHAR(64),
  "assertion_id" TEXT,
  "verification_candidate_id" TEXT,
  "verification_run_id" TEXT,
  "verification_policy_sha256" CHAR(64),
  "source_pdf_sha256" CHAR(64),
  "evidence_ids_jsonb" JSONB NOT NULL DEFAULT '[]',
  CONSTRAINT "program_element_project_milestone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "program_element_project_milestone_natural_key"
    UNIQUE ("pe_code", "project_code", "milestone_type")
);

CREATE INDEX "program_element_project_milestone_pe_project_idx"
  ON "program_element_project_milestone"("pe_code", "project_code");
CREATE INDEX "program_element_project_milestone_status_idx"
  ON "program_element_project_milestone"("status");
CREATE INDEX "program_element_project_milestone_artifact_idx"
  ON "program_element_project_milestone"("extraction_artifact_id");
CREATE INDEX "program_element_project_milestone_verification_run_idx"
  ON "program_element_project_milestone"("verification_run_id");

ALTER TABLE "program_element_project_milestone"
  ADD CONSTRAINT "program_element_project_milestone_project_fkey"
  FOREIGN KEY ("pe_code", "project_code")
  REFERENCES "program_element_project"("pe_code", "project_code")
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "program_element_project_milestone"
  ADD CONSTRAINT "program_element_project_milestone_source_document_fkey"
  FOREIGN KEY ("source_document_id")
  REFERENCES "source_document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "program_element_project_milestone"
  ADD CONSTRAINT "program_element_project_milestone_provenance_check"
  CHECK (
    (
      "extraction_artifact_id" IS NULL AND
      "extraction_artifact_content_sha256" IS NULL AND
      "assertion_id" IS NULL AND
      "verification_candidate_id" IS NULL AND
      "verification_run_id" IS NULL AND
      "verification_policy_sha256" IS NULL AND
      "source_pdf_sha256" IS NULL AND
      "source_document_id" IS NULL AND
      "evidence_ids_jsonb" = '[]'::jsonb
    ) OR (
      "extraction_artifact_id" IS NOT NULL AND
      "extraction_artifact_content_sha256" IS NOT NULL AND
      "assertion_id" IS NOT NULL AND
      "verification_candidate_id" IS NOT NULL AND
      "verification_run_id" IS NOT NULL AND
      "verification_policy_sha256" IS NOT NULL AND
      "source_pdf_sha256" IS NOT NULL AND
      "source_document_id" IS NOT NULL AND
      jsonb_typeof("evidence_ids_jsonb") = 'array' AND
      jsonb_array_length("evidence_ids_jsonb") > 0
    )
  ) NOT VALID;

CREATE TABLE "program_element_project_milestone_schedule_period" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "milestone_id" UUID NOT NULL,
  "pe_code" VARCHAR(16) NOT NULL,
  "project_code" VARCHAR(32) NOT NULL,
  "milestone_type" TEXT NOT NULL,
  "period_role" TEXT NOT NULL,
  "raw_text" TEXT NOT NULL,
  "period_kind" TEXT NOT NULL,
  "fiscal_year" INTEGER,
  "fiscal_quarter" INTEGER,
  "calendar_year" INTEGER,
  "calendar_quarter" INTEGER,
  "calendar_month" INTEGER,
  "exact_date" DATE,
  "range_start" DATE,
  "range_end" DATE,
  "source_url" TEXT,
  "page_number" INTEGER,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source_document_id" UUID,
  "extraction_artifact_id" TEXT,
  "extraction_artifact_content_sha256" CHAR(64),
  "assertion_id" TEXT,
  "verification_candidate_id" TEXT,
  "verification_run_id" TEXT,
  "verification_policy_sha256" CHAR(64),
  "source_pdf_sha256" CHAR(64),
  "evidence_ids_jsonb" JSONB NOT NULL DEFAULT '[]',
  CONSTRAINT "program_element_project_milestone_schedule_period_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "program_element_project_milestone_schedule_period_natural_key"
    UNIQUE ("milestone_id", "period_role", "raw_text")
);

CREATE INDEX "program_element_project_milestone_period_pe_project_idx"
  ON "program_element_project_milestone_schedule_period"("pe_code", "project_code");
CREATE INDEX "program_element_project_milestone_period_kind_idx"
  ON "program_element_project_milestone_schedule_period"("period_kind");
CREATE INDEX "program_element_project_milestone_period_artifact_idx"
  ON "program_element_project_milestone_schedule_period"("extraction_artifact_id");
CREATE INDEX "program_element_project_milestone_period_verification_run_idx"
  ON "program_element_project_milestone_schedule_period"("verification_run_id");

ALTER TABLE "program_element_project_milestone_schedule_period"
  ADD CONSTRAINT "program_element_project_milestone_period_milestone_fkey"
  FOREIGN KEY ("milestone_id")
  REFERENCES "program_element_project_milestone"("id")
  ON DELETE CASCADE ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "program_element_project_milestone_schedule_period"
  ADD CONSTRAINT "program_element_project_milestone_period_source_document_fkey"
  FOREIGN KEY ("source_document_id")
  REFERENCES "source_document"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "program_element_project_milestone_schedule_period"
  ADD CONSTRAINT "program_element_project_milestone_period_shape_check"
  CHECK (
    ("period_kind" = 'exact_date' AND "exact_date" IS NOT NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "calendar_year" IS NULL AND "calendar_quarter" IS NULL AND
      "calendar_month" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'calendar_month' AND "calendar_year" IS NOT NULL AND
      "calendar_month" IS NOT NULL AND "calendar_quarter" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'calendar_quarter' AND "calendar_year" IS NOT NULL AND
      "calendar_quarter" IS NOT NULL AND "calendar_month" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'fiscal_quarter' AND "fiscal_year" IS NOT NULL AND
      "fiscal_quarter" BETWEEN 1 AND 4 AND "calendar_year" IS NULL AND
      "calendar_quarter" IS NULL AND "calendar_month" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'fiscal_year' AND "fiscal_year" IS NOT NULL AND
      "fiscal_quarter" IS NULL AND "calendar_year" IS NULL AND
      "calendar_quarter" IS NULL AND "calendar_month" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'range' AND "exact_date" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "calendar_year" IS NULL AND "calendar_quarter" IS NULL AND
      "calendar_month" IS NULL AND
      (("range_start" IS NULL AND "range_end" IS NULL) OR
       ("range_start" IS NOT NULL AND "range_end" IS NOT NULL AND
        "range_end" >= "range_start")))
    OR
    ("period_kind" IN ('text_only', 'unknown') AND "exact_date" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "calendar_year" IS NULL AND "calendar_quarter" IS NULL AND
      "calendar_month" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
  ) NOT VALID;

ALTER TABLE "program_element_project_milestone_schedule_period"
  ADD CONSTRAINT "program_element_project_milestone_period_provenance_check"
  CHECK (
    (
      "extraction_artifact_id" IS NULL AND
      "extraction_artifact_content_sha256" IS NULL AND
      "assertion_id" IS NULL AND
      "verification_candidate_id" IS NULL AND
      "verification_run_id" IS NULL AND
      "verification_policy_sha256" IS NULL AND
      "source_pdf_sha256" IS NULL AND
      "source_document_id" IS NULL AND
      "evidence_ids_jsonb" = '[]'::jsonb
    ) OR (
      "extraction_artifact_id" IS NOT NULL AND
      "extraction_artifact_content_sha256" IS NOT NULL AND
      "assertion_id" IS NOT NULL AND
      "verification_candidate_id" IS NOT NULL AND
      "verification_run_id" IS NOT NULL AND
      "verification_policy_sha256" IS NOT NULL AND
      "source_pdf_sha256" IS NOT NULL AND
      "source_document_id" IS NOT NULL AND
      jsonb_typeof("evidence_ids_jsonb") = 'array' AND
      jsonb_array_length("evidence_ids_jsonb") > 0
    )
  ) NOT VALID;

-- Tighten the existing PE-level schedule-period shape without changing its
-- ownership or natural key. Coarse ranges remain raw/structured and do not
-- fabricate first/last calendar days.
ALTER TABLE "program_element_milestone_schedule_period"
  DROP CONSTRAINT IF EXISTS "program_element_milestone_schedule_period_shape_check";

ALTER TABLE "program_element_milestone_schedule_period"
  ADD CONSTRAINT "program_element_milestone_schedule_period_shape_check"
  CHECK (
    ("period_kind" = 'exact_date' AND "exact_date" IS NOT NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "calendar_year" IS NULL AND "calendar_quarter" IS NULL AND
      "calendar_month" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'calendar_month' AND "calendar_year" IS NOT NULL AND
      "calendar_month" IS NOT NULL AND "calendar_quarter" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'calendar_quarter' AND "calendar_year" IS NOT NULL AND
      "calendar_quarter" IS NOT NULL AND "calendar_month" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'fiscal_quarter' AND "fiscal_year" IS NOT NULL AND
      "fiscal_quarter" BETWEEN 1 AND 4 AND "calendar_year" IS NULL AND
      "calendar_quarter" IS NULL AND "calendar_month" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'fiscal_year' AND "fiscal_year" IS NOT NULL AND
      "fiscal_quarter" IS NULL AND "calendar_year" IS NULL AND
      "calendar_quarter" IS NULL AND "calendar_month" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'range' AND "exact_date" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "calendar_year" IS NULL AND "calendar_quarter" IS NULL AND
      "calendar_month" IS NULL AND
      (("range_start" IS NULL AND "range_end" IS NULL) OR
       ("range_start" IS NOT NULL AND "range_end" IS NOT NULL AND
        "range_end" >= "range_start")))
    OR
    ("period_kind" IN ('text_only', 'unknown') AND "exact_date" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "calendar_year" IS NULL AND "calendar_quarter" IS NULL AND
      "calendar_month" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
  ) NOT VALID;
