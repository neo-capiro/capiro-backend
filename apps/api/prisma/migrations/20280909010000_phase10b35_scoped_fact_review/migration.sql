-- Phase 10B-35 -- scoped (per-fact) human review of verified R-2 PE totals.
--
-- Why a new table instead of a second `budget_review_decision_v1` row:
--   * `budget_v1_review_one_terminal_per_candidate` + `check_budget_v1_review_candidate_run()`
--     + `BudgetReviewV1Service` all enforce ONE terminal decision per candidate, and that
--     decision moves the WHOLE candidate to REVIEW_ACCEPTED / REJECTED. Approving five
--     PE-total assertions must never be recorded as whole-candidate acceptance of the
--     other ~600 assertions, and must never change the candidate's status.
--   * A scoped approval is bound to immutable identities (candidate, run, source SHA,
--     artifact content SHA, manifest SHA, exact assertion ids) and to an explicit scope key
--     (PE / fiscal year / funding field). It carries its own policy id/version/hash,
--     reviewer, rationale and structured limitations, and can be revoked or superseded so a
--     stale approval can never remain visible.
--
-- Serving reads ONLY rows with status='active' AND decision='approve' -- the bounded,
-- partial "reviewed source totals" publication class. It never writes
-- `program_element_year`, `defense_budget_canonical_row`, or any snapshot table.

CREATE TABLE "budget_scoped_fact_review_v1" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "extraction_artifact_id" TEXT NOT NULL,
    "extraction_artifact_sha256" CHAR(64) NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "policy_id" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "policy_sha256" CHAR(64) NOT NULL,
    "scope_kind" VARCHAR(64) NOT NULL,
    "scope_key" TEXT NOT NULL,
    "scope_jsonb" JSONB NOT NULL,
    "assertion_ids_jsonb" JSONB NOT NULL,
    "evidence_ids_jsonb" JSONB NOT NULL,
    "projection_jsonb" JSONB NOT NULL,
    "independence_jsonb" JSONB NOT NULL,
    "limitations_jsonb" JSONB NOT NULL,
    "decision" VARCHAR(16) NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "decision_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "revocation_reason" TEXT,
    "superseded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_scoped_fact_review_v1_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_scoped_fact_review_v1_candidate_fkey"
        FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_scoped_fact_review_v1_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_scoped_fact_review_v1_superseded_by_fkey"
        FOREIGN KEY ("superseded_by_id") REFERENCES "budget_scoped_fact_review_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_scoped_fact_review_v1_decision_check"
        CHECK ("decision" IN ('approve', 'reject')),
    CONSTRAINT "budget_scoped_fact_review_v1_status_check"
        CHECK ("status" IN ('active', 'revoked', 'superseded')),
    CONSTRAINT "budget_scoped_fact_review_v1_scope_kind_check"
        CHECK ("scope_kind" IN ('rdte_r2_pe_total_request_fy')),
    CONSTRAINT "budget_scoped_fact_review_v1_rationale_check"
        CHECK (length(btrim("rationale")) > 0),
    CONSTRAINT "budget_scoped_fact_review_v1_sha_checks"
        CHECK ("source_sha256" ~ '^[0-9a-f]{64}$'
           AND "extraction_artifact_sha256" ~ '^[0-9a-f]{64}$'
           AND "manifest_content_sha256" ~ '^[0-9a-f]{64}$'
           AND "policy_sha256" ~ '^[0-9a-f]{64}$'
           AND "decision_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "budget_scoped_fact_review_v1_revocation_shape_check"
        CHECK (
          ("status" = 'active' AND "revoked_at" IS NULL AND "revoked_by" IS NULL
             AND "revocation_reason" IS NULL AND "superseded_by_id" IS NULL)
          OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL
             AND length(btrim("revocation_reason")) > 0 AND "superseded_by_id" IS NULL)
          OR ("status" = 'superseded' AND "revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL
             AND length(btrim("revocation_reason")) > 0)
        )
);

CREATE INDEX "budget_scoped_fact_review_v1_candidate_idx"
    ON "budget_scoped_fact_review_v1" ("candidate_id", "created_at" DESC);
CREATE INDEX "budget_scoped_fact_review_v1_scope_idx"
    ON "budget_scoped_fact_review_v1" ("scope_kind", "scope_key", "status");

-- One live decision (approve OR reject) per candidate and scope.
CREATE UNIQUE INDEX "budget_scoped_fact_review_v1_one_active_per_candidate_scope"
    ON "budget_scoped_fact_review_v1" ("candidate_id", "scope_kind", "scope_key")
    WHERE "status" = 'active';

-- Serving invariant: at most ONE active approval per scope across all candidates, so a
-- fiscal-year PE total can never be served twice with two different values. A newer
-- approval for the same scope must supersede the older one in the same transaction.
CREATE UNIQUE INDEX "budget_scoped_fact_review_v1_one_active_approval_per_scope"
    ON "budget_scoped_fact_review_v1" ("scope_kind", "scope_key")
    WHERE "status" = 'active' AND "decision" = 'approve';

-- Append-only with exactly one permitted mutation: active -> revoked | superseded, touching
-- ONLY the revocation columns. Every other UPDATE and every DELETE is refused.
CREATE OR REPLACE FUNCTION guard_budget_scoped_fact_review_v1_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" <> 'active' THEN
    RAISE EXCEPTION 'budget_scoped_fact_review_v1: row % is already % and is immutable', OLD."id", OLD."status";
  END IF;
  IF NEW."status" NOT IN ('revoked', 'superseded') THEN
    RAISE EXCEPTION 'budget_scoped_fact_review_v1: the only permitted update is active -> revoked|superseded';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."candidate_id" <> OLD."candidate_id" OR NEW."run_id" <> OLD."run_id"
     OR NEW."source_document_id" <> OLD."source_document_id" OR NEW."source_sha256" <> OLD."source_sha256"
     OR NEW."extraction_artifact_id" <> OLD."extraction_artifact_id"
     OR NEW."extraction_artifact_sha256" <> OLD."extraction_artifact_sha256"
     OR NEW."manifest_content_sha256" <> OLD."manifest_content_sha256"
     OR NEW."policy_id" <> OLD."policy_id" OR NEW."policy_version" <> OLD."policy_version"
     OR NEW."policy_sha256" <> OLD."policy_sha256" OR NEW."scope_kind" <> OLD."scope_kind"
     OR NEW."scope_key" <> OLD."scope_key" OR NEW."scope_jsonb" <> OLD."scope_jsonb"
     OR NEW."assertion_ids_jsonb" <> OLD."assertion_ids_jsonb" OR NEW."evidence_ids_jsonb" <> OLD."evidence_ids_jsonb"
     OR NEW."projection_jsonb" <> OLD."projection_jsonb" OR NEW."independence_jsonb" <> OLD."independence_jsonb"
     OR NEW."limitations_jsonb" <> OLD."limitations_jsonb" OR NEW."decision" <> OLD."decision"
     OR NEW."reviewer_id" <> OLD."reviewer_id" OR NEW."rationale" <> OLD."rationale"
     OR NEW."decision_hash" <> OLD."decision_hash" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'budget_scoped_fact_review_v1: decision columns are immutable; only revocation columns may change';
  END IF;
  NEW."updated_at" := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_scoped_fact_review_v1_guard_update
  BEFORE UPDATE ON "budget_scoped_fact_review_v1"
  FOR EACH ROW EXECUTE FUNCTION guard_budget_scoped_fact_review_v1_update();

CREATE OR REPLACE FUNCTION prevent_budget_scoped_fact_review_v1_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_scoped_fact_review_v1 rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_scoped_fact_review_v1_no_delete
  BEFORE DELETE ON "budget_scoped_fact_review_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_scoped_fact_review_v1_delete();

-- Referential + binding integrity at insert time: the run belongs to the candidate, the
-- three hashes equal the candidate's own, the candidate is reviewable, and the candidate
-- has no whole-candidate REJECT (a rejected or superseded candidate can never gain a
-- scoped approval).
CREATE OR REPLACE FUNCTION check_budget_scoped_fact_review_v1_binding()
RETURNS TRIGGER AS $$
DECLARE
  candidate_rec RECORD;
  run_rec RECORD;
BEGIN
  SELECT "id", "status", "source_sha256", "extraction_artifact_sha256", "manifest_content_sha256",
         "source_document_id", "extraction_artifact_id"
    INTO candidate_rec
    FROM "budget_extraction_candidate_v1"
   WHERE "id" = NEW."candidate_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scoped fact review: candidate % not found', NEW."candidate_id";
  END IF;
  SELECT "id", "candidate_id" INTO run_rec FROM "budget_verification_run_v1" WHERE "id" = NEW."run_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scoped fact review: run % not found', NEW."run_id";
  END IF;
  IF run_rec."candidate_id" <> NEW."candidate_id" THEN
    RAISE EXCEPTION 'scoped fact review: run % does not belong to candidate %', NEW."run_id", NEW."candidate_id";
  END IF;
  IF candidate_rec."source_sha256" <> NEW."source_sha256"
     OR candidate_rec."extraction_artifact_sha256" <> NEW."extraction_artifact_sha256"
     OR candidate_rec."manifest_content_sha256" <> NEW."manifest_content_sha256"
     OR candidate_rec."source_document_id" <> NEW."source_document_id"
     OR candidate_rec."extraction_artifact_id" <> NEW."extraction_artifact_id" THEN
    RAISE EXCEPTION 'scoped fact review: binding identities do not match candidate %', NEW."candidate_id";
  END IF;
  IF NEW."decision" = 'approve' AND candidate_rec."status" NOT IN ('NEEDS_REVIEW', 'REVIEW_ACCEPTED') THEN
    RAISE EXCEPTION 'scoped fact review: candidate % is % and cannot receive a scoped approval',
      NEW."candidate_id", candidate_rec."status";
  END IF;
  IF NEW."status" <> 'active' THEN
    RAISE EXCEPTION 'scoped fact review: rows are always inserted active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_scoped_fact_review_v1_binding
  BEFORE INSERT ON "budget_scoped_fact_review_v1"
  FOR EACH ROW EXECUTE FUNCTION check_budget_scoped_fact_review_v1_binding();
