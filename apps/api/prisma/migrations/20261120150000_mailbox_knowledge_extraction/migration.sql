-- Capiro Knowledge Plane — Phase 6 live mailbox knowledge extraction.
--
-- Phase 4 remains the source-health / normalization / relevance boundary and
-- terminates at KnowledgeEvent. This migration adds a second durable outbox
-- that is populated only after a Phase 4 job successfully produced an active
-- KnowledgeEvent. Model extraction therefore never runs inside provider sync or
-- before immutable source provenance exists.
--
-- IMPORTANT rollout property: this migration intentionally does NOT backfill
-- historical successful Phase 4 jobs. Phase 6 proves the live path first;
-- historical mailbox backfill remains the later controlled Phase 30 operation.

CREATE TABLE "knowledge_mailbox_extraction_jobs" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "mailbox_job_id" UUID NOT NULL,
  "mail_message_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "source_revision" VARCHAR(64) NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "sensitivity" VARCHAR(32) NOT NULL,
  "access_scope" JSONB NOT NULL,

  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(6),
  "locked_by" VARCHAR(160),
  "last_error" TEXT,

  -- Result is a bounded, tenant-private extraction manifest. It stores claim
  -- candidates/resolution outcomes and exact evidence offsets/hashes, not a
  -- second authoritative evidence ledger and not a copy of the mailbox body.
  "result" JSONB,
  "assertion_count" INTEGER NOT NULL DEFAULT 0,
  "held_count" INTEGER NOT NULL DEFAULT 0,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_mailbox_extraction_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_mailbox_extraction_jobs_mailbox_job_fkey"
    FOREIGN KEY ("mailbox_job_id") REFERENCES "knowledge_mailbox_jobs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_mailbox_extraction_jobs_message_fkey"
    FOREIGN KEY ("mail_message_id") REFERENCES "mail_messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_mailbox_extraction_jobs_event_fkey"
    FOREIGN KEY ("event_id") REFERENCES "knowledge_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_mailbox_extraction_jobs_event_unique"
    UNIQUE ("tenant_id", "event_id"),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_mailbox_job_unique"
    UNIQUE ("tenant_id", "mailbox_job_id"),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_revision_check"
    CHECK ("source_revision" ~ '^[0-9a-f]{32,64}$'),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_hash_check"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_sensitivity_check"
    CHECK ("sensitivity" ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_scope_check"
    CHECK (jsonb_typeof("access_scope") = 'object'),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_status_check"
    CHECK ("status" IN (
      'pending',
      'processing',
      'succeeded',
      'skipped',
      'failed',
      'dead_letter'
    )),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "attempt_count" <= 100),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_counts_check"
    CHECK ("assertion_count" >= 0 AND "held_count" >= 0),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_result_check"
    CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object'),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_lock_state_check"
    CHECK (
      ("status" = 'processing' AND "locked_at" IS NOT NULL AND "locked_by" IS NOT NULL)
      OR
      ("status" <> 'processing' AND "locked_at" IS NULL AND "locked_by" IS NULL)
    ),
  CONSTRAINT "knowledge_mailbox_extraction_jobs_result_state_check"
    CHECK (
      ("status" = 'succeeded' AND "result" IS NOT NULL)
      OR
      ("status" <> 'succeeded')
    )
);

CREATE INDEX "knowledge_mailbox_extraction_jobs_due_idx"
  ON "knowledge_mailbox_extraction_jobs" ("status", "available_at", "created_at", "id")
  WHERE "status" IN ('pending', 'failed', 'processing');
CREATE INDEX "knowledge_mailbox_extraction_jobs_tenant_message_idx"
  ON "knowledge_mailbox_extraction_jobs" ("tenant_id", "mail_message_id", "created_at" DESC);
CREATE INDEX "knowledge_mailbox_extraction_jobs_tenant_event_idx"
  ON "knowledge_mailbox_extraction_jobs" ("tenant_id", "event_id");

CREATE OR REPLACE FUNCTION enforce_knowledge_mailbox_extraction_job_links()
RETURNS trigger AS $$
DECLARE
  v_job_tenant UUID;
  v_job_message UUID;
  v_job_event UUID;
  v_job_revision TEXT;
  v_job_hash TEXT;
  v_job_status TEXT;
  v_event_tenant UUID;
  v_event_status TEXT;
  v_event_hash TEXT;
  v_event_sensitivity TEXT;
  v_event_access_scope JSONB;
BEGIN
  SELECT
    tenant_id,
    mail_message_id,
    result_event_id,
    source_revision,
    processed_content_hash,
    status
  INTO
    v_job_tenant,
    v_job_message,
    v_job_event,
    v_job_revision,
    v_job_hash,
    v_job_status
  FROM knowledge_mailbox_jobs
  WHERE id = NEW.mailbox_job_id;

  IF v_job_tenant IS NULL
     OR v_job_tenant <> NEW.tenant_id
     OR v_job_message IS DISTINCT FROM NEW.mail_message_id
     OR v_job_event IS DISTINCT FROM NEW.event_id
     OR v_job_revision IS DISTINCT FROM NEW.source_revision
     OR v_job_hash IS DISTINCT FROM NEW.content_hash
     OR v_job_status <> 'succeeded' THEN
    RAISE EXCEPTION 'Mailbox extraction job must bind exactly to one succeeded Phase 4 mailbox job in the same tenant'
      USING ERRCODE = '23514';
  END IF;

  SELECT tenant_id, status, source_content_hash, sensitivity, access_scope
  INTO v_event_tenant, v_event_status, v_event_hash, v_event_sensitivity, v_event_access_scope
  FROM knowledge_events
  WHERE id = NEW.event_id;

  IF v_event_tenant IS NULL OR v_event_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'Mailbox extraction KnowledgeEvent must exist in the same tenant'
      USING ERRCODE = '23503';
  END IF;
  IF v_event_status <> 'active' THEN
    RAISE EXCEPTION 'Mailbox extraction requires an active KnowledgeEvent'
      USING ERRCODE = '23514';
  END IF;
  IF v_event_hash IS DISTINCT FROM NEW.content_hash THEN
    RAISE EXCEPTION 'Mailbox extraction content hash must match the KnowledgeEvent'
      USING ERRCODE = '23514';
  END IF;
  IF v_event_sensitivity IS DISTINCT FROM NEW.sensitivity
     OR v_event_access_scope IS DISTINCT FROM NEW.access_scope THEN
    RAISE EXCEPTION 'Mailbox extraction scope must exactly inherit from the KnowledgeEvent'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_mailbox_extraction_jobs_enforce_links"
  BEFORE INSERT OR UPDATE OF
    "tenant_id",
    "mailbox_job_id",
    "mail_message_id",
    "event_id",
    "source_revision",
    "content_hash",
    "sensitivity",
    "access_scope"
  ON "knowledge_mailbox_extraction_jobs"
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_mailbox_extraction_job_links();

CREATE OR REPLACE FUNCTION enqueue_mailbox_knowledge_extraction_job()
RETURNS trigger AS $$
DECLARE
  v_sensitivity TEXT;
  v_access_scope JSONB;
BEGIN
  IF NEW.status <> 'succeeded'
     OR NEW.result_event_id IS NULL
     OR NEW.processed_content_hash IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT sensitivity, access_scope
  INTO v_sensitivity, v_access_scope
  FROM knowledge_events
  WHERE tenant_id = NEW.tenant_id
    AND id = NEW.result_event_id
    AND status = 'active';

  IF v_sensitivity IS NULL OR v_access_scope IS NULL THEN
    RAISE EXCEPTION 'Succeeded mailbox job cannot enqueue extraction without its active KnowledgeEvent'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO knowledge_mailbox_extraction_jobs (
    tenant_id,
    mailbox_job_id,
    mail_message_id,
    event_id,
    source_revision,
    content_hash,
    sensitivity,
    access_scope,
    status,
    available_at
  )
  VALUES (
    NEW.tenant_id,
    NEW.id,
    NEW.mail_message_id,
    NEW.result_event_id,
    NEW.source_revision,
    NEW.processed_content_hash,
    v_sensitivity,
    v_access_scope,
    'pending',
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (tenant_id, event_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;

CREATE TRIGGER "knowledge_mailbox_jobs_enqueue_extraction"
  AFTER UPDATE OF "status", "result_event_id", "processed_content_hash"
  ON "knowledge_mailbox_jobs"
  FOR EACH ROW
  WHEN (
    NEW.status = 'succeeded'
    AND NEW.result_event_id IS NOT NULL
    AND NEW.processed_content_hash IS NOT NULL
  )
  EXECUTE FUNCTION enqueue_mailbox_knowledge_extraction_job();

ALTER TABLE "knowledge_mailbox_extraction_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_mailbox_extraction_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_mailbox_extraction_jobs_tenant_isolation"
  ON "knowledge_mailbox_extraction_jobs"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

-- Operational queue state is mutable; application code cannot destructively
-- delete the extraction/audit trail. Legal deletion tooling uses the existing
-- explicit system bypass and source-lineage purge path.
REVOKE DELETE, TRUNCATE ON TABLE "knowledge_mailbox_extraction_jobs" FROM capiro_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "knowledge_mailbox_extraction_jobs" TO capiro_app;

COMMENT ON TABLE "knowledge_mailbox_extraction_jobs" IS
  'Phase 6 durable post-KnowledgeEvent mailbox extraction outbox; live-only, tenant-scoped, canonical-resolution-first.';
COMMENT ON COLUMN "knowledge_mailbox_extraction_jobs"."result" IS
  'Bounded extraction/resolution manifest. Evidence is represented by source hash + exact offsets; mailbox body is not duplicated here.';
COMMENT ON TRIGGER "knowledge_mailbox_jobs_enqueue_extraction" ON "knowledge_mailbox_jobs" IS
  'Queues Phase 6 only after Phase 4 successfully commits an immutable KnowledgeEvent. No historical backfill is performed by this migration.';
