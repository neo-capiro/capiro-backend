-- Phase 4 closeout — forward-only projection provenance and integrity.
--
-- This migration does not write canonical Program Element values. It tightens
-- the additive schema introduced by 20260817010000 so future Phase 7 writes
-- must preserve the exact extraction, verification, source, assertion, and
-- evidence identities produced by Phases 1-4.

-- ── Project budget positions ───────────────────────────────────────────────
ALTER TABLE "program_element_project_budget_position"
  ADD COLUMN "original_value" TEXT,
  ADD COLUMN "original_unit" VARCHAR(16),
  ADD COLUMN "extraction_artifact_id" TEXT,
  ADD COLUMN "extraction_artifact_content_sha256" CHAR(64),
  ADD COLUMN "assertion_id" TEXT,
  ADD COLUMN "verification_candidate_id" TEXT,
  ADD COLUMN "verification_run_id" TEXT,
  ADD COLUMN "verification_policy_sha256" CHAR(64),
  ADD COLUMN "source_pdf_sha256" CHAR(64),
  ADD COLUMN "evidence_ids_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The old migration created value_kind with total/quantity only. R-2A source
-- rows can also carry explicit base/OCO components; these remain distinct
-- project budget positions and must never be collapsed into a total.
ALTER TABLE "program_element_project_budget_position"
  DROP CONSTRAINT IF EXISTS "program_element_project_budget_position_value_kind_check";
ALTER TABLE "program_element_project_budget_position"
  ADD CONSTRAINT "program_element_project_budget_position_value_kind_check"
  CHECK ("value_kind" IN ('total', 'base', 'oco', 'quantity'));

-- A project position cannot name a project that does not exist. The referenced
-- columns already have a reviewed unique key on program_element_project.
ALTER TABLE "program_element_project_budget_position"
  ADD CONSTRAINT "program_element_project_budget_position_project_fkey"
  FOREIGN KEY ("pe_code", "project_code")
  REFERENCES "program_element_project"("pe_code", "project_code")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "program_element_project_budget_position"
  ADD CONSTRAINT "program_element_project_budget_position_original_unit_check"
  CHECK ("original_unit" IS NULL OR "original_unit" IN ('dollars', 'thousands', 'millions', 'units'));

-- NOT VALID avoids making assumptions about any pre-existing rehearsal rows,
-- while PostgreSQL still enforces the complete proof tuple on every new or
-- updated row after this migration is installed.
ALTER TABLE "program_element_project_budget_position"
  ADD CONSTRAINT "program_element_project_budget_position_provenance_check"
  CHECK (
    "original_value" IS NOT NULL AND btrim("original_value") <> '' AND
    "original_unit" IS NOT NULL AND
    "extraction_artifact_id" IS NOT NULL AND btrim("extraction_artifact_id") <> '' AND
    "extraction_artifact_content_sha256" ~ '^[0-9a-f]{64}$' AND
    "assertion_id" IS NOT NULL AND btrim("assertion_id") <> '' AND
    "verification_candidate_id" IS NOT NULL AND btrim("verification_candidate_id") <> '' AND
    "verification_run_id" IS NOT NULL AND btrim("verification_run_id") <> '' AND
    "verification_policy_sha256" ~ '^[0-9a-f]{64}$' AND
    "source_pdf_sha256" ~ '^[0-9a-f]{64}$' AND
    "source_document_id" IS NOT NULL AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND
    jsonb_array_length("evidence_ids_jsonb") > 0
  ) NOT VALID;

CREATE INDEX "program_element_project_budget_position_artifact_idx"
  ON "program_element_project_budget_position" ("extraction_artifact_id");
CREATE INDEX "program_element_project_budget_position_verification_run_idx"
  ON "program_element_project_budget_position" ("verification_run_id");

-- ── Milestone schedule periods ─────────────────────────────────────────────
ALTER TABLE "program_element_milestone_schedule_period"
  ADD COLUMN "extraction_artifact_id" TEXT,
  ADD COLUMN "extraction_artifact_content_sha256" CHAR(64),
  ADD COLUMN "assertion_id" TEXT,
  ADD COLUMN "verification_candidate_id" TEXT,
  ADD COLUMN "verification_run_id" TEXT,
  ADD COLUMN "verification_policy_sha256" CHAR(64),
  ADD COLUMN "source_pdf_sha256" CHAR(64),
  ADD COLUMN "evidence_ids_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb;

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
      "fiscal_quarter" IS NOT NULL AND "calendar_year" IS NULL AND
      "calendar_quarter" IS NULL AND "calendar_month" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'fiscal_year' AND "fiscal_year" IS NOT NULL AND
      "fiscal_quarter" IS NULL AND "calendar_year" IS NULL AND
      "calendar_quarter" IS NULL AND "calendar_month" IS NULL AND
      "exact_date" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
    OR
    ("period_kind" = 'range' AND "range_start" IS NOT NULL AND
      "range_end" IS NOT NULL AND "exact_date" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "calendar_year" IS NULL AND "calendar_quarter" IS NULL AND
      "calendar_month" IS NULL)
    OR
    ("period_kind" IN ('text_only', 'unknown') AND "exact_date" IS NULL AND
      "fiscal_year" IS NULL AND "fiscal_quarter" IS NULL AND
      "calendar_year" IS NULL AND "calendar_quarter" IS NULL AND
      "calendar_month" IS NULL AND "range_start" IS NULL AND "range_end" IS NULL)
  ) NOT VALID;

ALTER TABLE "program_element_milestone_schedule_period"
  ADD CONSTRAINT "program_element_milestone_schedule_period_provenance_check"
  CHECK (
    "extraction_artifact_id" IS NOT NULL AND btrim("extraction_artifact_id") <> '' AND
    "extraction_artifact_content_sha256" ~ '^[0-9a-f]{64}$' AND
    "assertion_id" IS NOT NULL AND btrim("assertion_id") <> '' AND
    "verification_candidate_id" IS NOT NULL AND btrim("verification_candidate_id") <> '' AND
    "verification_run_id" IS NOT NULL AND btrim("verification_run_id") <> '' AND
    "verification_policy_sha256" ~ '^[0-9a-f]{64}$' AND
    "source_pdf_sha256" ~ '^[0-9a-f]{64}$' AND
    "source_document_id" IS NOT NULL AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND
    jsonb_array_length("evidence_ids_jsonb") > 0
  ) NOT VALID;

CREATE INDEX "program_element_milestone_schedule_period_artifact_idx"
  ON "program_element_milestone_schedule_period" ("extraction_artifact_id");
CREATE INDEX "program_element_milestone_schedule_period_verification_run_idx"
  ON "program_element_milestone_schedule_period" ("verification_run_id");
