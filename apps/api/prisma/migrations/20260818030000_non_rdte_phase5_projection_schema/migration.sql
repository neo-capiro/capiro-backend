-- Phase 5 native Procurement, O&M, and MILCON projection schema.
--
-- ADDITIVE ONLY. No data load, backfill, legacy-table rewrite, canonical
-- promotion, or cross-family foreign key to program_element occurs here.
-- The tables remain unwritten until the separately authorized Phase 7 mapper.

CREATE TABLE "procurement_budget_line" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "natural_key" TEXT NOT NULL,
  "component" VARCHAR(16) NOT NULL,
  "account" TEXT NOT NULL,
  "line_code" VARCHAR(64) NOT NULL,
  "printed_line_code" VARCHAR(64) NOT NULL,
  "advance_procurement" BOOLEAN NOT NULL DEFAULT false,
  "title" TEXT,
  "budget_activity" VARCHAR(64),
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "procurement_budget_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_budget_line_identity_check" CHECK (
    btrim("component") <> '' AND btrim("account") <> '' AND
    btrim("line_code") <> '' AND btrim("printed_line_code") <> '' AND
    "natural_key" LIKE 'PROCUREMENT_BLIN:%'
  )
);
CREATE UNIQUE INDEX "procurement_budget_line_natural_key" ON "procurement_budget_line"("natural_key");
CREATE UNIQUE INDEX "procurement_budget_line_native_key" ON "procurement_budget_line"("component", "account", "line_code", "advance_procurement");
CREATE INDEX "procurement_budget_line_component_account_idx" ON "procurement_budget_line"("component", "account");

CREATE TABLE "procurement_budget_line_year" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "budget_line_id" UUID NOT NULL,
  "fiscal_year" INTEGER NOT NULL,
  "funding_field" VARCHAR(32) NOT NULL DEFAULT 'request',
  "amount_millions" NUMERIC(20,6) NOT NULL,
  "quantity" NUMERIC(20,6),
  "original_value" TEXT NOT NULL,
  "original_unit" VARCHAR(16) NOT NULL,
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "procurement_budget_line_year_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_budget_line_year_fy_check" CHECK ("fiscal_year" BETWEEN 1900 AND 2200),
  CONSTRAINT "procurement_budget_line_year_field_check" CHECK ("funding_field" = 'request'),
  CONSTRAINT "procurement_budget_line_year_unit_check" CHECK ("original_unit" IN ('dollars','thousands','millions')),
  CONSTRAINT "procurement_budget_line_year_proof_check" CHECK (
    btrim("extraction_artifact_id") <> '' AND
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_candidate_id") <> '' AND
    btrim("verification_run_id") <> '' AND btrim("verification_decision_id") <> '' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "procurement_budget_line_year_line_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "procurement_budget_line"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "procurement_budget_line_year_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "procurement_budget_line_year_natural_key" ON "procurement_budget_line_year"("budget_line_id", "fiscal_year", "funding_field");
CREATE INDEX "procurement_budget_line_year_fy_idx" ON "procurement_budget_line_year"("fiscal_year");
CREATE INDEX "procurement_budget_line_year_source_document_idx" ON "procurement_budget_line_year"("source_document_id");
CREATE INDEX "procurement_budget_line_year_verification_run_idx" ON "procurement_budget_line_year"("verification_run_id");

CREATE TABLE "procurement_distribution_line" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "budget_line_id" UUID NOT NULL,
  "fiscal_year" INTEGER NOT NULL,
  "distribution_key" TEXT NOT NULL,
  "recipient" TEXT,
  "description" TEXT,
  "quantity" NUMERIC(20,6),
  "amount_millions" NUMERIC(20,6),
  "unit_cost_dollars" NUMERIC(24,6),
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "procurement_distribution_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_distribution_line_fy_check" CHECK ("fiscal_year" BETWEEN 1900 AND 2200),
  CONSTRAINT "procurement_distribution_line_value_check" CHECK (
    "quantity" IS NOT NULL OR "amount_millions" IS NOT NULL OR "unit_cost_dollars" IS NOT NULL
  ),
  CONSTRAINT "procurement_distribution_line_proof_check" CHECK (
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_run_id") <> '' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "procurement_distribution_line_line_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "procurement_budget_line"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "procurement_distribution_line_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "procurement_distribution_line_natural_key" ON "procurement_distribution_line"("budget_line_id", "fiscal_year", "distribution_key");
CREATE INDEX "procurement_distribution_line_source_document_idx" ON "procurement_distribution_line"("source_document_id");

CREATE TABLE "procurement_detail_fact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "budget_line_id" UUID NOT NULL,
  "fiscal_year" INTEGER,
  "fact_kind" VARCHAR(64) NOT NULL,
  "fact_key" TEXT NOT NULL,
  "text_value" TEXT,
  "amount_millions" NUMERIC(20,6),
  "quantity_value" NUMERIC(20,6),
  "unit_cost_dollars" NUMERIC(24,6),
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "procurement_detail_fact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_detail_fact_value_check" CHECK (
    "text_value" IS NOT NULL OR "amount_millions" IS NOT NULL OR
    "quantity_value" IS NOT NULL OR "unit_cost_dollars" IS NOT NULL
  ),
  CONSTRAINT "procurement_detail_fact_proof_check" CHECK (
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_run_id") <> '' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "procurement_detail_fact_line_fkey" FOREIGN KEY ("budget_line_id") REFERENCES "procurement_budget_line"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "procurement_detail_fact_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "procurement_detail_fact_natural_key" ON "procurement_detail_fact"("budget_line_id", "fiscal_year", "fact_kind", "fact_key");
CREATE INDEX "procurement_detail_fact_kind_idx" ON "procurement_detail_fact"("fact_kind");

CREATE TABLE "om_sag" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "natural_key" TEXT NOT NULL,
  "component" VARCHAR(16) NOT NULL,
  "account" TEXT NOT NULL,
  "sag_code" VARCHAR(64) NOT NULL,
  "printed_sag_code" VARCHAR(64) NOT NULL,
  "title" TEXT,
  "budget_activity" VARCHAR(64),
  "activity_group" VARCHAR(64),
  "subactivity_group" VARCHAR(64),
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "om_sag_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "om_sag_identity_check" CHECK (
    btrim("component") <> '' AND btrim("account") <> '' AND
    btrim("sag_code") <> '' AND "natural_key" LIKE 'OM_SAG:%'
  )
);
CREATE UNIQUE INDEX "om_sag_natural_key" ON "om_sag"("natural_key");
CREATE UNIQUE INDEX "om_sag_native_key" ON "om_sag"("component", "account", "sag_code");
CREATE INDEX "om_sag_component_account_idx" ON "om_sag"("component", "account");

CREATE TABLE "om_sag_year" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "om_sag_id" UUID NOT NULL,
  "fiscal_year" INTEGER NOT NULL,
  "funding_field" VARCHAR(32) NOT NULL DEFAULT 'request',
  "amount_millions" NUMERIC(20,6) NOT NULL,
  "original_value" TEXT NOT NULL,
  "original_unit" VARCHAR(16) NOT NULL,
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "om_sag_year_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "om_sag_year_fy_check" CHECK ("fiscal_year" BETWEEN 1900 AND 2200),
  CONSTRAINT "om_sag_year_field_check" CHECK ("funding_field" = 'request'),
  CONSTRAINT "om_sag_year_unit_check" CHECK ("original_unit" IN ('dollars','thousands','millions')),
  CONSTRAINT "om_sag_year_proof_check" CHECK (
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_run_id") <> '' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "om_sag_year_sag_fkey" FOREIGN KEY ("om_sag_id") REFERENCES "om_sag"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "om_sag_year_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "om_sag_year_natural_key" ON "om_sag_year"("om_sag_id", "fiscal_year", "funding_field");
CREATE INDEX "om_sag_year_fy_idx" ON "om_sag_year"("fiscal_year");
CREATE INDEX "om_sag_year_verification_run_idx" ON "om_sag_year"("verification_run_id");

CREATE TABLE "om_detail_fact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "om_sag_id" UUID NOT NULL,
  "fiscal_year" INTEGER,
  "fact_kind" VARCHAR(64) NOT NULL,
  "fact_key" TEXT NOT NULL,
  "text_value" TEXT,
  "amount_millions" NUMERIC(20,6),
  "quantity_value" NUMERIC(20,6),
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "om_detail_fact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "om_detail_fact_value_check" CHECK (
    "text_value" IS NOT NULL OR "amount_millions" IS NOT NULL OR "quantity_value" IS NOT NULL
  ),
  CONSTRAINT "om_detail_fact_proof_check" CHECK (
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_run_id") <> '' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "om_detail_fact_sag_fkey" FOREIGN KEY ("om_sag_id") REFERENCES "om_sag"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "om_detail_fact_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "om_detail_fact_natural_key" ON "om_detail_fact"("om_sag_id", "fiscal_year", "fact_kind", "fact_key");
CREATE INDEX "om_detail_fact_kind_idx" ON "om_detail_fact"("fact_kind");

CREATE TABLE "milcon_project" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "natural_key" TEXT NOT NULL,
  "component" VARCHAR(16) NOT NULL,
  "account" TEXT NOT NULL,
  "project_code" VARCHAR(64) NOT NULL,
  "printed_project_code" VARCHAR(64) NOT NULL,
  "installation" TEXT,
  "location" TEXT,
  "title" TEXT,
  "category_code" VARCHAR(64),
  "scope" TEXT,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "milcon_project_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "milcon_project_identity_check" CHECK (
    btrim("component") <> '' AND btrim("account") <> '' AND
    btrim("project_code") <> '' AND btrim("printed_project_code") <> '' AND
    "natural_key" LIKE 'MILCON_PROJECT:%'
  )
);
CREATE UNIQUE INDEX "milcon_project_natural_key" ON "milcon_project"("natural_key");
CREATE UNIQUE INDEX "milcon_project_native_key" ON "milcon_project"("component", "account", "project_code", COALESCE("location", 'NO_LOC'));
CREATE INDEX "milcon_project_component_account_idx" ON "milcon_project"("component", "account");
CREATE INDEX "milcon_project_installation_idx" ON "milcon_project"("installation");

CREATE TABLE "milcon_project_year" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "milcon_project_id" UUID NOT NULL,
  "fiscal_year" INTEGER NOT NULL,
  "funding_type" VARCHAR(64) NOT NULL,
  "amount_millions" NUMERIC(20,6) NOT NULL,
  "original_value" TEXT NOT NULL,
  "original_unit" VARCHAR(16) NOT NULL,
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "milcon_project_year_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "milcon_project_year_fy_check" CHECK ("fiscal_year" BETWEEN 1900 AND 2200),
  CONSTRAINT "milcon_project_year_unit_check" CHECK ("original_unit" IN ('dollars','thousands','millions')),
  CONSTRAINT "milcon_project_year_proof_check" CHECK (
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_run_id") <> '' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "milcon_project_year_project_fkey" FOREIGN KEY ("milcon_project_id") REFERENCES "milcon_project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "milcon_project_year_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "milcon_project_year_natural_key" ON "milcon_project_year"("milcon_project_id", "fiscal_year", "funding_type");
CREATE INDEX "milcon_project_year_fy_idx" ON "milcon_project_year"("fiscal_year");
CREATE INDEX "milcon_project_year_verification_run_idx" ON "milcon_project_year"("verification_run_id");

CREATE TABLE "milcon_detail_fact" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "milcon_project_id" UUID NOT NULL,
  "fiscal_year" INTEGER,
  "fact_kind" VARCHAR(64) NOT NULL,
  "fact_key" TEXT NOT NULL,
  "text_value" TEXT,
  "amount_millions" NUMERIC(20,6),
  "schedule_value" TEXT,
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "milcon_detail_fact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "milcon_detail_fact_value_check" CHECK (
    "text_value" IS NOT NULL OR "amount_millions" IS NOT NULL OR "schedule_value" IS NOT NULL
  ),
  CONSTRAINT "milcon_detail_fact_proof_check" CHECK (
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_run_id") <> '' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "milcon_detail_fact_project_fkey" FOREIGN KEY ("milcon_project_id") REFERENCES "milcon_project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "milcon_detail_fact_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "milcon_detail_fact_natural_key" ON "milcon_detail_fact"("milcon_project_id", "fiscal_year", "fact_kind", "fact_key");
CREATE INDEX "milcon_detail_fact_kind_idx" ON "milcon_detail_fact"("fact_kind");

CREATE TABLE "non_rdte_budget_line_source_observation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identity_family" VARCHAR(32) NOT NULL,
  "identity_natural_key" TEXT NOT NULL,
  "exhibit" VARCHAR(32) NOT NULL,
  "fiscal_year" INTEGER NOT NULL,
  "source_url" TEXT NOT NULL,
  "page_number" INTEGER NOT NULL,
  "page_end" INTEGER,
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "non_rdte_budget_line_source_observation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "non_rdte_source_observation_family_check" CHECK ("identity_family" IN ('procurement','om','milcon')),
  CONSTRAINT "non_rdte_source_observation_page_check" CHECK (
    "page_number" > 0 AND ("page_end" IS NULL OR "page_end" >= "page_number")
  ),
  CONSTRAINT "non_rdte_source_observation_proof_check" CHECK (
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_run_id") <> '' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "non_rdte_source_observation_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "non_rdte_budget_line_source_observation_natural_key" ON "non_rdte_budget_line_source_observation"("identity_natural_key", "source_document_id", "assertion_id");
CREATE INDEX "non_rdte_source_observation_family_fy_idx" ON "non_rdte_budget_line_source_observation"("identity_family", "fiscal_year");
CREATE INDEX "non_rdte_source_observation_verification_run_idx" ON "non_rdte_budget_line_source_observation"("verification_run_id");

-- Separate from the older program-element-centric budget_line_relationship
-- table. This relation stores native identity-family keys and assertion proof.
CREATE TABLE "non_rdte_budget_line_relationship" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "from_family" VARCHAR(32) NOT NULL,
  "from_natural_key" TEXT NOT NULL,
  "to_family" VARCHAR(32) NOT NULL,
  "to_natural_key" TEXT NOT NULL,
  "relationship_type" VARCHAR(64) NOT NULL,
  "explicit_in_source" BOOLEAN NOT NULL,
  "source_document_id" UUID NOT NULL,
  "extraction_artifact_id" TEXT NOT NULL,
  "extraction_artifact_content_sha256" CHAR(64) NOT NULL,
  "assertion_id" TEXT NOT NULL,
  "verification_candidate_id" TEXT NOT NULL,
  "verification_run_id" TEXT NOT NULL,
  "verification_decision_id" TEXT NOT NULL,
  "source_pdf_sha256" CHAR(64) NOT NULL,
  "evidence_ids_jsonb" JSONB NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "non_rdte_budget_line_relationship_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "non_rdte_relationship_family_check" CHECK (
    "from_family" IN ('procurement','om','milcon','rdte') AND
    "to_family" IN ('procurement','om','milcon','rdte')
  ),
  CONSTRAINT "non_rdte_relationship_explicit_check" CHECK ("explicit_in_source" = true),
  CONSTRAINT "non_rdte_relationship_proof_check" CHECK (
    "extraction_artifact_content_sha256" ~ '^[a-f0-9]{64}$' AND
    "source_pdf_sha256" ~ '^[a-f0-9]{64}$' AND
    btrim("assertion_id") <> '' AND btrim("verification_run_id") <> '' AND
    jsonb_typeof("evidence_ids_jsonb") = 'array' AND jsonb_array_length("evidence_ids_jsonb") > 0
  ),
  CONSTRAINT "non_rdte_relationship_source_document_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "non_rdte_budget_line_relationship_natural_key" ON "non_rdte_budget_line_relationship"("from_natural_key", "to_natural_key", "relationship_type", "source_document_id");
CREATE INDEX "non_rdte_budget_line_relationship_from_idx" ON "non_rdte_budget_line_relationship"("from_natural_key");
CREATE INDEX "non_rdte_budget_line_relationship_to_idx" ON "non_rdte_budget_line_relationship"("to_natural_key");
