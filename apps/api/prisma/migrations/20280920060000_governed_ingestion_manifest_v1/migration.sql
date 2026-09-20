-- Package E: durable orchestration around the existing exact observation ->
-- archive -> parser -> verification path. These tables confer no approval,
-- readiness, correction, or canonical-promotion authority.
CREATE TABLE "defense_budget_ingestion_manifest_v1" (
  "id" UUID PRIMARY KEY,
  "schema_version" TEXT NOT NULL,
  "manifest_sha256" CHAR(64) NOT NULL UNIQUE,
  "manifest_jsonb" JSONB NOT NULL,
  "owner" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "release_revision" CHAR(40) NOT NULL,
  "runtime_image_digest" TEXT NOT NULL,
  "task_definition_arn" TEXT NOT NULL,
  "runtime_config_sha256" CHAR(64) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "stop_requested_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "deadline_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "defense_budget_ingestion_manifest_v1_status_chk"
    CHECK ("status" IN ('running','stop_requested','paused','completed')),
  CONSTRAINT "defense_budget_ingestion_manifest_v1_identity_chk" CHECK (
    "schema_version"='defense_budget_ingestion_manifest_v1' AND
    "environment"='capiro-dev' AND
    "manifest_sha256" ~ '^[0-9a-f]{64}$' AND
    "release_revision" ~ '^[0-9a-f]{40}$' AND
    "runtime_config_sha256" ~ '^[0-9a-f]{64}$' AND
    "runtime_image_digest" ~ '^sha256:[0-9a-f]{64}$' AND
    jsonb_typeof("manifest_jsonb")='object' AND
    "manifest_jsonb"->>'operationId'="id"::text AND
    "manifest_jsonb"->>'contentSha256'="manifest_sha256" AND
    length(btrim("owner"))>0 AND "deadline_at">"started_at"
  ),
  CONSTRAINT "defense_budget_ingestion_manifest_v1_terminal_chk" CHECK (
    ("status"='completed' AND "completed_at" IS NOT NULL) OR
    ("status"<>'completed' AND "completed_at" IS NULL)
  )
);

CREATE TABLE "defense_budget_ingestion_manifest_item_v1" (
  "id" UUID PRIMARY KEY,
  "manifest_id" UUID NOT NULL REFERENCES "defense_budget_ingestion_manifest_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "ordinal" INTEGER NOT NULL,
  "outbox_row_id" UUID NOT NULL REFERENCES "defense_budget_ingestion_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "observation_id" UUID NOT NULL REFERENCES "defense_budget_source_observation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "cycle_id" UUID NOT NULL REFERENCES "defense_budget_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "source_document_id" UUID NOT NULL REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "source_sha256" CHAR(64) NOT NULL,
  "source_byte_size" INTEGER NOT NULL,
  "expected_outbox_state" TEXT NOT NULL,
  "member_jsonb" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "lease_token" UUID,
  "lease_generation" INTEGER NOT NULL DEFAULT 0,
  "leased_until" TIMESTAMPTZ(6),
  "last_heartbeat_at" TIMESTAMPTZ(6),
  "task_job_id" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "execution_history_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "verification_correlations_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "reconciliations_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "terminal_jsonb" JSONB,
  "candidate_id" UUID REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "verification_run_id" UUID REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "parser_disposition" TEXT,
  "last_error_class" TEXT,
  "last_error_message" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "defense_budget_ingestion_manifest_item_v1_manifest_ordinal_key" UNIQUE ("manifest_id","ordinal"),
  CONSTRAINT "defense_budget_ingestion_manifest_item_v1_manifest_outbox_key" UNIQUE ("manifest_id","outbox_row_id"),
  CONSTRAINT "defense_budget_ingestion_manifest_item_v1_status_chk" CHECK (
    "status" IN ('pending','running','retry_wait','evidence_ready','completed','quarantined','uncertain')
  ),
  CONSTRAINT "defense_budget_ingestion_manifest_item_v1_identity_chk" CHECK (
    "ordinal">0 AND "source_sha256" ~ '^[0-9a-f]{64}$' AND "source_byte_size">0 AND
    "expected_outbox_state" IN ('pending','failed') AND jsonb_typeof("member_jsonb")='object' AND
    "member_jsonb"->>'memberId'="id"::text AND
    ("member_jsonb"->>'ordinal')::integer="ordinal" AND
    "member_jsonb"#>>'{lifecycle,outboxRowId}'="outbox_row_id"::text AND
    "member_jsonb"#>>'{lifecycle,observationId}'="observation_id"::text AND
    "member_jsonb"#>>'{lifecycle,cycleId}'="cycle_id"::text AND
    "member_jsonb"#>>'{lifecycle,sourceDocumentId}'="source_document_id"::text AND
    "member_jsonb"#>>'{lifecycle,expectedOutboxState}'="expected_outbox_state" AND
    "member_jsonb"#>>'{source,sha256}'="source_sha256" AND
    ("member_jsonb"#>>'{source,byteSize}')::integer="source_byte_size"
  ),
  CONSTRAINT "defense_budget_ingestion_manifest_item_v1_json_chk" CHECK (
    jsonb_typeof("execution_history_jsonb")='array' AND
    jsonb_typeof("verification_correlations_jsonb")='array' AND
    jsonb_typeof("reconciliations_jsonb")='array' AND
    ("terminal_jsonb" IS NULL OR jsonb_typeof("terminal_jsonb")='object')
  ),
  CONSTRAINT "defense_budget_ingestion_manifest_item_v1_lease_chk" CHECK (
    (("status" IN ('running','evidence_ready')) AND "lease_token" IS NOT NULL AND
      "leased_until" IS NOT NULL AND "last_heartbeat_at" IS NOT NULL AND length(btrim("task_job_id"))>0) OR
    (("status" NOT IN ('running','evidence_ready')) AND "lease_token" IS NULL AND
      "leased_until" IS NULL AND "last_heartbeat_at" IS NULL)
  ),
  CONSTRAINT "defense_budget_ingestion_manifest_item_v1_result_chk" CHECK (
    (("status" IN ('evidence_ready','completed')) AND "terminal_jsonb" IS NOT NULL AND
      "candidate_id" IS NOT NULL AND "verification_run_id" IS NOT NULL AND
      "parser_disposition" IN ('PASS','REVIEW','REJECT')) OR
    ("status"='quarantined' AND "terminal_jsonb" IS NOT NULL AND (
      ("candidate_id" IS NOT NULL AND "verification_run_id" IS NOT NULL AND "parser_disposition"='REJECT') OR
      ("candidate_id" IS NULL AND "verification_run_id" IS NULL AND "parser_disposition" IS NULL))) OR
    (("status" NOT IN ('evidence_ready','completed','quarantined')) AND "terminal_jsonb" IS NULL AND
      "candidate_id" IS NULL AND "verification_run_id" IS NULL AND "parser_disposition" IS NULL)
  )
);

CREATE UNIQUE INDEX "defense_budget_ingestion_manifest_item_v1_active_outbox_key"
  ON "defense_budget_ingestion_manifest_item_v1"("outbox_row_id")
  WHERE "status" IN ('pending','running','retry_wait','evidence_ready','uncertain');
CREATE UNIQUE INDEX "defense_budget_ingestion_manifest_item_v1_active_source_key"
  ON "defense_budget_ingestion_manifest_item_v1"("cycle_id","source_document_id")
  WHERE "status" IN ('pending','running','retry_wait','evidence_ready','uncertain');
CREATE INDEX "defense_budget_ingestion_manifest_item_v1_claim_idx"
  ON "defense_budget_ingestion_manifest_item_v1"("manifest_id","status","next_attempt_at","ordinal");

CREATE FUNCTION guard_defense_budget_ingestion_manifest_v1() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ingestion manifests cannot be deleted'; END IF;
  IF ROW(NEW."id",NEW."schema_version",NEW."manifest_sha256",NEW."manifest_jsonb",NEW."owner",NEW."environment",
         NEW."release_revision",NEW."runtime_image_digest",NEW."task_definition_arn",NEW."runtime_config_sha256",
         NEW."started_at",NEW."deadline_at",NEW."created_at") IS DISTINCT FROM
     ROW(OLD."id",OLD."schema_version",OLD."manifest_sha256",OLD."manifest_jsonb",OLD."owner",OLD."environment",
         OLD."release_revision",OLD."runtime_image_digest",OLD."task_definition_arn",OLD."runtime_config_sha256",
         OLD."started_at",OLD."deadline_at",OLD."created_at") THEN
    RAISE EXCEPTION 'ingestion manifest identity and limits are immutable';
  END IF;
  IF OLD."status"='completed' THEN RAISE EXCEPTION 'completed ingestion manifests are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "defense_budget_ingestion_manifest_v1_guard"
  BEFORE UPDATE OR DELETE ON "defense_budget_ingestion_manifest_v1"
  FOR EACH ROW EXECUTE FUNCTION guard_defense_budget_ingestion_manifest_v1();

CREATE FUNCTION guard_defense_budget_ingestion_manifest_item_v1() RETURNS TRIGGER AS $$
DECLARE old_count INTEGER; i INTEGER;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ingestion manifest items cannot be deleted'; END IF;
  IF ROW(NEW."id",NEW."manifest_id",NEW."ordinal",NEW."outbox_row_id",NEW."observation_id",NEW."cycle_id",
         NEW."source_document_id",NEW."source_sha256",NEW."source_byte_size",NEW."expected_outbox_state",
         NEW."member_jsonb",NEW."created_at") IS DISTINCT FROM
     ROW(OLD."id",OLD."manifest_id",OLD."ordinal",OLD."outbox_row_id",OLD."observation_id",OLD."cycle_id",
         OLD."source_document_id",OLD."source_sha256",OLD."source_byte_size",OLD."expected_outbox_state",
         OLD."member_jsonb",OLD."created_at") THEN
    RAISE EXCEPTION 'ingestion manifest item identity is immutable';
  END IF;
  IF OLD."status" IN ('completed','quarantined') THEN RAISE EXCEPTION 'terminal ingestion manifest items are immutable'; END IF;
  IF jsonb_array_length(NEW."execution_history_jsonb") < jsonb_array_length(OLD."execution_history_jsonb") OR
     jsonb_array_length(NEW."execution_history_jsonb") > jsonb_array_length(OLD."execution_history_jsonb")+1 OR
     jsonb_array_length(NEW."verification_correlations_jsonb") < jsonb_array_length(OLD."verification_correlations_jsonb") OR
     jsonb_array_length(NEW."verification_correlations_jsonb") > jsonb_array_length(OLD."verification_correlations_jsonb")+1 OR
     jsonb_array_length(NEW."reconciliations_jsonb") < jsonb_array_length(OLD."reconciliations_jsonb") OR
     jsonb_array_length(NEW."reconciliations_jsonb") > jsonb_array_length(OLD."reconciliations_jsonb")+1 THEN
    RAISE EXCEPTION 'ingestion manifest histories are append-only, one record at a time';
  END IF;
  old_count := jsonb_array_length(OLD."verification_correlations_jsonb");
  IF old_count > 0 THEN
    FOR i IN 0..old_count-1 LOOP
      IF NEW."verification_correlations_jsonb"->i IS DISTINCT FROM OLD."verification_correlations_jsonb"->i THEN
        RAISE EXCEPTION 'verification correlations are append-only';
      END IF;
    END LOOP;
  END IF;
  old_count := jsonb_array_length(OLD."execution_history_jsonb");
  IF old_count > 0 THEN
    FOR i IN 0..old_count-1 LOOP
      IF NEW."execution_history_jsonb"->i IS DISTINCT FROM OLD."execution_history_jsonb"->i THEN
        RAISE EXCEPTION 'execution history is append-only';
      END IF;
    END LOOP;
  END IF;
  old_count := jsonb_array_length(OLD."reconciliations_jsonb");
  IF old_count > 0 THEN
    FOR i IN 0..old_count-1 LOOP
      IF NEW."reconciliations_jsonb"->i IS DISTINCT FROM OLD."reconciliations_jsonb"->i THEN
        RAISE EXCEPTION 'reconciliation history is append-only';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "defense_budget_ingestion_manifest_item_v1_guard"
  BEFORE UPDATE OR DELETE ON "defense_budget_ingestion_manifest_item_v1"
  FOR EACH ROW EXECUTE FUNCTION guard_defense_budget_ingestion_manifest_item_v1();
