-- Phase 4 WS M — RDT&E projection schema preparation (plan §18).
-- ONE additive/expansive migration:
--   1. Widen program_element_project.project_code VarChar(8) -> VarChar(32)
--      (and the two referencing columns pe_program_match.project_code and
--      provision_pe_link.project_code). Widening only: no existing value is
--      truncated, no data deleted, no destructive narrowing.
--   2. Create program_element_project_budget_position (project-level FYDP
--      positions of the printing PB cycle) with a deterministic natural key.
--   3. Create program_element_milestone_schedule_period (truthful R-4
--      schedule periods; never coerced into fabricated dates).
-- No canonical Program Element value is written by this migration; no shared
-- database application happens in Phase 4 (rehearsal on disposable PG only).

-- ── 1. Project code width expansion (VarChar(8) -> VarChar(32)) ────────────
-- R-2A project token policy is bounded at 32 chars (WS H validator); the
-- source-faithful width must never be truncated to fit the old column.
ALTER TABLE "program_element_project"
    ALTER COLUMN "project_code" TYPE VARCHAR(32);

ALTER TABLE "pe_program_match"
    ALTER COLUMN "project_code" TYPE VARCHAR(32);

ALTER TABLE "provision_pe_link"
    ALTER COLUMN "project_code" TYPE VARCHAR(32);

-- ── 2. Project-level budget positions ───────────────────────────────────────
CREATE TABLE "program_element_project_budget_position" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pe_code" VARCHAR(16) NOT NULL,
    "project_code" VARCHAR(32) NOT NULL,
    "position_cycle" TEXT NOT NULL,
    "asserted_fy" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "quantity" DECIMAL(14,2),
    "value_kind" TEXT NOT NULL,
    "source_url" TEXT,
    "page_number" INTEGER,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "source_document_id" UUID,

    CONSTRAINT "program_element_project_budget_position_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "program_element_project_budget_position_pe_fkey"
        FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "program_element_project_budget_position_source_document_fkey"
        FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    -- Natural-key consistency + value-domain constraints.
    CONSTRAINT "program_element_project_budget_position_fy_check"
        CHECK ("asserted_fy" BETWEEN 1900 AND 2200),
    CONSTRAINT "program_element_project_budget_position_value_kind_check"
        CHECK ("value_kind" IN ('total', 'quantity')),
    CONSTRAINT "program_element_project_budget_position_cycle_check"
        CHECK ("position_cycle" <> ''),
    CONSTRAINT "program_element_project_budget_position_project_code_check"
        CHECK ("project_code" <> '' AND char_length("project_code") <= 32)
);

CREATE UNIQUE INDEX "program_element_project_budget_position_natural_key"
    ON "program_element_project_budget_position"
    ("pe_code", "project_code", "position_cycle", "asserted_fy", "value_kind");

CREATE INDEX "program_element_project_budget_position_pe_project_idx"
    ON "program_element_project_budget_position" ("pe_code", "project_code");

CREATE INDEX "program_element_project_budget_position_pe_fy_idx"
    ON "program_element_project_budget_position" ("pe_code", "asserted_fy");

CREATE INDEX "program_element_project_budget_position_cycle_idx"
    ON "program_element_project_budget_position" ("position_cycle");

CREATE INDEX "program_element_project_budget_position_source_document_idx"
    ON "program_element_project_budget_position" ("source_document_id");

-- ── 3. Milestone schedule periods (truthful, no fabricated dates) ──────────
CREATE TABLE "program_element_milestone_schedule_period" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "milestone_id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
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
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "source_document_id" UUID,

    CONSTRAINT "program_element_milestone_schedule_period_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "program_element_milestone_schedule_period_milestone_fkey"
        FOREIGN KEY ("milestone_id") REFERENCES "program_element_milestone"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "program_element_milestone_schedule_period_pe_fkey"
        FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "program_element_milestone_schedule_period_source_document_fkey"
        FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    -- Period-kind vocabulary (R4_SCHEDULE_PERIOD_KIND_V1_VALUES).
    CONSTRAINT "program_element_milestone_schedule_period_kind_check"
        CHECK ("period_kind" IN ('exact_date', 'calendar_month', 'calendar_quarter',
                                 'fiscal_quarter', 'fiscal_year', 'text_only',
                                 'range', 'unknown')),
    CONSTRAINT "program_element_milestone_schedule_period_role_check"
        CHECK ("period_role" IN ('planned', 'actual')),
    -- Quarters 1..4, months 1..12, positive fiscal years.
    CONSTRAINT "program_element_milestone_schedule_period_fq_check"
        CHECK ("fiscal_quarter" IS NULL OR "fiscal_quarter" BETWEEN 1 AND 4),
    CONSTRAINT "program_element_milestone_schedule_period_cq_check"
        CHECK ("calendar_quarter" IS NULL OR "calendar_quarter" BETWEEN 1 AND 4),
    CONSTRAINT "program_element_milestone_schedule_period_month_check"
        CHECK ("calendar_month" IS NULL OR "calendar_month" BETWEEN 1 AND 12),
    CONSTRAINT "program_element_milestone_schedule_period_fy_check"
        CHECK ("fiscal_year" IS NULL OR "fiscal_year" BETWEEN 1900 AND 2200),
    -- Fake period/date combinations are rejected: exact_date is populated
    -- ONLY for exact_date kind; range bounds ONLY for range kind.
    CONSTRAINT "program_element_milestone_schedule_period_exact_consistency"
        CHECK ("period_kind" = 'exact_date' OR "exact_date" IS NULL),
    CONSTRAINT "program_element_milestone_schedule_period_range_consistency"
        CHECK ("period_kind" = 'range' OR ("range_start" IS NULL AND "range_end" IS NULL)),
    CONSTRAINT "program_element_milestone_schedule_period_range_bounds"
        CHECK ("range_start" IS NULL OR "range_end" IS NULL OR "range_start" <= "range_end"),
    CONSTRAINT "program_element_milestone_schedule_period_raw_text_check"
        CHECK ("raw_text" <> '')
);

CREATE UNIQUE INDEX "program_element_milestone_schedule_period_natural_key"
    ON "program_element_milestone_schedule_period"
    ("milestone_id", "period_role", "raw_text");

CREATE INDEX "program_element_milestone_schedule_period_pe_type_idx"
    ON "program_element_milestone_schedule_period" ("pe_code", "milestone_type");

CREATE INDEX "program_element_milestone_schedule_period_kind_idx"
    ON "program_element_milestone_schedule_period" ("period_kind");
