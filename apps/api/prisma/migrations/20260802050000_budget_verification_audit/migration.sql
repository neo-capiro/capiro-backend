-- Official budget-document verification audit tables.
-- Additive only: these tables stage extraction candidates and verification evidence;
-- they never write ProgramElementYear canonical dollars.
-- Promotion remains separately gated by VERIFIED_AUTOMATIC/VERIFIED_REVIEWED plus
-- exact source SHA approval.

CREATE TABLE "budget_extraction_candidate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "document_id" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "source_authority" TEXT NOT NULL,
    "source_line_kind" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'EXTRACTED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_extraction_candidate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_extraction_candidate_source_document_fkey"
        FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_extraction_candidate_sha256_check"
        CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "budget_extraction_candidate_status_check"
        CHECK ("status" IN ('EXTRACTED', 'VALIDATING', 'VERIFIED_AUTOMATIC',
                             'VERIFIED_REVIEWED', 'NEEDS_REVIEW', 'REJECTED',
                             'CANONICAL', 'SUPERSEDED'))
);

CREATE UNIQUE INDEX "budget_extraction_candidate_document_sha_key"
    ON "budget_extraction_candidate" ("document_id", "source_sha256");
CREATE INDEX "budget_extraction_candidate_source_document_idx"
    ON "budget_extraction_candidate" ("source_document_id");
CREATE INDEX "budget_extraction_candidate_status_idx"
    ON "budget_extraction_candidate" ("status");

CREATE TABLE "budget_extraction_cell" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "row_id" TEXT NOT NULL,
    "cell_id" TEXT NOT NULL,
    "row_kind" VARCHAR(24) NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "line_kind" TEXT NOT NULL,
    "fy" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "original_value" DECIMAL(20,6) NOT NULL,
    "original_unit" VARCHAR(16) NOT NULL,
    "value_millions" DECIMAL(20,6) NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "source_page" INTEGER NOT NULL,
    "bounding_box_jsonb" JSONB NOT NULL,
    "evidence_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_extraction_cell_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_extraction_cell_candidate_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "budget_extraction_cell_source_document_fkey"
        FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_extraction_cell_sha256_check"
        CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "budget_extraction_cell_page_check"
        CHECK ("source_page" >= 1),
    CONSTRAINT "budget_extraction_cell_unit_check"
        CHECK ("original_unit" IN ('dollars', 'thousands', 'millions'))
);

CREATE UNIQUE INDEX "budget_extraction_cell_candidate_cell_key"
    ON "budget_extraction_cell" ("candidate_id", "cell_id");
CREATE INDEX "budget_extraction_cell_natural_key_idx"
    ON "budget_extraction_cell" ("pe_code", "fy", "field_name");
CREATE INDEX "budget_extraction_cell_source_document_idx"
    ON "budget_extraction_cell" ("source_document_id");

CREATE TABLE "budget_verification_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "route" VARCHAR(40) NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_verification_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_verification_run_candidate_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_run_risk_score_check"
        CHECK ("risk_score" >= 0 AND "risk_score" <= 100)
);

CREATE INDEX "budget_verification_run_candidate_idx"
    ON "budget_verification_run" ("candidate_id", "created_at" DESC);

CREATE TABLE "budget_verification_check" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "risk_points" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "evidence_jsonb" JSONB NOT NULL,
    "details_jsonb" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_verification_check_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_verification_check_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "budget_verification_run"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_check_risk_points_check"
        CHECK ("risk_points" >= 0 AND "risk_points" <= 100)
);

CREATE INDEX "budget_verification_check_run_idx"
    ON "budget_verification_check" ("run_id", "code");

CREATE TABLE "budget_verification_discrepancy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "description" TEXT NOT NULL,
    "evidence_jsonb" JSONB NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_verification_discrepancy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_verification_discrepancy_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "budget_verification_run"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_discrepancy_candidate_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_discrepancy_severity_check"
        CHECK ("severity" IN ('blocking', 'review', 'informational'))
);

CREATE INDEX "budget_verification_discrepancy_candidate_idx"
    ON "budget_verification_discrepancy" ("candidate_id", "created_at" DESC);

CREATE TABLE "budget_review_decision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL,
    "notes" TEXT NOT NULL,
    "approved_sha256" CHAR(64),
    "evidence_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_review_decision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_review_decision_candidate_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "budget_review_decision_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "budget_verification_run"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "budget_review_decision_sha256_check"
        CHECK ("approved_sha256" IS NULL OR "approved_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "budget_review_decision_candidate_idx"
    ON "budget_review_decision" ("candidate_id", "created_at" DESC);

CREATE TABLE "budget_golden_example" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "fy" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "expected_value_millions" DECIMAL(20,6) NOT NULL,
    "evidence_jsonb" JSONB NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_golden_example_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_golden_example_source_document_fkey"
        FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_golden_example_sha256_check"
        CHECK ("source_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "budget_golden_example_natural_key_idx"
    ON "budget_golden_example" ("pe_code", "fy", "field_name");

COMMENT ON TABLE "budget_extraction_candidate" IS
  'Extract-only official budget candidates. Never canonical PE-year dollars.';
COMMENT ON TABLE "budget_review_decision" IS
  'Human review and exact-SHA approval evidence; canonical promotion is a separate writer gate.';
