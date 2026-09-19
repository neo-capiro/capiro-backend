-- Package C -- authoritative commit guards for approval replacement.
--
-- Additive/forward-only:
--   * persist the exact revoked review acknowledged by a reapproval;
--   * fence scoped review inserts against revocation, current-run, and
--     corrected-away races;
--   * serialize the correction graph and reject reverse/cyclic links at the
--     write boundary; and
--   * revalidate live candidate eligibility before accepting a correction.

-- Prisma migrate deploy does not wrap PostgreSQL migration files in an
-- implicit transaction. Keep the temporary trigger disable, legacy
-- generation backfill, trigger replacement, and every additive DDL change
-- atomic so a failed/cancelled deploy can never strand the append-only guard
-- disabled or leave a partially applied, non-rerunnable migration.
BEGIN;

ALTER TABLE "budget_scoped_fact_review_v1"
  ADD COLUMN "acknowledged_revoked_review_id" UUID,
  ADD COLUMN "eligibility_state_version" TEXT,
  ADD COLUMN "eligibility_state_sha256" CHAR(64),
  ADD COLUMN "review_generation" BIGINT;

-- A database-owned generation orders review history independently of
-- caller-supplied revocation timestamps. Scope writes are serialized before
-- INSERT, so later same-scope generations always receive a larger value.
-- Legacy history is backfilled deterministically without rewriting any
-- immutable review identity/hash column.
CREATE SEQUENCE "budget_scoped_fact_review_v1_review_generation_seq" AS BIGINT;

-- The pre-Package-C append-only UPDATE trigger correctly rejects mutations
-- to decision rows, including this one-time additive-column backfill. Disable
-- only that trigger for the tightly scoped deterministic assignment, then
-- restore it immediately; status and every pre-existing audit field remain
-- untouched.
ALTER TABLE "budget_scoped_fact_review_v1"
  DISABLE TRIGGER "budget_scoped_fact_review_v1_guard_update";

WITH ordered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id")::bigint AS generation
    FROM "budget_scoped_fact_review_v1"
)
UPDATE "budget_scoped_fact_review_v1" AS review
   SET "review_generation" = ordered.generation
 FROM ordered
 WHERE review."id" = ordered."id";

ALTER TABLE "budget_scoped_fact_review_v1"
  ENABLE TRIGGER "budget_scoped_fact_review_v1_guard_update";

SELECT setval(
  'budget_scoped_fact_review_v1_review_generation_seq',
  GREATEST(COALESCE((SELECT max("review_generation") FROM "budget_scoped_fact_review_v1"), 0) + 1, 1),
  false
);

ALTER TABLE "budget_scoped_fact_review_v1"
  ALTER COLUMN "review_generation" SET DEFAULT nextval('budget_scoped_fact_review_v1_review_generation_seq'),
  ALTER COLUMN "review_generation" SET NOT NULL;

ALTER SEQUENCE "budget_scoped_fact_review_v1_review_generation_seq"
  OWNED BY "budget_scoped_fact_review_v1"."review_generation";

CREATE UNIQUE INDEX "budget_scoped_fact_review_v1_review_generation_unique"
  ON "budget_scoped_fact_review_v1" ("review_generation");

ALTER TABLE "budget_scoped_fact_review_v1"
  ADD CONSTRAINT "budget_scoped_fact_review_v1_ack_revoked_fkey"
  FOREIGN KEY ("acknowledged_revoked_review_id")
  REFERENCES "budget_scoped_fact_review_v1"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "budget_scoped_fact_review_v1_ack_revoked_idx"
  ON "budget_scoped_fact_review_v1" ("acknowledged_revoked_review_id");

-- Legacy correction links remain readable with NULL intent. Every INSERT
-- after this migration is required by the trigger below to carry a versioned,
-- immutable, audit-readable snapshot of the reviewed operation.
ALTER TABLE "budget_candidate_correction_v1"
  ADD COLUMN "reviewed_intent_version" INTEGER,
  ADD COLUMN "reviewed_intent_jsonb" JSONB,
  ADD COLUMN "reviewed_intent_sha256" CHAR(64);

-- Keep the new acknowledgement binding immutable with the rest of the
-- decision. The only permitted mutation remains active -> revoked|superseded.
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
     OR NEW."decision_hash" <> OLD."decision_hash"
     OR NEW."review_generation" <> OLD."review_generation"
     OR NEW."eligibility_state_version" IS DISTINCT FROM OLD."eligibility_state_version"
     OR NEW."eligibility_state_sha256" IS DISTINCT FROM OLD."eligibility_state_sha256"
     OR NEW."acknowledged_revoked_review_id" IS DISTINCT FROM OLD."acknowledged_revoked_review_id"
     OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'budget_scoped_fact_review_v1: decision columns are immutable; only revocation columns may change';
  END IF;
  NEW."updated_at" := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Commit-boundary scoped-review validation. The scope advisory lock is taken
-- before candidate/history/active row checks. Candidate FOR SHARE conflicts
-- with candidate-correction's FOR NO KEY UPDATE fence: review-first is either
-- included in that correction's supersession, while correction-first makes
-- this insert wake and refuse the corrected-away candidate.
CREATE OR REPLACE FUNCTION check_budget_scoped_fact_review_v1_binding()
RETURNS TRIGGER AS $$
DECLARE
  candidate_rec RECORD;
  run_rec RECORD;
  latest_revoked_rec RECORD;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION '[scoped_fact_review_requires_read_committed] scoped review writes require READ COMMITTED so post-lock checks observe newly committed state';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('budget_scoped_fact_review_v1:' || NEW."scope_kind" || ':' || NEW."scope_key", 0)
  );

  -- Assign only after the scope serialization point, and overwrite even an
  -- explicitly supplied value: chronology is owned by this database
  -- sequence, never by a client clock or raw writer.
  NEW."review_generation" := nextval('budget_scoped_fact_review_v1_review_generation_seq');

  SELECT "id", "status", "current_run_id", "source_sha256",
         "extraction_artifact_sha256", "manifest_content_sha256",
         "source_document_id", "extraction_artifact_id"
    INTO candidate_rec
    FROM "budget_extraction_candidate_v1"
   WHERE "id" = NEW."candidate_id"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scoped fact review: candidate % not found', NEW."candidate_id";
  END IF;

  -- Candidate -> evidence advisory -> run is shared with the sanctioned
  -- repository. Evidence inserts take the advisory before their FK run-row
  -- lock, so taking it here before FOR UPDATE avoids a run/advisory inversion.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('budget_verification_evidence_v1:' || NEW."run_id"::text, 0)
  );

  SELECT "id", "candidate_id", "decision", "source_sha256",
         "extraction_artifact_sha256", "manifest_content_sha256"
    INTO run_rec
    FROM "budget_verification_run_v1"
   WHERE "id" = NEW."run_id"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scoped fact review: run % not found', NEW."run_id";
  END IF;
  IF run_rec."candidate_id" <> NEW."candidate_id" THEN
    RAISE EXCEPTION 'scoped fact review: run % does not belong to candidate %', NEW."run_id", NEW."candidate_id";
  END IF;
  IF candidate_rec."current_run_id" IS NULL OR candidate_rec."current_run_id" <> NEW."run_id" THEN
    RAISE EXCEPTION '[scoped_fact_review_stale_run] run % is not current run % for candidate %',
      NEW."run_id", candidate_rec."current_run_id", NEW."candidate_id";
  END IF;
  IF run_rec."decision" NOT IN ('PASS', 'REVIEW') THEN
    RAISE EXCEPTION '[scoped_fact_review_stale_run] run % decision % cannot authorize scoped approval',
      NEW."run_id", run_rec."decision";
  END IF;
  IF run_rec."source_sha256" <> NEW."source_sha256"
     OR run_rec."extraction_artifact_sha256" <> NEW."extraction_artifact_sha256"
     OR run_rec."manifest_content_sha256" <> NEW."manifest_content_sha256" THEN
    RAISE EXCEPTION '[scoped_fact_review_stale_run] run % identity hashes do not match the proposed review', NEW."run_id";
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
  IF EXISTS (
    SELECT 1 FROM "budget_candidate_correction_v1"
     WHERE "old_candidate_id" = NEW."candidate_id"
  ) THEN
    RAISE EXCEPTION '[scoped_fact_review_candidate_corrected_away] candidate % already has a correction link', NEW."candidate_id";
  END IF;
  IF NEW."eligibility_state_version" IS DISTINCT FROM 'scoped_fact_review_eligibility_state_v1'
     OR NEW."eligibility_state_sha256" IS NULL
     OR NEW."eligibility_state_sha256" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '[scoped_fact_review_eligibility_state] new scoped reviews require a valid versioned eligibility-state digest';
  END IF;
  IF current_setting('capiro.scoped_fact_review_writer_v1', true)
       IS DISTINCT FROM NEW."eligibility_state_sha256" THEN
    RAISE EXCEPTION '[scoped_fact_review_unsanctioned_writer] scoped review inserts must use the locked repository eligibility recheck';
  END IF;
  IF NEW."status" <> 'active' THEN
    RAISE EXCEPTION 'scoped fact review: rows are always inserted active';
  END IF;

  -- No stale/null acknowledgement may silently cover a human revocation.
  IF NEW."decision" = 'approve' THEN
    SELECT "id", "rationale"
      INTO latest_revoked_rec
      FROM "budget_scoped_fact_review_v1"
     WHERE "candidate_id" = NEW."candidate_id"
       AND "scope_kind" = NEW."scope_kind"
       AND "scope_key" = NEW."scope_key"
       AND "status" = 'revoked'
     ORDER BY "review_generation" DESC
     LIMIT 1;

    IF FOUND AND NEW."acknowledged_revoked_review_id" IS NULL THEN
      RAISE EXCEPTION '[scoped_fact_review_revocation_precondition] latest revoked review % requires exact acknowledgement',
        latest_revoked_rec."id";
    END IF;
    IF FOUND AND NEW."acknowledged_revoked_review_id" <> latest_revoked_rec."id" THEN
      RAISE EXCEPTION '[scoped_fact_review_revocation_precondition] acknowledged review % is stale; latest revoked review is %',
        NEW."acknowledged_revoked_review_id", latest_revoked_rec."id";
    END IF;
    IF NOT FOUND AND NEW."acknowledged_revoked_review_id" IS NOT NULL THEN
      RAISE EXCEPTION '[scoped_fact_review_revocation_precondition] acknowledged review % is not the latest revoked review for this candidate/scope',
        NEW."acknowledged_revoked_review_id";
    END IF;
    IF FOUND AND btrim(latest_revoked_rec."rationale") = btrim(NEW."rationale") THEN
      RAISE EXCEPTION '[scoped_fact_review_revocation_precondition] intentional reapproval requires a fresh rationale distinct from revoked review %',
        latest_revoked_rec."id";
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "budget_scoped_fact_review_v1"
     WHERE "candidate_id" = NEW."candidate_id"
       AND "scope_kind" = NEW."scope_kind"
       AND "scope_key" = NEW."scope_key"
       AND "status" = 'active'
  ) THEN
    RAISE EXCEPTION '[scoped_fact_review_active_conflict] candidate % already has an active decision for scope %',
      NEW."candidate_id", NEW."scope_key";
  END IF;
  IF NEW."decision" = 'approve' AND EXISTS (
    SELECT 1 FROM "budget_scoped_fact_review_v1"
     WHERE "scope_kind" = NEW."scope_kind"
       AND "scope_key" = NEW."scope_key"
       AND "status" = 'active'
       AND "decision" = 'approve'
  ) THEN
    RAISE EXCEPTION '[scoped_fact_review_active_conflict] another active approval already owns scope %', NEW."scope_key";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Once any scoped review history exists for a run, its eligibility evidence
-- is sealed. Late appends must create a new verification run instead. The
-- shared per-run advisory lock gives deterministic ordering in both races:
-- evidence-first is observed/refused by the review digest comparison;
-- review-first makes the evidence writer wait and then fail closed.
CREATE OR REPLACE FUNCTION guard_budget_verification_evidence_after_scoped_review_v1()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION '[budget_verification_evidence_requires_read_committed] verification evidence writes require READ COMMITTED so post-lock checks observe newly committed review history';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('budget_verification_evidence_v1:' || NEW."run_id"::text, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM "budget_scoped_fact_review_v1"
     WHERE "run_id" = NEW."run_id"
  ) THEN
    RAISE EXCEPTION '[budget_verification_evidence_sealed] run % already has scoped review history; create a new verification run',
      NEW."run_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "budget_verification_check_v1_seal_after_review"
BEFORE INSERT ON "budget_verification_check_v1"
FOR EACH ROW EXECUTE FUNCTION guard_budget_verification_evidence_after_scoped_review_v1();

CREATE TRIGGER "budget_verification_discrepancy_v1_seal_after_review"
BEFORE INSERT ON "budget_verification_discrepancy_v1"
FOR EACH ROW EXECUTE FUNCTION guard_budget_verification_evidence_after_scoped_review_v1();

CREATE TRIGGER "budget_verification_proof_v1_seal_after_review"
BEFORE INSERT ON "budget_verification_proof"
FOR EACH ROW EXECUTE FUNCTION guard_budget_verification_evidence_after_scoped_review_v1();

-- Correction graph commits are globally serialized because the graph is tiny
-- and append-only. Re-lock both candidates in deterministic UUID order, then
-- validate live state. The application acquires the same graph lock before
-- superseding reviews; this trigger is the direct-writer/version-skew backstop.
CREATE OR REPLACE FUNCTION check_budget_candidate_correction_v1_binding()
RETURNS TRIGGER AS $$
DECLARE
  old_rec RECORD;
  new_rec RECORD;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION '[candidate_correction_requires_read_committed] correction writes require READ COMMITTED so post-lock graph checks observe newly committed links';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('budget_candidate_correction_v1:graph', 0));

  PERFORM 1
    FROM "budget_extraction_candidate_v1"
   WHERE "id" IN (NEW."old_candidate_id", NEW."new_candidate_id")
   ORDER BY "id"
   FOR NO KEY UPDATE;

  SELECT "id", "status", "current_run_id", "source_document_id", "source_sha256",
         "extraction_artifact_id", "extraction_artifact_sha256", "manifest_content_sha256"
    INTO old_rec
    FROM "budget_extraction_candidate_v1"
   WHERE "id" = NEW."old_candidate_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'candidate correction: old candidate % not found', NEW."old_candidate_id";
  END IF;
  SELECT "id", "status", "current_run_id", "source_document_id", "source_sha256",
         "extraction_artifact_id", "extraction_artifact_sha256", "manifest_content_sha256"
    INTO new_rec
    FROM "budget_extraction_candidate_v1"
   WHERE "id" = NEW."new_candidate_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'candidate correction: new candidate % not found', NEW."new_candidate_id";
  END IF;

  IF old_rec."status" NOT IN ('NEEDS_REVIEW', 'REJECTED')
     OR NEW."old_candidate_status_at_correction" <> old_rec."status" THEN
    RAISE EXCEPTION '[candidate_correction_stale_eligibility] old candidate % live status % does not match correctable snapshot %',
      NEW."old_candidate_id", old_rec."status", NEW."old_candidate_status_at_correction";
  END IF;
  IF new_rec."status" = 'REJECTED' THEN
    RAISE EXCEPTION '[candidate_correction_stale_eligibility] new candidate % is REJECTED', NEW."new_candidate_id";
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

  -- The explicit correction columns predate Package C and capture source
  -- identity only. New links additionally persist the complete reviewed
  -- operation (including selected scopes) so later candidate mutation cannot
  -- erase what the operator authorized. Existing legacy rows remain NULL.
  IF NEW."reviewed_intent_version" IS DISTINCT FROM 1
     OR NEW."reviewed_intent_jsonb" IS NULL
     OR jsonb_typeof(NEW."reviewed_intent_jsonb") <> 'object'
     OR (NEW."reviewed_intent_jsonb" ->> 'version') IS DISTINCT FROM '1'
     OR jsonb_typeof(NEW."reviewed_intent_jsonb" -> 'oldCandidate') IS DISTINCT FROM 'object'
     OR NOT coalesce((NEW."reviewed_intent_jsonb" -> 'oldCandidate') ? 'currentRunId', false)
     OR jsonb_typeof(NEW."reviewed_intent_jsonb" -> 'newCandidate') IS DISTINCT FROM 'object'
     OR NOT coalesce((NEW."reviewed_intent_jsonb" -> 'newCandidate') ? 'currentRunId', false)
     OR jsonb_typeof(NEW."reviewed_intent_jsonb" -> 'selectedScopes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '[candidate_correction_reviewed_intent] new correction links require reviewed intent version 1 and selectedScopes';
  END IF;
  IF (NEW."reviewed_intent_jsonb" #>> '{oldCandidate,id}') IS DISTINCT FROM NEW."old_candidate_id"::text
     OR (NEW."reviewed_intent_jsonb" #>> '{oldCandidate,currentRunId}') IS DISTINCT FROM old_rec."current_run_id"::text
     OR (NEW."reviewed_intent_jsonb" #>> '{oldCandidate,sourceDocumentId}') IS DISTINCT FROM old_rec."source_document_id"::text
     OR (NEW."reviewed_intent_jsonb" #>> '{oldCandidate,sourceSha256}') IS DISTINCT FROM old_rec."source_sha256"
     OR (NEW."reviewed_intent_jsonb" #>> '{oldCandidate,extractionArtifactId}') IS DISTINCT FROM old_rec."extraction_artifact_id"
     OR (NEW."reviewed_intent_jsonb" #>> '{oldCandidate,extractionArtifactSha256}') IS DISTINCT FROM old_rec."extraction_artifact_sha256"
     OR (NEW."reviewed_intent_jsonb" #>> '{oldCandidate,manifestContentSha256}') IS DISTINCT FROM old_rec."manifest_content_sha256"
     OR (NEW."reviewed_intent_jsonb" #>> '{newCandidate,id}') IS DISTINCT FROM NEW."new_candidate_id"::text
     OR (NEW."reviewed_intent_jsonb" #>> '{newCandidate,currentRunId}') IS DISTINCT FROM new_rec."current_run_id"::text
     OR (NEW."reviewed_intent_jsonb" #>> '{newCandidate,sourceDocumentId}') IS DISTINCT FROM new_rec."source_document_id"::text
     OR (NEW."reviewed_intent_jsonb" #>> '{newCandidate,sourceSha256}') IS DISTINCT FROM new_rec."source_sha256"
     OR (NEW."reviewed_intent_jsonb" #>> '{newCandidate,extractionArtifactId}') IS DISTINCT FROM new_rec."extraction_artifact_id"
     OR (NEW."reviewed_intent_jsonb" #>> '{newCandidate,extractionArtifactSha256}') IS DISTINCT FROM new_rec."extraction_artifact_sha256"
     OR (NEW."reviewed_intent_jsonb" #>> '{newCandidate,manifestContentSha256}') IS DISTINCT FROM new_rec."manifest_content_sha256" THEN
    RAISE EXCEPTION '[candidate_correction_reviewed_intent] reviewed candidate/run/source/artifact/manifest identity does not match locked candidates';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW."reviewed_intent_jsonb" -> 'selectedScopes') AS s
     WHERE jsonb_typeof(s) IS DISTINCT FROM 'object'
        OR jsonb_typeof(s -> 'scopeKind') IS DISTINCT FROM 'string'
        OR jsonb_typeof(s -> 'scopeKey') IS DISTINCT FROM 'string'
        OR jsonb_typeof(s -> 'scope') IS DISTINCT FROM 'object'
        OR jsonb_typeof(s -> 'scope' -> 'scopeKind') IS DISTINCT FROM 'string'
        OR jsonb_typeof(s -> 'scope' -> 'peCode') IS DISTINCT FROM 'string'
        OR jsonb_typeof(s -> 'scope' -> 'fiscalYear') IS DISTINCT FROM 'number'
        OR jsonb_typeof(s -> 'scope' -> 'fundingField') IS DISTINCT FROM 'string'
        OR jsonb_typeof(s -> 'scope' -> 'component') IS DISTINCT FROM 'string'
        OR jsonb_typeof(s -> 'expectedTotalMillions') IS DISTINCT FROM 'string'
        OR jsonb_typeof(s -> 'expectedPhysicalPage') IS DISTINCT FROM 'number'
        OR jsonb_typeof(s -> 'expectedAssertionIds') IS DISTINCT FROM 'array'
        OR jsonb_typeof(s -> 'expectedEvidenceIds') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION '[candidate_correction_reviewed_intent] selectedScopes must contain unique, well-formed exact scopes';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW."reviewed_intent_jsonb" -> 'selectedScopes') AS s
     WHERE (s ->> 'scopeKind') IS DISTINCT FROM 'rdte_r2_pe_total_request_fy'
        OR (s -> 'scope' ->> 'scopeKind') IS DISTINCT FROM 'rdte_r2_pe_total_request_fy'
        OR (SELECT count(*) FROM jsonb_object_keys(s -> 'scope')) <> 5
        OR jsonb_typeof(s -> 'scope' -> 'peCode') IS DISTINCT FROM 'string'
        OR btrim(s -> 'scope' ->> 'peCode') = ''
        OR jsonb_typeof(s -> 'scope' -> 'fiscalYear') IS DISTINCT FROM 'number'
        OR (s #>> '{scope,fiscalYear}') !~ '^[0-9]+$'
        OR (s #>> '{scope,fiscalYear}')::numeric <= 0
        OR jsonb_typeof(s -> 'scope' -> 'fundingField') IS DISTINCT FROM 'string'
        OR (s #>> '{scope,fundingField}') IS DISTINCT FROM 'request'
        OR jsonb_typeof(s -> 'scope' -> 'component') IS DISTINCT FROM 'string'
        OR btrim(s #>> '{scope,component}') = ''
        OR (s ->> 'scopeKey') IS DISTINCT FROM concat(
             s #>> '{scope,component}', '|', s #>> '{scope,peCode}', '|FY',
             s #>> '{scope,fiscalYear}', '|request'
           )
        OR btrim(s ->> 'expectedTotalMillions') !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$'
        OR (s ->> 'expectedPhysicalPage') !~ '^[0-9]+$'
        OR (s ->> 'expectedPhysicalPage')::numeric <= 0
        OR jsonb_array_length(s -> 'expectedAssertionIds') = 0
        OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(s -> 'expectedAssertionIds') AS assertion_id
              WHERE jsonb_typeof(assertion_id) IS DISTINCT FROM 'string'
                 OR btrim(assertion_id #>> '{}') = ''
           )
        OR jsonb_array_length(s -> 'expectedAssertionIds') <> (
             SELECT count(DISTINCT assertion_id #>> '{}')
               FROM jsonb_array_elements(s -> 'expectedAssertionIds') AS assertion_id
           )
        OR jsonb_array_length(s -> 'expectedEvidenceIds') = 0
        OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(s -> 'expectedEvidenceIds') AS evidence_id
              WHERE jsonb_typeof(evidence_id) IS DISTINCT FROM 'string'
                 OR btrim(evidence_id #>> '{}') = ''
           )
        OR jsonb_array_length(s -> 'expectedEvidenceIds') <> (
             SELECT count(DISTINCT evidence_id #>> '{}')
               FROM jsonb_array_elements(s -> 'expectedEvidenceIds') AS evidence_id
           )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW."reviewed_intent_jsonb" -> 'selectedScopes') AS s
     GROUP BY s ->> 'scopeKey'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '[candidate_correction_reviewed_intent] selectedScopes must contain unique, well-formed exact scopes';
  END IF;
  -- Database-owned tamper digest over PostgreSQL's deterministic JSONB text.
  -- The trigger overwrites any caller-supplied value, so a raw writer cannot
  -- assert an arbitrary digest for a different payload.
  NEW."reviewed_intent_sha256" := encode(
    digest(convert_to(NEW."reviewed_intent_jsonb"::text, 'UTF8'), 'sha256'),
    'hex'
  );
  IF EXISTS (
    SELECT 1 FROM "budget_candidate_correction_v1"
     WHERE "old_candidate_id" = NEW."new_candidate_id"
  ) THEN
    RAISE EXCEPTION '[candidate_correction_reverse_or_cycle] proposed new candidate % already stands on the corrected-away side of a link',
      NEW."new_candidate_id";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "budget_scoped_fact_review_v1"
     WHERE "candidate_id" = NEW."old_candidate_id" AND "status" = 'active'
  ) THEN
    RAISE EXCEPTION '[candidate_correction_active_reviews_remain] old candidate % still has active scoped reviews',
      NEW."old_candidate_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
