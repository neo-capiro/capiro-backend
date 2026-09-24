-- Package 5: immutable acquisition source revisions, signed award actions,
-- evidence-qualified program relationships, and explicit coverage gaps.

CREATE TABLE "acquisition_record_revision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identity_key" TEXT NOT NULL,
    "source_system" VARCHAR(64) NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "record_kind" VARCHAR(24) NOT NULL,
    "parent_identity_key" TEXT,
    "title" TEXT,
    "status" VARCHAR(64),
    "buyer_office" TEXT,
    "posted_at" TIMESTAMPTZ(6),
    "response_deadline" TIMESTAMPTZ(6),
    "valid_from" DATE,
    "valid_to" DATE,
    "content_hash" CHAR(64) NOT NULL,
    "source_url" TEXT,
    "source_version" VARCHAR(128),
    "source_observed_at" TIMESTAMPTZ(6),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "acquisition_record_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acquisition_record_revision_kind_check"
      CHECK ("record_kind" IN ('notice','solicitation','vehicle','order','award','modification')),
    CONSTRAINT "acquisition_record_revision_validity_check"
      CHECK ("valid_from" IS NULL OR "valid_to" IS NULL OR "valid_to" >= "valid_from")
);
CREATE UNIQUE INDEX "acquisition_record_revision_identity_content_key"
  ON "acquisition_record_revision" ("identity_key", "content_hash");
CREATE INDEX "acquisition_record_revision_identity_time_idx"
  ON "acquisition_record_revision" ("identity_key", "recorded_at" DESC, "id");
CREATE INDEX "acquisition_record_revision_source_kind_idx"
  ON "acquisition_record_revision" ("source_system", "record_kind", "recorded_at" DESC);
CREATE INDEX "acquisition_record_revision_parent_idx"
  ON "acquisition_record_revision" ("parent_identity_key");

CREATE TABLE "acquisition_award_transaction_revision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transaction_identity_key" TEXT NOT NULL,
    "award_identity_key" TEXT NOT NULL,
    "parent_award_identity_key" TEXT,
    "source_system" VARCHAR(64) NOT NULL,
    "source_transaction_id" TEXT NOT NULL,
    "piid" TEXT,
    "modification_number" TEXT,
    "action_date" DATE,
    "signed_obligation_delta" DECIMAL(20,2),
    "signed_outlay_delta" DECIMAL(20,2),
    "corrects_identity_key" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "content_hash" CHAR(64) NOT NULL,
    "supersedes_id" UUID,
    "source_url" TEXT,
    "source_observed_at" TIMESTAMPTZ(6),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "acquisition_award_transaction_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acquisition_transaction_supersedes_fkey"
      FOREIGN KEY ("supersedes_id") REFERENCES "acquisition_award_transaction_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "acquisition_transaction_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "acquisition_transaction_amount_check"
      CHECK ("signed_obligation_delta" IS NOT NULL OR "signed_outlay_delta" IS NOT NULL)
);
CREATE UNIQUE INDEX "acquisition_transaction_identity_content_key"
  ON "acquisition_award_transaction_revision" ("transaction_identity_key", "content_hash");
CREATE UNIQUE INDEX "acquisition_transaction_supersedes_key"
  ON "acquisition_award_transaction_revision" ("supersedes_id") WHERE "supersedes_id" IS NOT NULL;
CREATE UNIQUE INDEX "acquisition_transaction_root_key"
  ON "acquisition_award_transaction_revision" ("transaction_identity_key") WHERE "supersedes_id" IS NULL;
CREATE INDEX "acquisition_transaction_award_action_idx"
  ON "acquisition_award_transaction_revision" ("award_identity_key", "action_date" DESC);
CREATE INDEX "acquisition_transaction_parent_idx"
  ON "acquisition_award_transaction_revision" ("parent_award_identity_key");
CREATE INDEX "acquisition_transaction_source_id_idx"
  ON "acquisition_award_transaction_revision" ("source_system", "source_transaction_id");

CREATE TABLE "program_acquisition_relationship" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "logical_key" CHAR(64) NOT NULL,
    "subject_kind" VARCHAR(32) NOT NULL,
    "subject_key" TEXT NOT NULL,
    "acquisition_identity_key" TEXT NOT NULL,
    "relationship_class" VARCHAR(48) NOT NULL,
    "valid_from_fy" INTEGER,
    "valid_to_fy" INTEGER,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "supersedes_id" UUID,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "source_system" VARCHAR(64) NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "source_url" TEXT,
    "source_version" VARCHAR(128),
    "source_observed_at" TIMESTAMPTZ(6),
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "allocated_amount_usd" DECIMAL(20,2),
    "unresolved_reason" TEXT,
    "coverage_state" VARCHAR(16) NOT NULL DEFAULT 'unknown',
    "content_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "program_acquisition_relationship_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "program_acquisition_relationship_supersedes_fkey"
      FOREIGN KEY ("supersedes_id") REFERENCES "program_acquisition_relationship"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "program_acquisition_relationship_subject_check"
      CHECK ("subject_kind" IN ('program','pe','pe_project','procurement_line')),
    CONSTRAINT "program_acquisition_relationship_class_check"
      CHECK ("relationship_class" IN ('source_stated_financial_allocation','deterministic_financial_allocation','reviewed_association','inferred_relevance','unresolved')),
    CONSTRAINT "program_acquisition_relationship_review_check"
      CHECK ("review_status" IN ('accepted','candidate','rejected','quarantined','unresolved')),
    CONSTRAINT "program_acquisition_relationship_coverage_check"
      CHECK ("coverage_state" IN ('complete','partial','unknown','unavailable','unsupported')),
    CONSTRAINT "program_acquisition_relationship_fy_check"
      CHECK ("valid_from_fy" IS NULL OR "valid_to_fy" IS NULL OR "valid_to_fy" >= "valid_from_fy"),
    CONSTRAINT "program_acquisition_relationship_confidence_check"
      CHECK ("confidence" >= 0 AND "confidence" <= 1),
    CONSTRAINT "program_acquisition_relationship_money_boundary_check"
      CHECK ("allocated_amount_usd" IS NULL OR "relationship_class" IN ('source_stated_financial_allocation','deterministic_financial_allocation')),
    CONSTRAINT "program_acquisition_relationship_unresolved_check"
      CHECK ("relationship_class" <> 'unresolved' OR ("unresolved_reason" IS NOT NULL AND "coverage_state" <> 'complete')),
    CONSTRAINT "program_acquisition_relationship_reviewed_check"
      CHECK ("review_status" <> 'accepted' OR "reviewed_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "program_acquisition_relationship_logical_content_key"
  ON "program_acquisition_relationship" ("logical_key", "content_hash");
CREATE UNIQUE INDEX "program_acquisition_relationship_supersedes_key"
  ON "program_acquisition_relationship" ("supersedes_id") WHERE "supersedes_id" IS NOT NULL;
CREATE UNIQUE INDEX "program_acquisition_relationship_root_key"
  ON "program_acquisition_relationship" ("logical_key") WHERE "supersedes_id" IS NULL;
CREATE INDEX "program_acquisition_relationship_subject_time_idx"
  ON "program_acquisition_relationship" ("subject_kind", "subject_key", "recorded_at" DESC, "id");
CREATE INDEX "program_acquisition_relationship_acquisition_time_idx"
  ON "program_acquisition_relationship" ("acquisition_identity_key", "recorded_at" DESC);
CREATE INDEX "program_acquisition_relationship_review_class_idx"
  ON "program_acquisition_relationship" ("review_status", "relationship_class");

CREATE TABLE "acquisition_coverage_gap" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_kind" VARCHAR(32) NOT NULL,
    "subject_key" TEXT NOT NULL,
    "source_system" VARCHAR(64) NOT NULL,
    "relationship_kind" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "detail" TEXT,
    "coverage_state" VARCHAR(16) NOT NULL,
    "source_as_of" TIMESTAMPTZ(6),
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "resolved_at" TIMESTAMPTZ(6),
    CONSTRAINT "acquisition_coverage_gap_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "acquisition_coverage_gap_subject_check"
      CHECK ("subject_kind" IN ('program','pe','pe_project','procurement_line')),
    CONSTRAINT "acquisition_coverage_gap_state_check"
      CHECK ("coverage_state" IN ('partial','unknown','unavailable','unsupported'))
);
CREATE UNIQUE INDEX "acquisition_coverage_gap_identity_key"
  ON "acquisition_coverage_gap" ("subject_kind", "subject_key", "source_system", "relationship_kind", "reason");
CREATE INDEX "acquisition_coverage_gap_subject_open_idx"
  ON "acquisition_coverage_gap" ("subject_kind", "subject_key", "resolved_at");
CREATE INDEX "acquisition_coverage_gap_source_open_idx"
  ON "acquisition_coverage_gap" ("source_system", "resolved_at", "last_observed_at" DESC);

CREATE FUNCTION prevent_acquisition_continuity_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; insert a new immutable revision', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "acquisition_record_revision_immutable"
  BEFORE UPDATE OR DELETE ON "acquisition_record_revision"
  FOR EACH ROW EXECUTE FUNCTION prevent_acquisition_continuity_mutation();
CREATE TRIGGER "acquisition_transaction_revision_immutable"
  BEFORE UPDATE OR DELETE ON "acquisition_award_transaction_revision"
  FOR EACH ROW EXECUTE FUNCTION prevent_acquisition_continuity_mutation();
CREATE TRIGGER "program_acquisition_relationship_immutable"
  BEFORE UPDATE OR DELETE ON "program_acquisition_relationship"
  FOR EACH ROW EXECUTE FUNCTION prevent_acquisition_continuity_mutation();

CREATE FUNCTION validate_acquisition_transaction_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prior "acquisition_award_transaction_revision"%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO prior FROM "acquisition_award_transaction_revision" WHERE id = NEW.supersedes_id FOR KEY SHARE;
  IF NOT FOUND OR NEW.transaction_identity_key <> prior.transaction_identity_key THEN
    RAISE EXCEPTION 'transaction revision must supersede the same source transaction';
  END IF;
  IF NEW.revision <> prior.revision + 1 OR NEW.recorded_at <= prior.recorded_at THEN
    RAISE EXCEPTION 'transaction revision and recorded_at must advance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "acquisition_transaction_revision_valid"
  BEFORE INSERT ON "acquisition_award_transaction_revision"
  FOR EACH ROW EXECUTE FUNCTION validate_acquisition_transaction_revision();

CREATE FUNCTION validate_program_acquisition_relationship_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prior "program_acquisition_relationship"%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO prior FROM "program_acquisition_relationship" WHERE id = NEW.supersedes_id FOR KEY SHARE;
  IF NOT FOUND OR NEW.logical_key <> prior.logical_key THEN
    RAISE EXCEPTION 'relationship revision must retain its logical key';
  END IF;
  IF NEW.recorded_at <= prior.recorded_at THEN
    RAISE EXCEPTION 'relationship recorded_at must advance';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "program_acquisition_relationship_revision_valid"
  BEFORE INSERT ON "program_acquisition_relationship"
  FOR EACH ROW EXECUTE FUNCTION validate_program_acquisition_relationship_revision();

GRANT SELECT, INSERT ON "acquisition_record_revision", "acquisition_award_transaction_revision",
  "program_acquisition_relationship" TO capiro_app;
GRANT SELECT, INSERT, UPDATE ON "acquisition_coverage_gap" TO capiro_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "acquisition_record_revision",
  "acquisition_award_transaction_revision", "program_acquisition_relationship" FROM capiro_app;
