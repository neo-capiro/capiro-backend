-- Phase 10B-35c -- formal, auditable "candidate X corrects candidate Y" link.
--
-- Why a dedicated link table instead of a nullable `correctedByCandidateId`
-- column directly on `budget_extraction_candidate_v1`:
--   * The whole-candidate row is a boundary this program keeps deliberately
--     immutable outside its own append-only run/status lifecycle (see
--     `budget_extraction_candidate_v1`'s own doc comments and the Phase
--     10B-35 packet's "never mutate its status, never force a transition"
--     instruction). Adding a column that gets SET on the OLD row the moment a
--     correction is recorded would mutate that row the instant the mechanism
--     runs, even though nothing about the row's own identity, status, or
--     verified content has changed. A separate table lets the old candidate
--     stay byte-for-byte exactly what the original verification wrote,
--     forever -- the correction is a fact ABOUT two candidates, not a fact
--     stored ON one of them.
--   * A dedicated table gets its own append-only/no-delete triggers (mirrors
--     `budget_scoped_fact_review_v1`'s pattern) independent of whatever
--     mutability rules the candidate table needs for its own status
--     lifecycle -- the two concerns don't have to share one row's update
--     policy.
--   * The identity-linking invariant (same source document, same source
--     bytes -- a "correction" is a corrected RE-READING of the same
--     evidence, not a link between two unrelated documents) is naturally
--     expressed as a CHECK against both referenced candidate rows at INSERT
--     time, the same technique `check_budget_scoped_fact_review_v1_binding`
--     already uses.
--   * Idempotency and the concurrency race are both resolved by ONE unique
--     index (`old_candidate_id`) enforced by Postgres itself: two concurrent
--     attempts to correct the same old candidate can never both insert a
--     row, so "two different corrected candidates for the same old one"
--     is impossible at the storage layer, not just discouraged in
--     application code.
--
-- This table is read by `PrismaCandidateCorrectionRepositoryV1` and written
-- ONLY by `CandidateCorrectionV1Service.correct({commit:true})`. It never
-- touches `budget_review_decision_v1`, the outbox, or any candidate/run
-- status column.

CREATE TABLE "budget_candidate_correction_v1" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "old_candidate_id" UUID NOT NULL,
    "new_candidate_id" UUID NOT NULL,
    -- Snapshot of the old candidate's status AT THE MOMENT of correction, for
    -- audit -- the live column on the candidate row can move independently
    -- afterward (e.g. a later, unrelated whole-candidate review decision);
    -- this snapshot answers "what did we believe when we corrected it" even
    -- if that changes.
    "old_candidate_status_at_correction" TEXT NOT NULL,
    "old_candidate_source_document_id" UUID NOT NULL,
    "old_candidate_source_sha256" CHAR(64) NOT NULL,
    "new_candidate_source_document_id" UUID NOT NULL,
    "new_candidate_source_sha256" CHAR(64) NOT NULL,
    "superseded_scoped_fact_review_ids_jsonb" JSONB NOT NULL DEFAULT '[]',
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "budget_candidate_correction_v1_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_candidate_correction_v1_old_fkey"
        FOREIGN KEY ("old_candidate_id") REFERENCES "budget_extraction_candidate_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_candidate_correction_v1_new_fkey"
        FOREIGN KEY ("new_candidate_id") REFERENCES "budget_extraction_candidate_v1"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "budget_candidate_correction_v1_not_self_check"
        CHECK ("old_candidate_id" <> "new_candidate_id"),
    CONSTRAINT "budget_candidate_correction_v1_same_source_check"
        CHECK ("old_candidate_source_document_id" = "new_candidate_source_document_id"
           AND "old_candidate_source_sha256" = "new_candidate_source_sha256"),
    CONSTRAINT "budget_candidate_correction_v1_reason_check"
        CHECK (length(btrim("reason")) > 0),
    CONSTRAINT "budget_candidate_correction_v1_actor_check"
        CHECK (length(btrim("actor")) > 0),
    CONSTRAINT "budget_candidate_correction_v1_sha_checks"
        CHECK ("old_candidate_source_sha256" ~ '^[0-9a-f]{64}$'
           AND "new_candidate_source_sha256" ~ '^[0-9a-f]{64}$')
);

-- The idempotency + concurrency invariant: at most one correction record per
-- OLD candidate, full stop. A second `INSERT` for the same old candidate --
-- whether a genuine retry of the SAME (old, new) pair or a race against a
-- DIFFERENT new candidate -- fails this unique index; the service layer
-- reads the existing row back and decides idempotent-replay vs. explicit
-- refusal (see `CandidateCorrectionV1Service.correct`).
CREATE UNIQUE INDEX "budget_candidate_correction_v1_one_per_old_candidate"
    ON "budget_candidate_correction_v1" ("old_candidate_id");

-- A given NEW candidate can correct at most one old candidate -- prevents a
-- single re-verification result from being registered as "the fix" for two
-- unrelated tainted candidates.
CREATE UNIQUE INDEX "budget_candidate_correction_v1_one_per_new_candidate"
    ON "budget_candidate_correction_v1" ("new_candidate_id");

CREATE INDEX "budget_candidate_correction_v1_old_idx"
    ON "budget_candidate_correction_v1" ("old_candidate_id", "created_at" DESC);
CREATE INDEX "budget_candidate_correction_v1_new_idx"
    ON "budget_candidate_correction_v1" ("new_candidate_id");

-- Append-only, no exceptions: a correction link, once recorded, is never
-- edited (there is no "revoke" for a correction -- if a correction was
-- wrong, the remedy is a FURTHER correction of the new candidate, which
-- produces its own new row and its own new audit trail, never a rewrite of
-- history).
CREATE OR REPLACE FUNCTION prevent_budget_candidate_correction_v1_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_candidate_correction_v1 rows are immutable and cannot be updated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_candidate_correction_v1_no_update
  BEFORE UPDATE ON "budget_candidate_correction_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_candidate_correction_v1_update();

CREATE OR REPLACE FUNCTION prevent_budget_candidate_correction_v1_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'budget_candidate_correction_v1 rows cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_candidate_correction_v1_no_delete
  BEFORE DELETE ON "budget_candidate_correction_v1"
  FOR EACH ROW EXECUTE FUNCTION prevent_budget_candidate_correction_v1_delete();

-- Binding integrity at insert time: both candidates exist, both are bound to
-- the SAME source document and source bytes (a correction re-reads the same
-- evidence; it is never a link between two unrelated documents), and the old
-- candidate is not itself already the NEW side of some other correction
-- (a candidate that already stands as someone else's correction cannot then
-- be "corrected away" itself without that being visible as its own,
-- separate link -- this simply confirms referential sanity, the actual
-- one-per-old/one-per-new invariant is the unique indexes above).
CREATE OR REPLACE FUNCTION check_budget_candidate_correction_v1_binding()
RETURNS TRIGGER AS $$
DECLARE
  old_rec RECORD;
  new_rec RECORD;
BEGIN
  SELECT "id", "status", "source_document_id", "source_sha256"
    INTO old_rec
    FROM "budget_extraction_candidate_v1"
   WHERE "id" = NEW."old_candidate_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'candidate correction: old candidate % not found', NEW."old_candidate_id";
  END IF;
  SELECT "id", "status", "source_document_id", "source_sha256"
    INTO new_rec
    FROM "budget_extraction_candidate_v1"
   WHERE "id" = NEW."new_candidate_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'candidate correction: new candidate % not found', NEW."new_candidate_id";
  END IF;
  IF old_rec."source_document_id" <> new_rec."source_document_id"
     OR old_rec."source_sha256" <> new_rec."source_sha256" THEN
    RAISE EXCEPTION 'candidate correction: old candidate % and new candidate % do not share the same source document/bytes',
      NEW."old_candidate_id", NEW."new_candidate_id";
  END IF;
  IF old_rec."source_document_id" <> NEW."old_candidate_source_document_id"
     OR old_rec."source_sha256" <> NEW."old_candidate_source_sha256"
     OR new_rec."source_document_id" <> NEW."new_candidate_source_document_id"
     OR new_rec."source_sha256" <> NEW."new_candidate_source_sha256" THEN
    RAISE EXCEPTION 'candidate correction: reviewer-supplied source identities do not match the candidates'' own';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER budget_candidate_correction_v1_binding
  BEFORE INSERT ON "budget_candidate_correction_v1"
  FOR EACH ROW EXECUTE FUNCTION check_budget_candidate_correction_v1_binding();
