-- Phase 2 V1 budget verification audit tables.
-- R2 remediation: corrected migration replacing the original 20260816010000.
-- Additive only: creates V1 audit tables for the trusted verification gate.
-- No canonical Program Element table is altered; no canonical promotion authority exists.
-- These tables are separate from the Phase 0 scaffold tables (budget_extraction_candidate,
-- budget_verification_run, etc.) which remain for backward compatibility.
--
-- R2 changes from original:
--   1. Full candidate identity (cycle_id, manifest_document_key, source_document_id,
--      extraction_artifact_id, policy_version) in the unique constraint.
--   2. ON DELETE RESTRICT on all FKs — audit evidence cannot be cascade-deleted.
--   3. Deterministic IDs (no gen_random_uuid default on candidate/run).
--   4. result_snapshot_jsonb column on run for idempotent replay.
--   5. completed_at >= started_at check on run.
--   6. Blank notes check on review.
--   7. Single-terminal-review constraint via trigger.
--   8. Review hash consistency trigger (review hashes must match candidate).

-- K2: V1 extraction candidate with exact identity idempotency.
CREATE TABLE "budget_extraction_candidate_v1" (
    "id" UUID NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "manifest_document_key" TEXT NOT NULL,
    "extraction_artifact_id" TEXT NOT NULL,
    "extraction_artifact_sha256" CHAR(64) NOT NULL,
    "extraction_artifact_locator" TEXT,
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "verifier_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "policy_sha256" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'EXTRACTED',
    "current_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_extraction_candidate_v1_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_extraction_candidate_v1_source_document_fkey"
        FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_extraction_candidate_v1_sha256_check"
        CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "budget_extraction_candidate_v1_manifest_sha_check"
        CHECK ("manifest_content_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "budget_extraction_candidate_v1_artifact_sha_check"
        CHECK ("extraction_artifact_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "budget_extraction_candidate_v1_policy_sha_check"
        CHECK ("policy_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "budget_extraction_candidate_v1_status_check"
        CHECK ("status" IN ('EXTRACTED', 'VALIDATING', 'STRUCTURALLY_VALIDATED',
                            'VERIFICATION_PASSED', 'NEEDS_REVIEW', 'REVIEW_ACCEPTED',
                            'REJECTED', 'SUPERSEDED'))
);

CREATE UNIQUE INDEX "budget_v1_candidate_identity_key"
    ON "budget_extraction_candidate_v1"
    ("cycle_id", "manifest_content_sha256", "manifest_document_key",
     "source_document_id", "source_sha256",
     "extraction_artifact_id", "extraction_artifact_sha256",
     "verifier_version", "policy_version", "policy_sha256");
CREATE INDEX "budget_v1_candidate_source_document_idx"
    ON "budget_extraction_candidate_v1" ("source_document_id");
CREATE INDEX "budget_v1_candidate_status_idx"
    ON "budget_extraction_candidate_v1" ("status");
CREATE INDEX "budget_v1_candidate_cycle_idx"
    ON "budget_extraction_candidate_v1" ("cycle_id");

-- K4: V1 verification run.
CREATE TABLE "budget_verification_run_v1" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "verifier_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "policy_sha256" CHAR(64) NOT NULL,
    "decision" VARCHAR(16) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "route" VARCHAR(40) NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "extraction_artifact_sha256" CHAR(64) NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "result_snapshot_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_verification_run_v1_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_verification_run_v1_candidate_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_run_v1_risk_score_check"
        CHECK ("risk_score" >= 0 AND "risk_score" <= 100),
    CONSTRAINT "budget_verification_run_v1_decision_check"
        CHECK ("decision" IN ('PASS', 'REVIEW', 'REJECT')),
    CONSTRAINT "budget_verification_run_v1_status_check"
        CHECK ("status" IN ('EXTRACTED', 'VALIDATING', 'STRUCTURALLY_VALIDATED',
                            'VERIFICATION_PASSED', 'NEEDS_REVIEW', 'REVIEW_ACCEPTED',
                            'REJECTED', 'SUPERSEDED')),
    CONSTRAINT "budget_verification_run_v1_route_check"
        CHECK ("route" IN ('none', 'targeted_local_reextraction',
                           'paid_page_verifier', 'human_review')),
    CONSTRAINT "budget_verification_run_v1_sha_checks"
        CHECK ("manifest_content_sha256" ~ '^[0-9a-f]{64}$'
           AND "extraction_artifact_sha256" ~ '^[0-9a-f]{64}$'
           AND "source_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "budget_verification_run_v1_completed_after_started_check"
        CHECK ("completed_at" >= "started_at")
);

CREATE INDEX "budget_v1_run_candidate_idx"
    ON "budget_verification_run_v1" ("candidate_id", "created_at" DESC);

-- K5: V1 verification check with outcome vocabulary.
CREATE TABLE "budget_verification_check_v1" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "check_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rule_version" TEXT NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "required" BOOLEAN NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "risk_points" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "assertion_ids_jsonb" JSONB NOT NULL,
    "evidence_ids_jsonb" JSONB NOT NULL,
    "reference_artifact_ids_jsonb" JSONB NOT NULL,
    "details_jsonb" JSONB,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_verification_check_v1_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_verification_check_v1_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_check_v1_outcome_check"
        CHECK ("outcome" IN ('PASS', 'FAIL', 'NOT_RUN', 'SKIPPED')),
    CONSTRAINT "budget_verification_check_v1_risk_points_check"
        CHECK ("risk_points" >= 0 AND "risk_points" <= 100),
    CONSTRAINT "budget_verification_check_v1_passed_outcome_consistency"
        CHECK (("passed" = true AND "outcome" IN ('PASS'))
            OR ("passed" = false AND "outcome" IN ('FAIL', 'NOT_RUN', 'SKIPPED')))
);

CREATE INDEX "budget_v1_check_run_idx"
    ON "budget_verification_check_v1" ("run_id", "code");

-- K3: Proof snapshot table — append-only.
CREATE TABLE "budget_verification_proof" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "proof_kind" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "source_document_id" UUID,
    "artifact_id" TEXT,
    "reference_artifact_id" TEXT,
    "evidence_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_verification_proof_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_verification_proof_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_proof_status_check"
        CHECK ("status" IN ('verified', 'not_applicable', 'missing', 'mismatch'))
);

CREATE INDEX "budget_v1_proof_run_idx"
    ON "budget_verification_proof" ("run_id");

-- V1 discrepancy table.
CREATE TABLE "budget_verification_discrepancy_v1" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "discrepancy_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "description" TEXT NOT NULL,
    "assertion_ids_jsonb" JSONB NOT NULL,
    "evidence_ids_jsonb" JSONB NOT NULL,
    "reference_artifact_ids_jsonb" JSONB NOT NULL,
    "details_jsonb" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_verification_discrepancy_v1_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_verification_discrepancy_v1_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_discrepancy_v1_candidate_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_verification_discrepancy_v1_severity_check"
        CHECK ("severity" IN ('blocking', 'review', 'informational'))
);

CREATE INDEX "budget_v1_discrepancy_candidate_idx"
    ON "budget_verification_discrepancy_v1" ("candidate_id", "created_at" DESC);
CREATE INDEX "budget_v1_discrepancy_run_idx"
    ON "budget_verification_discrepancy_v1" ("run_id");

-- K6: V1 review decision — immutable, append-only.
CREATE TABLE "budget_review_decision_v1" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "decision" VARCHAR(16) NOT NULL,
    "notes" TEXT NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "extraction_artifact_sha256" CHAR(64) NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "evidence_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_review_decision_v1_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_review_decision_v1_candidate_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_review_decision_v1_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_review_decision_v1_decision_check"
        CHECK ("decision" IN ('accept', 'reject')),
    CONSTRAINT "budget_review_decision_v1_notes_check"
        CHECK (length(btrim("notes")) > 0),
    CONSTRAINT "budget_review_decision_v1_sha_checks"
        CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'
           AND "extraction_artifact_sha256" ~ '^[0-9a-f]{64}$'
           AND "manifest_content_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "budget_v1_review_candidate_idx"
    ON "budget_review_decision_v1" ("candidate_id");

-- R8-F2: Concurrent review — at most one terminal decision per candidate.
CREATE UNIQUE INDEX "budget_v1_review_one_terminal_per_candidate"
    ON "budget_review_decision_v1" ("candidate_id")
    WHERE "decision" IN ('accept', 'reject');

CREATE INDEX "budget_v1_review_candidate_created_idx"
    ON "budget_review_decision_v1" ("candidate_id", "created_at" DESC);

-- K8: Append-only controls — prevent update/delete of immutable rows.
CREATE OR REPLACE FUNCTION prevent_budget_v1_run_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_verification_run_v1 rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_run_no_update
  BEFORE UPDATE ON "budget_verification_run_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_run_update();

CREATE OR REPLACE FUNCTION prevent_budget_v1_run_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_verification_run_v1 rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_run_no_delete
  BEFORE DELETE ON "budget_verification_run_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_run_delete();

CREATE OR REPLACE FUNCTION prevent_budget_v1_check_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_verification_check_v1 rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_check_no_update
  BEFORE UPDATE ON "budget_verification_check_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_check_update();

CREATE OR REPLACE FUNCTION prevent_budget_v1_check_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_verification_check_v1 rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_check_no_delete
  BEFORE DELETE ON "budget_verification_check_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_check_delete();

CREATE OR REPLACE FUNCTION prevent_budget_v1_proof_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_verification_proof rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_proof_no_update
  BEFORE UPDATE ON "budget_verification_proof"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_proof_update();

CREATE OR REPLACE FUNCTION prevent_budget_v1_proof_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_verification_proof rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_proof_no_delete
  BEFORE DELETE ON "budget_verification_proof"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_proof_delete();

CREATE OR REPLACE FUNCTION prevent_budget_v1_discrepancy_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_verification_discrepancy_v1 rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_discrepancy_no_update
  BEFORE UPDATE ON "budget_verification_discrepancy_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_discrepancy_update();

CREATE OR REPLACE FUNCTION prevent_budget_v1_discrepancy_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_verification_discrepancy_v1 rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_discrepancy_no_delete
  BEFORE DELETE ON "budget_verification_discrepancy_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_discrepancy_delete();

CREATE OR REPLACE FUNCTION prevent_budget_v1_review_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_review_decision_v1 rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_review_no_update
  BEFORE UPDATE ON "budget_review_decision_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_review_update();

CREATE OR REPLACE FUNCTION prevent_budget_v1_review_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_review_decision_v1 rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_review_no_delete
  BEFORE DELETE ON "budget_review_decision_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_v1_review_delete();

-- K7: Referential consistency — prevent mismatched candidate/run pairs.
CREATE OR REPLACE FUNCTION check_budget_v1_discrepancy_candidate_run()
RETURNS TRIGGER AS $$
DECLARE
  run_candidate_id UUID;
BEGIN
  SELECT candidate_id INTO run_candidate_id
  FROM budget_verification_run_v1
  WHERE id = NEW.run_id;
  IF run_candidate_id IS NULL THEN
    RAISE EXCEPTION 'discrepancy run_id does not reference a valid run';
  END IF;
  IF run_candidate_id <> NEW.candidate_id THEN
    RAISE EXCEPTION 'discrepancy candidate_id does not match run candidate_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_discrepancy_candidate_run_check
  BEFORE INSERT ON "budget_verification_discrepancy_v1"
  FOR EACH ROW EXECUTE FUNCTION check_budget_v1_discrepancy_candidate_run();

-- R2: Review integrity — verify hashes match candidate and single terminal decision.
CREATE OR REPLACE FUNCTION check_budget_v1_review_candidate_run()
RETURNS TRIGGER AS $$
DECLARE
  run_candidate_id UUID;
  candidate_rec RECORD;
  existing_terminal_count INTEGER;
BEGIN
  SELECT candidate_id INTO run_candidate_id
  FROM budget_verification_run_v1
  WHERE id = NEW.run_id;
  IF run_candidate_id IS NULL THEN
    RAISE EXCEPTION 'review run_id does not reference a valid run';
  END IF;
  IF run_candidate_id <> NEW.candidate_id THEN
    RAISE EXCEPTION 'review candidate_id does not match run candidate_id';
  END IF;

  SELECT * INTO candidate_rec
  FROM budget_extraction_candidate_v1
  WHERE id = NEW.candidate_id;

  IF candidate_rec IS NULL THEN
    RAISE EXCEPTION 'review candidate_id does not reference a valid candidate';
  END IF;

  IF candidate_rec.source_sha256 <> NEW.source_sha256 THEN
    RAISE EXCEPTION 'review source_sha256 does not match candidate';
  END IF;
  IF candidate_rec.extraction_artifact_sha256 <> NEW.extraction_artifact_sha256 THEN
    RAISE EXCEPTION 'review extraction_artifact_sha256 does not match candidate';
  END IF;
  IF candidate_rec.manifest_content_sha256 <> NEW.manifest_content_sha256 THEN
    RAISE EXCEPTION 'review manifest_content_sha256 does not match candidate';
  END IF;

  -- Enforce single terminal review decision per candidate
  SELECT COUNT(*) INTO existing_terminal_count
  FROM budget_review_decision_v1
  WHERE candidate_id = NEW.candidate_id
    AND decision IN ('accept', 'reject');

  IF existing_terminal_count > 0 THEN
    RAISE EXCEPTION 'candidate already has a terminal review decision';
  END IF;

  -- Candidate must be in NEEDS_REVIEW state
  IF candidate_rec.status <> 'NEEDS_REVIEW' THEN
    RAISE EXCEPTION 'candidate is not in NEEDS_REVIEW state';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_v1_review_candidate_run_check
  BEFORE INSERT ON "budget_review_decision_v1"
  FOR EACH ROW EXECUTE FUNCTION check_budget_v1_review_candidate_run();

COMMENT ON TABLE "budget_extraction_candidate_v1" IS
  'V1 trusted verification audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_verification_run_v1" IS
  'V1 trusted verification audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_verification_check_v1" IS
  'V1 trusted verification audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_verification_proof" IS
  'V1 trusted verification proof snapshots — append-only.';
COMMENT ON TABLE "budget_verification_discrepancy_v1" IS
  'V1 trusted verification audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_review_decision_v1" IS
  'V1 immutable audit-only human review decision. No canonical Program Element promotion authority.';
