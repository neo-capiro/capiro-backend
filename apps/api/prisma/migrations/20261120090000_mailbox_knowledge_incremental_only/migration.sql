-- Knowledge Plane: only incremental mailbox sync may enqueue knowledge jobs.
--
-- Provider persistence stamps an explicit mailboxSyncMode on mail_messages.metadata
-- ('incremental' | 'backfill'). Backfill rows must never enter the knowledge
-- outbox. Do not use a date heuristic — the mode is authoritative.
--
-- Also refuse bodyCompleteness values other than the explicit 'full' marker
-- at the outbox boundary (defense in depth; the consumer already refuses).

CREATE OR REPLACE FUNCTION enqueue_mailbox_knowledge_job()
RETURNS trigger AS $$
DECLARE
  v_revision TEXT;
  v_sync_mode TEXT;
  v_body_completeness TEXT;
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

  -- Explicit sync mode only. Missing/unknown modes fail closed (no enqueue).
  v_sync_mode := lower(btrim(COALESCE(NEW.metadata_jsonb ->> 'mailboxSyncMode', '')));
  IF v_sync_mode IS DISTINCT FROM 'incremental' THEN
    RETURN NEW;
  END IF;

  -- Knowledge ingestion accepts only an explicit full body. Preview and
  -- truncated bodies stay in mail_messages for UI but never enter the outbox.
  v_body_completeness := lower(btrim(COALESCE(NEW.metadata_jsonb ->> 'bodyCompleteness', '')));
  IF v_body_completeness IS DISTINCT FROM 'full' THEN
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
       AND OLD.removed_at IS NOT DISTINCT FROM NEW.removed_at
       AND OLD.metadata_jsonb IS NOT DISTINCT FROM NEW.metadata_jsonb THEN
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

-- Rebind the trigger so metadata_jsonb changes (sync mode / body completeness)
-- are visible to the UPDATE OF list when providers restamp those markers.
DROP TRIGGER IF EXISTS "mail_messages_enqueue_knowledge" ON "mail_messages";
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
    "removed_at",
    "metadata_jsonb"
  ON "mail_messages"
  FOR EACH ROW EXECUTE FUNCTION enqueue_mailbox_knowledge_job();

COMMENT ON TRIGGER "mail_messages_enqueue_knowledge" ON "mail_messages" IS
  'Queues material incremental provider-message changes with explicit bodyCompleteness=full. Backfill rows (mailboxSyncMode=backfill) never enqueue.';
