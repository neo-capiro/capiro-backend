-- Phase 8 Session 6 — Federal Funding Event foundation.
--
-- These are GLOBAL, source-grounded federal funding facts. They are intentionally
-- separate from program_element_year: supplemental/reconciliation/CR/rescission/
-- transfer/reprogramming facts are funding vehicles/events, not annual PE stages.
--
-- Semantic invariant preserved by the allocation CHECK below:
-- enacted broad purpose != OMB allotment != DoD/service allocation
-- != Capiro inferred relevance != obligation != outlay.

CREATE TABLE "federal_funding_measure" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "measure_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "authority_type" TEXT NOT NULL,
  "fiscal_year" INTEGER,
  "availability_start" DATE,
  "availability_end" DATE,
  "legislation_id" TEXT,
  "public_law_number" TEXT,
  "title" TEXT NOT NULL,
  "source_document_id" UUID NOT NULL,
  "source_page" INTEGER,
  "dedup_key" CHAR(64) NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "federal_funding_measure_type_chk" CHECK (
    "measure_type" IN (
      'regular_appropriation',
      'supplemental',
      'emergency_supplemental',
      'reconciliation',
      'continuing_resolution',
      'rescission',
      'transfer',
      'reprogramming'
    )
  ),
  CONSTRAINT "federal_funding_measure_status_chk" CHECK (
    "status" IN ('draft', 'introduced', 'enacted', 'active', 'superseded', 'withdrawn', 'expired')
  ),
  CONSTRAINT "federal_funding_measure_authority_chk" CHECK (
    "authority_type" IN ('discretionary', 'mandatory', 'mixed')
  ),
  CONSTRAINT "federal_funding_measure_fy_chk" CHECK (
    "fiscal_year" IS NULL OR "fiscal_year" BETWEEN 1900 AND 2200
  ),
  CONSTRAINT "federal_funding_measure_availability_chk" CHECK (
    "availability_start" IS NULL OR "availability_end" IS NULL OR "availability_start" <= "availability_end"
  ),
  CONSTRAINT "federal_funding_measure_source_page_chk" CHECK (
    "source_page" IS NULL OR "source_page" > 0
  ),
  CONSTRAINT "federal_funding_measure_dedup_key_chk" CHECK (
    "dedup_key" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "federal_funding_measure_source_document_fk"
    FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "federal_funding_measure_dedup_key_key"
  ON "federal_funding_measure"("dedup_key");
CREATE INDEX "federal_funding_measure_type_fy_status_idx"
  ON "federal_funding_measure"("measure_type", "fiscal_year", "status");
CREATE INDEX "federal_funding_measure_public_law_idx"
  ON "federal_funding_measure"("public_law_number");
CREATE INDEX "federal_funding_measure_source_document_idx"
  ON "federal_funding_measure"("source_document_id");

CREATE TABLE "federal_funding_provision" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "measure_id" UUID NOT NULL,
  "section" TEXT,
  "agency" TEXT,
  "component" TEXT,
  "appropriation_title" TEXT,
  "tas" TEXT,
  "stated_amount_usd" NUMERIC(20,2),
  "purpose_text" TEXT NOT NULL,
  "designation" TEXT,
  "transfer_authority" TEXT,
  "availability_start" DATE,
  "availability_end" DATE,
  "source_document_id" UUID NOT NULL,
  "source_page" INTEGER,
  "evidence_sha256" CHAR(64) NOT NULL,
  "dedup_key" CHAR(64) NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "federal_funding_provision_measure_fk"
    FOREIGN KEY ("measure_id") REFERENCES "federal_funding_measure"("id")
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "federal_funding_provision_source_document_fk"
    FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_provision_availability_chk" CHECK (
    "availability_start" IS NULL OR "availability_end" IS NULL OR "availability_start" <= "availability_end"
  ),
  CONSTRAINT "federal_funding_provision_source_page_chk" CHECK (
    "source_page" IS NULL OR "source_page" > 0
  ),
  CONSTRAINT "federal_funding_provision_evidence_sha_chk" CHECK (
    "evidence_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "federal_funding_provision_dedup_key_chk" CHECK (
    "dedup_key" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "federal_funding_provision_dedup_key_key"
  ON "federal_funding_provision"("dedup_key");
CREATE INDEX "federal_funding_provision_measure_idx"
  ON "federal_funding_provision"("measure_id");
CREATE INDEX "federal_funding_provision_account_idx"
  ON "federal_funding_provision"("agency", "component", "tas");
CREATE INDEX "federal_funding_provision_source_document_idx"
  ON "federal_funding_provision"("source_document_id");

CREATE TABLE "federal_funding_allocation" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "provision_id" UUID NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_native_key" TEXT,
  "target_id" TEXT,
  "allocation_stage" TEXT NOT NULL,
  "mapping_maturity" TEXT NOT NULL,
  "review_state" TEXT NOT NULL DEFAULT 'candidate',
  "authoritative_amount_usd" NUMERIC(20,2),
  "inferred_relevance" BOOLEAN NOT NULL DEFAULT FALSE,
  "confidence" NUMERIC(5,4),
  "base_request_status" TEXT NOT NULL DEFAULT 'unknown',
  "potential_double_count" BOOLEAN NOT NULL DEFAULT FALSE,
  "funding_posture" TEXT NOT NULL DEFAULT 'unknown',
  "evidence_source_document_id" UUID NOT NULL,
  "evidence_page" INTEGER,
  "evidence_sha256" CHAR(64) NOT NULL,
  "obligation_reference" TEXT,
  "execution_reference" TEXT,
  "dedup_key" CHAR(64) NOT NULL,
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "federal_funding_allocation_provision_fk"
    FOREIGN KEY ("provision_id") REFERENCES "federal_funding_provision"("id")
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "federal_funding_allocation_evidence_document_fk"
    FOREIGN KEY ("evidence_source_document_id") REFERENCES "source_document"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "federal_funding_allocation_target_type_chk" CHECK (
    "target_type" IN (
      'program_element',
      'program_element_project',
      'procurement_line',
      'om_activity',
      'milcon_project',
      'appropriation_account',
      'capability',
      'federal_program'
    )
  ),
  CONSTRAINT "federal_funding_allocation_stage_chk" CHECK (
    "allocation_stage" IN (
      'statutory',
      'omb_allotment',
      'dod_spend_plan',
      'service_budget_exhibit',
      'reprogramming',
      'obligated'
    )
  ),
  CONSTRAINT "federal_funding_allocation_maturity_chk" CHECK (
    "mapping_maturity" IN (
      'exact_identifier',
      'exact_line_item',
      'account_level',
      'capability_inference',
      'unmapped'
    )
  ),
  CONSTRAINT "federal_funding_allocation_review_state_chk" CHECK (
    "review_state" IN ('candidate', 'verified', 'rejected')
  ),
  CONSTRAINT "federal_funding_allocation_base_request_chk" CHECK (
    "base_request_status" IN ('unknown', 'included', 'not_included', 'partial')
  ),
  CONSTRAINT "federal_funding_allocation_posture_chk" CHECK (
    "funding_posture" IN ('unknown', 'one_time', 'recurring')
  ),
  CONSTRAINT "federal_funding_allocation_confidence_chk" CHECK (
    "confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)
  ),
  CONSTRAINT "federal_funding_allocation_evidence_page_chk" CHECK (
    "evidence_page" IS NULL OR "evidence_page" > 0
  ),
  CONSTRAINT "federal_funding_allocation_evidence_sha_chk" CHECK (
    "evidence_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "federal_funding_allocation_dedup_key_chk" CHECK (
    "dedup_key" ~ '^[0-9a-f]{64}$'
  ),
  -- The core Session 6 safety gate. An inference/candidate can identify an
  -- opportunity, but it can never masquerade as an exact allocated dollar fact.
  CONSTRAINT "federal_funding_allocation_authoritative_dollars_chk" CHECK (
    "authoritative_amount_usd" IS NULL OR (
      "mapping_maturity" IN ('exact_identifier', 'exact_line_item', 'account_level')
      AND "target_type" <> 'capability'
      AND "inferred_relevance" = FALSE
      AND "review_state" = 'verified'
      AND ("target_native_key" IS NOT NULL OR "target_id" IS NOT NULL)
      AND "evidence_source_document_id" IS NOT NULL
      AND "evidence_sha256" IS NOT NULL
    )
  ),
  CONSTRAINT "federal_funding_allocation_inference_money_chk" CHECK (
    NOT ("inferred_relevance" = TRUE AND "authoritative_amount_usd" IS NOT NULL)
  ),
  CONSTRAINT "federal_funding_allocation_capability_money_chk" CHECK (
    NOT ("target_type" = 'capability' AND "authoritative_amount_usd" IS NOT NULL)
  ),
  CONSTRAINT "federal_funding_allocation_unmapped_identity_chk" CHECK (
    "mapping_maturity" <> 'unmapped' OR (
      "target_native_key" IS NULL AND "target_id" IS NULL AND "authoritative_amount_usd" IS NULL
    )
  ),
  CONSTRAINT "federal_funding_allocation_obligation_ref_chk" CHECK (
    "allocation_stage" <> 'obligated' OR "obligation_reference" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "federal_funding_allocation_dedup_key_key"
  ON "federal_funding_allocation"("dedup_key");
CREATE INDEX "federal_funding_allocation_provision_idx"
  ON "federal_funding_allocation"("provision_id");
CREATE INDEX "federal_funding_allocation_target_idx"
  ON "federal_funding_allocation"("target_type", "target_id", "target_native_key");
CREATE INDEX "federal_funding_allocation_review_idx"
  ON "federal_funding_allocation"("review_state", "mapping_maturity");
CREATE INDEX "federal_funding_allocation_evidence_document_idx"
  ON "federal_funding_allocation"("evidence_source_document_id");
CREATE INDEX "federal_funding_allocation_double_count_idx"
  ON "federal_funding_allocation"("potential_double_count")
  WHERE "potential_double_count" = TRUE;

REVOKE ALL ON TABLE "federal_funding_measure" FROM PUBLIC;
REVOKE ALL ON TABLE "federal_funding_provision" FROM PUBLIC;
REVOKE ALL ON TABLE "federal_funding_allocation" FROM PUBLIC;

-- HTTP serves source-grounded reads only. Ingestion/job ownership is the only
-- Session 6 writer; canonical promotion remains a separate concern.
GRANT SELECT ON TABLE "federal_funding_measure" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "federal_funding_provision" TO "capiro_defense_serve";
GRANT SELECT ON TABLE "federal_funding_allocation" TO "capiro_defense_serve";

GRANT SELECT, INSERT, UPDATE ON TABLE "federal_funding_measure" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "federal_funding_provision" TO "capiro_defense_job";
GRANT SELECT, INSERT, UPDATE ON TABLE "federal_funding_allocation" TO "capiro_defense_job";
