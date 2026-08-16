-- Enterprise Context Plane — Phase 4 mailbox intelligence.
--
-- Provider sync remains a pure ingestion boundary. A trigger on mail_messages
-- appends a durable, idempotent outbox job in the same transaction as each
-- newly synced or materially changed message. A separate worker claims jobs
-- with FOR UPDATE SKIP LOCKED, normalizes the authoritative message body,
-- applies deterministic relevance gating, and creates an immutable
-- KnowledgeEvent. Entity resolution and model extraction intentionally remain
-- Phase 5/6 concerns.

CREATE TABLE "knowledge_mailbox_jobs" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "mail_message_id" UUID NOT NULL,
  "source_revision" VARCHAR(64) NOT NULL,

  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(6),
  "locked_by" VARCHAR(160),
  "last_error" TEXT,

  "relevance" JSONB,
  "result_event_id" UUID,
  "processed_content_hash" VARCHAR(64),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "knowledge_mailbox_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "knowledge_mailbox_jobs_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_mailbox_jobs_message_fkey"
    FOREIGN KEY ("mail_message_id") REFERENCES "mail_messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_mailbox_jobs_event_fkey"
    FOREIGN KEY ("result_event_id") REFERENCES "knowledge_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "knowledge_mailbox_jobs_identity_unique"
    UNIQUE ("tenant_id", "mail_message_id", "source_revision"),
  CONSTRAINT "knowledge_mailbox_jobs_revision_check"
    CHECK ("source_revision" ~ '^[0-9a-f]{32,64}$'),
  CONSTRAINT "knowledge_mailbox_jobs_status_check"
    CHECK ("status" IN (
      'pending',
      'processing',
      'succeeded',
      'skipped',
      'failed',
      'dead_letter'
    )),
  CONSTRAINT "knowledge_mailbox_jobs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "attempt_count" <= 100),
  CONSTRAINT "knowledge_mailbox_jobs_relevance_object_check"
    CHECK ("relevance" IS NULL OR jsonb_typeof("relevance") = 'object'),
  CONSTRAINT "knowledge_mailbox_jobs_processed_hash_check"
    CHECK (
      "processed_content_hash" IS NULL
      OR "processed_content_hash" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "knowledge_mailbox_jobs_lock_state_check"
    CHECK (
      ("status" = 'processing' AND "locked_at" IS NOT NULL AND "locked_by" IS NOT NULL)
      OR
      ("status" <> 'processing' AND "locked_at" IS NULL AND "locked_by" IS NULL)
    ),
  CONSTRAINT "knowledge_mailbox_jobs_result_state_check"
    CHECK (
      ("status" = 'succeeded' AND "result_event_id" IS NOT NULL AND "processed_content_hash" IS NOT NULL)
      OR
      ("status" <> 'succeeded' AND "result_event_id" IS NULL)
    )
);

CREATE INDEX "knowledge_mailbox_jobs_due_idx"
  ON "knowledge_mailbox_jobs" ("status", "available_at", "created_at", "id")
  WHERE "status" IN ('pending', 'failed', 'processing');
CREATE INDEX "knowledge_mailbox_jobs_tenant_message_idx"
  ON "knowledge_mailbox_jobs" ("tenant_id", "mail_message_id", "created_at" DESC);
CREATE INDEX "knowledge_mailbox_jobs_result_event_idx"
  ON "knowledge_mailbox_jobs" ("tenant_id", "result_event_id")
  WHERE "result_event_id" IS NOT NULL;

-- The outbox trigger always inserts a message's own tenant, and repositories
-- repeat tenant predicates. This trigger makes the same-tenant invariant hold
-- even for direct SQL and future maintenance code.
CREATE OR REPLACE FUNCTION enforce_knowledge_mailbox_job_links()
RETURNS trigger AS $$
DECLARE
  v_message_tenant UUID;
  v_event_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_message_tenant
  FROM mail_messages
  WHERE id = NEW.mail_message_id;

  IF v_message_tenant IS NULL OR v_message_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'KnowledgeMailboxJob message must exist in the same tenant'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.result_event_id IS NOT NULL THEN
    SELECT tenant_id INTO v_event_tenant
    FROM knowledge_events
    WHERE id = NEW.result_event_id;

    IF v_event_tenant IS NULL OR v_event_tenant <> NEW.tenant_id THEN
      RAISE EXCEPTION 'KnowledgeMailboxJob result event must exist in the same tenant'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_mailbox_jobs_enforce_links"
  BEFORE INSERT OR UPDATE OF "tenant_id", "mail_message_id", "result_event_id"
  ON "knowledge_mailbox_jobs"
  FOR EACH ROW EXECUTE FUNCTION enforce_knowledge_mailbox_job_links();

ALTER TABLE "knowledge_mailbox_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_mailbox_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "knowledge_mailbox_jobs_tenant_isolation" ON "knowledge_mailbox_jobs"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

-- Operational queue rows are mutable by the worker, but they are never
-- destructively deleted by the application. Retention cleanup is a separate,
-- audited system operation.
REVOKE DELETE, TRUNCATE ON TABLE "knowledge_mailbox_jobs" FROM capiro_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "knowledge_mailbox_jobs" TO capiro_app;

-- One canonical operational revision function is shared by the trigger and
-- worker read path. Epoch timestamps avoid TimeZone/DateStyle-dependent hashes.
-- This prevents an old queued job from being processed against a newer provider
-- message body after another sync update commits.
CREATE OR REPLACE FUNCTION mailbox_knowledge_source_revision(
  p_source TEXT,
  p_external_id TEXT,
  p_subject TEXT,
  p_from_email TEXT,
  p_to_recipients JSONB,
  p_cc_recipients JSONB,
  p_bcc_recipients JSONB,
  p_sent_at TIMESTAMPTZ,
  p_received_at TIMESTAMPTZ,
  p_body_text TEXT,
  p_has_attachments BOOLEAN
)
RETURNS TEXT AS $$
  SELECT md5(concat_ws(
    chr(31),
    COALESCE(p_source, ''),
    COALESCE(p_external_id, ''),
    COALESCE(p_subject, ''),
    COALESCE(p_from_email, ''),
    COALESCE(p_to_recipients::text, '[]'),
    COALESCE(p_cc_recipients::text, '[]'),
    COALESCE(p_bcc_recipients::text, '[]'),
    COALESCE(extract(epoch FROM p_sent_at)::text, ''),
    COALESCE(extract(epoch FROM p_received_at)::text, ''),
    COALESCE(p_body_text, ''),
    COALESCE(p_has_attachments, FALSE)::text
  ))
$$ LANGUAGE sql
IMMUTABLE
PARALLEL SAFE;

CREATE OR REPLACE FUNCTION enqueue_mailbox_knowledge_job()
RETURNS trigger AS $$
DECLARE
  v_revision TEXT;
BEGIN
  -- Phase 4 processes provider-synced Google and Outlook mail. Manual/IMAP
  -- sources can join once their body/provenance contracts are equivalent.
  IF NEW.source::text NOT IN ('google', 'outlook') THEN
    RETURN NEW;
  END IF;

  -- Removed messages and empty provider snippets/bodies cannot produce factual
  -- evidence. Deletion lineage is handled by the later privacy lifecycle phase.
  IF NEW.removed_at IS NOT NULL
     OR length(btrim(COALESCE(NEW.body_text, ''))) = 0 THEN
    RETURN NEW;
  END IF;

  -- Provider upserts often execute an UPDATE even when no mailbox fact changed.
  -- Do not manufacture another job merely because updated_at advanced.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.subject IS NOT DISTINCT FROM NEW.subject
       AND OLD.from_email IS NOT DISTINCT FROM NEW.from_email
       AND OLD.to_recipients_jsonb IS NOT DISTINCT FROM NEW.to_recipients_jsonb
       AND OLD.cc_recipients_jsonb IS NOT DISTINCT FROM NEW.cc_recipients_jsonb
       AND OLD.bcc_recipients_jsonb IS NOT DISTINCT FROM NEW.bcc_recipients_jsonb
       AND OLD.sent_at IS NOT DISTINCT FROM NEW.sent_at
       AND OLD.received_at IS NOT DISTINCT FROM NEW.received_at
       AND OLD.body_text IS NOT DISTINCT FROM NEW.body_text
       AND OLD.has_attachments IS NOT DISTINCT FROM NEW.has_attachments
       AND OLD.removed_at IS NOT DISTINCT FROM NEW.removed_at THEN
      RETURN NEW;
    END IF;
  END IF;

  -- MD5 is used only as an outbox revision identity (not as evidence proof).
  -- The consumer computes SHA-256 over canonical authoritative text before it
  -- creates a KnowledgeEvent, and Phase 3 evidence must match that SHA-256.
  v_revision := mailbox_knowledge_source_revision(
    NEW.source::text,
    NEW.external_id,
    NEW.subject,
    NEW.from_email::text,
    NEW.to_recipients_jsonb,
    NEW.cc_recipients_jsonb,
    NEW.bcc_recipients_jsonb,
    NEW.sent_at,
    NEW.received_at,
    NEW.body_text,
    NEW.has_attachments
  );

  INSERT INTO "knowledge_mailbox_jobs" (
    "tenant_id",
    "mail_message_id",
    "source_revision",
    "status",
    "available_at"
  )
  VALUES (
    NEW.tenant_id,
    NEW.id,
    v_revision,
    'pending',
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("tenant_id", "mail_message_id", "source_revision") DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;

CREATE TRIGGER "mail_messages_enqueue_knowledge"
  AFTER INSERT OR UPDATE OF
    "subject",
    "from_email",
    "to_recipients_jsonb",
    "cc_recipients_jsonb",
    "bcc_recipients_jsonb",
    "sent_at",
    "received_at",
    "body_text",
    "has_attachments",
    "removed_at"
  ON "mail_messages"
  FOR EACH ROW EXECUTE FUNCTION enqueue_mailbox_knowledge_job();

COMMENT ON TABLE "knowledge_mailbox_jobs" IS
  'Durable tenant-scoped transactional outbox for asynchronous mailbox KnowledgeEvent ingestion.';
COMMENT ON COLUMN "knowledge_mailbox_jobs"."source_revision" IS
  'Idempotent provider-message revision identity; factual proof uses processed_content_hash SHA-256.';
COMMENT ON TRIGGER "mail_messages_enqueue_knowledge" ON "mail_messages" IS
  'Incrementally queues material provider-message changes without blocking provider sync on knowledge processing.';
