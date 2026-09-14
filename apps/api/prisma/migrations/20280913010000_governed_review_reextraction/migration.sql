-- Governed REVIEW re-extraction is an operation ABOUT an existing candidate.
-- It does not reset the original outbox or alter that candidate's review state.
CREATE TABLE "budget_reextraction_operation_v1" (
  "id" UUID PRIMARY KEY,
  "outbox_row_id" UUID NOT NULL REFERENCES "defense_budget_ingestion_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "old_candidate_id" UUID NOT NULL REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "old_verification_run_id" UUID NOT NULL REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "cycle_id" UUID NOT NULL REFERENCES "defense_budget_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "source_document_id" UUID NOT NULL REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "source_sha256" CHAR(64) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "request_jsonb" JSONB NOT NULL,
  "snapshot_jsonb" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "lease_token" UUID,
  "leased_until" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "verification_correlations_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "terminal_jsonb" JSONB,
  "closure_jsonb" JSONB,
  "candidate_id" UUID REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "verification_run_id" UUID REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "budget_reextraction_operation_v1_status_check" CHECK ("status" IN ('running','failed','completed','blocked')),
  CONSTRAINT "budget_reextraction_operation_v1_sha_check" CHECK ("source_sha256" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "budget_reextraction_operation_v1_attempts_check" CHECK ("attempts">0),
  CONSTRAINT "budget_reextraction_operation_v1_lease_check" CHECK (
    ("status"='running' AND "lease_token" IS NOT NULL AND "leased_until" IS NOT NULL) OR
    ("status"<>'running' AND "lease_token" IS NULL AND "leased_until" IS NULL)),
  CONSTRAINT "budget_reextraction_operation_v1_json_check" CHECK (
    jsonb_typeof("request_jsonb")='object' AND jsonb_typeof("snapshot_jsonb")='object' AND
    jsonb_typeof("verification_correlations_jsonb")='array' AND
    ("terminal_jsonb" IS NULL OR jsonb_typeof("terminal_jsonb")='object') AND
    ("closure_jsonb" IS NULL OR ("status"='blocked' AND jsonb_typeof("closure_jsonb")='object' AND
      (length(btrim("closure_jsonb"->>'actor'))>0 AND length(btrim("closure_jsonb"->>'reason'))>0 AND
       length("closure_jsonb"->>'closedAt')>0) IS TRUE))),
  CONSTRAINT "budget_reextraction_operation_v1_result_check" CHECK (
    ("status"='completed' AND "terminal_jsonb" IS NOT NULL AND "candidate_id" IS NOT NULL AND "verification_run_id" IS NOT NULL) OR
    ("status"<>'completed' AND "terminal_jsonb" IS NULL AND "candidate_id" IS NULL AND "verification_run_id" IS NULL)),
  CONSTRAINT "budget_reextraction_operation_v1_request_check" CHECK ((
    "request_jsonb"->>'operationId'="id"::text AND
    "request_jsonb"->>'outboxRowId'="outbox_row_id"::text AND
    "request_jsonb"->>'oldCandidateId'="old_candidate_id"::text AND
    "request_jsonb"->>'expectedOldVerificationRunId'="old_verification_run_id"::text AND
    "request_jsonb"->>'expectedSourceSha256'="source_sha256" AND
    "request_jsonb"->>'expectedOldExtractionArtifactSha256' ~ '^[0-9a-f]{64}$' AND
    length(btrim("request_jsonb"->>'actor'))>0 AND length(btrim("request_jsonb"->>'reason'))>0 AND
    length(btrim("request_jsonb"->>'releaseRevision'))>0 AND
    "snapshot_jsonb"->>'cycleId'="cycle_id"::text AND
    "snapshot_jsonb"->>'sourceDocumentId'="source_document_id"::text AND
    "snapshot_jsonb"->>'sourceSha256'="source_sha256" AND
    left("snapshot_jsonb"->>'sourcePath',1)='/') IS TRUE)
);

-- One active operation per old candidate. A later explicitly named operation
-- may use repaired code after completion/failure; old request/result history is
-- preserved. Reusing an operation ID still requires the exact original request.
CREATE UNIQUE INDEX "budget_reextraction_operation_v1_active_old_key"
  ON "budget_reextraction_operation_v1"("old_candidate_id") WHERE "status"='running';
-- Two historical candidates for the same source cannot run OCR concurrently.
-- Expired running operations must be explicitly resumed, preserving ownership.
CREATE UNIQUE INDEX "budget_reextraction_operation_v1_active_source_key"
  ON "budget_reextraction_operation_v1"("cycle_id","source_document_id") WHERE "status"='running';
CREATE INDEX "budget_reextraction_operation_v1_claim_idx" ON "budget_reextraction_operation_v1"("status","leased_until");

CREATE FUNCTION guard_budget_reextraction_operation_v1() RETURNS TRIGGER AS $$
DECLARE
  old_count INTEGER;
  new_count INTEGER;
  i INTEGER;
  checkpoint JSONB;
  candidate_rec RECORD;
  run_rec RECORD;
  abandoning BOOLEAN := FALSE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 're-extraction operations cannot be deleted';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW."id",NEW."outbox_row_id",NEW."old_candidate_id",NEW."old_verification_run_id",NEW."cycle_id",NEW."source_document_id",
           NEW."source_sha256",NEW."request_hash",NEW."request_jsonb",NEW."snapshot_jsonb",NEW."created_at") IS DISTINCT FROM
       ROW(OLD."id",OLD."outbox_row_id",OLD."old_candidate_id",OLD."old_verification_run_id",OLD."cycle_id",OLD."source_document_id",
           OLD."source_sha256",OLD."request_hash",OLD."request_jsonb",OLD."snapshot_jsonb",OLD."created_at") THEN
      RAISE EXCEPTION 're-extraction request and snapshot are immutable';
    END IF;
    IF OLD."status" IN ('completed','blocked') THEN
      RAISE EXCEPTION 'terminal re-extraction operations are immutable';
    END IF;
    abandoning := OLD."closure_jsonb" IS NULL AND NEW."closure_jsonb" IS NOT NULL AND NEW."status"='blocked' AND
      (OLD."status"='failed' OR (OLD."status"='running' AND OLD."leased_until"<=clock_timestamp()));
    IF NEW."closure_jsonb" IS DISTINCT FROM OLD."closure_jsonb" AND NOT abandoning THEN
      RAISE EXCEPTION 'only expired or failed operations may acquire an abandonment audit';
    END IF;
    IF abandoning AND (NEW."verification_correlations_jsonb" IS DISTINCT FROM OLD."verification_correlations_jsonb" OR
        NEW."attempts"<>OLD."attempts" OR NEW."terminal_jsonb" IS DISTINCT FROM OLD."terminal_jsonb") THEN
      RAISE EXCEPTION 'abandonment cannot change verification history or results';
    END IF;
    IF OLD."status"='failed' AND NEW."status"<>'running' AND NOT abandoning THEN
      RAISE EXCEPTION 'failed re-extraction operation must be reclaimed before progress';
    END IF;
    IF NEW."status"='running' AND NEW."lease_token" IS DISTINCT FROM OLD."lease_token" THEN
      IF OLD."status"='running' AND OLD."leased_until">clock_timestamp() THEN
        RAISE EXCEPTION 'cannot replace a live re-extraction lease';
      END IF;
      IF NEW."attempts"<>OLD."attempts"+1 THEN
        RAISE EXCEPTION 're-extraction reclaim must increment attempts';
      END IF;
    ELSE
      IF NEW."attempts"<>OLD."attempts" THEN
        RAISE EXCEPTION 're-extraction attempt count only changes on reclaim';
      END IF;
      IF OLD."status"='running' AND OLD."leased_until"<=clock_timestamp() AND NOT abandoning THEN
        RAISE EXCEPTION 'expired re-extraction lease cannot make progress';
      END IF;
    END IF;
    old_count := jsonb_array_length(OLD."verification_correlations_jsonb");
    new_count := jsonb_array_length(NEW."verification_correlations_jsonb");
    IF new_count<old_count OR new_count>old_count+1 THEN
      RAISE EXCEPTION 'verification correlations must append exactly one record at a time';
    END IF;
    FOR i IN 0..old_count-1 LOOP
      IF NEW."verification_correlations_jsonb"->i IS DISTINCT FROM OLD."verification_correlations_jsonb"->i THEN
        RAISE EXCEPTION 'verification correlations are append-only';
      END IF;
    END LOOP;
  ELSE
    IF NEW."status"<>'running' OR NEW."attempts"<>1 OR NEW."verification_correlations_jsonb"<>'[]'::jsonb OR NEW."closure_jsonb" IS NOT NULL THEN
      RAISE EXCEPTION 'new re-extraction operation must start running without results';
    END IF;
  END IF;
  -- Abandonment closes only the operation; changed target metadata must not
  -- strand an expired lease or authorize any further verification work.
  IF NOT abandoning THEN
    SELECT * INTO candidate_rec FROM "budget_extraction_candidate_v1" WHERE "id"=NEW."old_candidate_id";
    SELECT * INTO run_rec FROM "budget_verification_run_v1" WHERE "id"=NEW."old_verification_run_id";
    IF NOT FOUND OR run_rec."candidate_id"<>NEW."old_candidate_id" OR candidate_rec."cycle_id"<>NEW."cycle_id"::text OR
       candidate_rec."source_document_id"<>NEW."source_document_id" OR candidate_rec."source_sha256"<>NEW."source_sha256" OR
       candidate_rec."extraction_artifact_sha256"<>NEW."request_jsonb"->>'expectedOldExtractionArtifactSha256' THEN
      RAISE EXCEPTION 're-extraction old candidate/run identity mismatch';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW."verification_correlations_jsonb" IS DISTINCT FROM OLD."verification_correlations_jsonb" THEN
    checkpoint := NEW."verification_correlations_jsonb"->-1;
    IF jsonb_typeof(checkpoint)<>'object' OR NOT (checkpoint ?& ARRAY['candidateId','verificationRunId','manifestContentSha256',
        'manifestDocumentKey','extractionArtifactId','extractionArtifactSha256','verifierVersion','policyVersion','policySha256']) THEN
      RAISE EXCEPTION 're-extraction verification correlation is incomplete';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(OLD."verification_correlations_jsonb") x
      WHERE x->>'verificationRunId'=checkpoint->>'verificationRunId') THEN
      RAISE EXCEPTION 're-extraction verification run is already correlated';
    END IF;
    SELECT * INTO candidate_rec FROM "budget_extraction_candidate_v1" WHERE "id"=(checkpoint->>'candidateId')::uuid;
    SELECT * INTO run_rec FROM "budget_verification_run_v1" WHERE "id"=(checkpoint->>'verificationRunId')::uuid;
    IF NOT FOUND OR (candidate_rec."id" IS NULL) OR NOT (
      run_rec."candidate_id"=candidate_rec."id" AND candidate_rec."cycle_id"=NEW."cycle_id"::text AND
      candidate_rec."source_document_id"=NEW."source_document_id" AND candidate_rec."source_sha256"=NEW."source_sha256" AND
      candidate_rec."manifest_content_sha256"=checkpoint->>'manifestContentSha256' AND
      candidate_rec."manifest_document_key"=checkpoint->>'manifestDocumentKey' AND
      candidate_rec."extraction_artifact_id"=checkpoint->>'extractionArtifactId' AND
      candidate_rec."extraction_artifact_sha256"=checkpoint->>'extractionArtifactSha256' AND
      candidate_rec."verifier_version"=checkpoint->>'verifierVersion' AND candidate_rec."policy_version"=checkpoint->>'policyVersion' AND
      candidate_rec."policy_sha256"=checkpoint->>'policySha256' AND run_rec."source_sha256"=NEW."source_sha256" AND
      run_rec."manifest_content_sha256"=candidate_rec."manifest_content_sha256" AND
      run_rec."verifier_version"=candidate_rec."verifier_version" AND run_rec."policy_version"=candidate_rec."policy_version" AND
      run_rec."policy_sha256"=candidate_rec."policy_sha256" AND
      run_rec."extraction_artifact_sha256"=candidate_rec."extraction_artifact_sha256") IS TRUE THEN
      RAISE EXCEPTION 're-extraction verification correlation does not match persisted evidence';
    END IF;
  END IF;
  IF NEW."status"='completed' THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."verification_correlations_jsonb") x
       WHERE x->>'candidateId'=NEW."candidate_id"::text AND x->>'verificationRunId'=NEW."verification_run_id"::text) OR
       NOT (NEW."terminal_jsonb"->>'candidateId'=NEW."candidate_id"::text AND
            NEW."terminal_jsonb"->>'verificationRunId'=NEW."verification_run_id"::text) IS TRUE THEN
      RAISE EXCEPTION 're-extraction terminal result requires its exact checkpointed candidate/run';
    END IF;
    SELECT * INTO candidate_rec FROM "budget_extraction_candidate_v1" WHERE "id"=NEW."candidate_id";
    SELECT * INTO run_rec FROM "budget_verification_run_v1" WHERE "id"=NEW."verification_run_id";
    IF NOT FOUND OR NOT (
      candidate_rec."id"=run_rec."candidate_id" AND candidate_rec."cycle_id"=NEW."cycle_id"::text AND
      candidate_rec."source_document_id"=NEW."source_document_id" AND candidate_rec."source_sha256"=NEW."source_sha256" AND
      candidate_rec."extraction_artifact_id"=NEW."terminal_jsonb"->>'artifactId' AND
      candidate_rec."extraction_artifact_sha256"=NEW."terminal_jsonb"->>'artifactContentSha256' AND
      run_rec."decision"=NEW."terminal_jsonb"->>'verifierDecision' AND
      NEW."terminal_jsonb"->>'artifactByteSha256' ~ '^[0-9a-f]{64}$' AND
      length(btrim(NEW."terminal_jsonb"->>'artifactLocator'))>0 AND
      ((run_rec."decision"='PASS' AND NEW."terminal_jsonb"->>'finalState'='TERMINAL_PASSED') OR
       (run_rec."decision"='REVIEW' AND NEW."terminal_jsonb"->>'finalState'='TERMINAL_REVIEW') OR
       (run_rec."decision"='REJECT' AND NEW."terminal_jsonb"->>'finalState' IN ('TERMINAL_REJECTED','TERMINAL_REVIEW')))) IS TRUE THEN
      RAISE EXCEPTION 're-extraction terminal artifact or verifier decision differs from persisted evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "budget_reextraction_operation_v1_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "budget_reextraction_operation_v1"
  FOR EACH ROW EXECUTE FUNCTION guard_budget_reextraction_operation_v1();
