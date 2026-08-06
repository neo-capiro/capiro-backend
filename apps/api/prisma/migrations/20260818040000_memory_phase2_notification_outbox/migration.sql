-- Phase 2 increment 4A: durable, body-free memory-review notification obligations.
-- Delivery is intentionally out-of-transaction. Workflow transitions enqueue one
-- tenant-scoped obligation atomically; a later dispatcher must re-authorize the
-- recipient before in-app or email delivery.

CREATE TABLE IF NOT EXISTS memory_review_notification_outbox (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  review_request_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  client_id uuid,
  recipient_user_id uuid NOT NULL,
  event_type varchar(48) NOT NULL,
  idempotency_key varchar(240) NOT NULL,
  payload_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  authorization_required boolean NOT NULL DEFAULT true,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_review_notification_outbox_event_check
    CHECK (event_type IN (
      'review_assigned',
      'review_revision_assigned',
      'review_reassigned',
      'review_changes_requested',
      'review_approved',
      'review_rejected'
    )),
  CONSTRAINT memory_review_notification_outbox_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT memory_review_notification_outbox_payload_shape_check
    CHECK (
      jsonb_typeof(payload_jsonb) = 'object'
      AND pg_column_size(payload_jsonb) <= 4096
      AND NOT (payload_jsonb ?| ARRAY[
        'value',
        'sections',
        'body',
        'reason',
        'feedbackReason',
        'sourceExcerpt',
        'source_excerpt'
      ])
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_review_notification_outbox_idempotency_unique
  ON memory_review_notification_outbox (tenant_id, idempotency_key);

CREATE INDEX IF NOT EXISTS memory_review_notification_outbox_delivery_idx
  ON memory_review_notification_outbox (
    delivered_at,
    available_at,
    attempts,
    created_at
  );

CREATE INDEX IF NOT EXISTS memory_review_notification_outbox_recipient_idx
  ON memory_review_notification_outbox (
    tenant_id,
    recipient_user_id,
    delivered_at,
    created_at DESC
  );

ALTER TABLE memory_review_notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_review_notification_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_review_notification_outbox_tenant_isolation
  ON memory_review_notification_outbox;
CREATE POLICY memory_review_notification_outbox_tenant_isolation
  ON memory_review_notification_outbox
  USING (
    tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    OR current_setting('app.bypass_rls', true) = 'on'
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    OR current_setting('app.bypass_rls', true) = 'on'
  );

CREATE OR REPLACE FUNCTION enqueue_memory_review_notification(
  p_tenant_id uuid,
  p_review_request_id uuid,
  p_candidate_id uuid,
  p_client_id uuid,
  p_recipient_user_id uuid,
  p_event_type text,
  p_title text,
  p_candidate_kind text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  clean_title text;
  semantic_key text;
BEGIN
  IF p_recipient_user_id IS NULL THEN
    RETURN;
  END IF;

  clean_title := left(
    COALESCE(
      NULLIF(
        regexp_replace(
          btrim(p_title),
          '[[:space:][:cntrl:]]+',
          ' ',
          'g'
        ),
        ''
      ),
      'Memory proposal'
    ),
    300
  );

  semantic_key := concat_ws(
    ':',
    p_review_request_id::text,
    p_event_type,
    p_recipient_user_id::text
  );

  INSERT INTO memory_review_notification_outbox (
    tenant_id,
    review_request_id,
    candidate_id,
    client_id,
    recipient_user_id,
    event_type,
    idempotency_key,
    payload_jsonb
  ) VALUES (
    p_tenant_id,
    p_review_request_id,
    p_candidate_id,
    p_client_id,
    p_recipient_user_id,
    p_event_type,
    semantic_key,
    jsonb_build_object(
      'workflow', 'memory_review_v2',
      'schemaVersion', 1,
      'reviewRequestId', p_review_request_id,
      'candidateId', p_candidate_id,
      'clientId', p_client_id,
      'eventType', p_event_type,
      'candidateKind', COALESCE(NULLIF(p_candidate_kind, ''), 'standard'),
      'title', clean_title,
      'requiresCurrentAuthorization', true
    )
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_memory_review_notifications_from_workflow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  candidate_uuid uuid;
  candidate_kind text;
  assignment_event text;
  has_predecessor boolean;
BEGIN
  IF NEW.surface <> 'memory'
     OR NEW.subject_type <> 'memory_candidate'
     OR NEW.subject_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    candidate_uuid := NEW.subject_id::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_NOTIFICATION_CANDIDATE_ID_INVALID'
        USING ERRCODE = '22023';
  END;

  candidate_kind := COALESCE(
    NULLIF(NEW.payload_jsonb ->> 'candidateKind', ''),
    'standard'
  );

  IF TG_OP = 'INSERT'
     AND NEW.status = 'pending'
     AND NEW.assigned_to IS NOT NULL THEN
    SELECT predecessor_candidate_id IS NOT NULL
      INTO has_predecessor
    FROM memory_candidate
    WHERE tenant_id = NEW.tenant_id
      AND id = candidate_uuid;

    assignment_event := CASE
      WHEN COALESCE(has_predecessor, false)
        THEN 'review_revision_assigned'
      ELSE 'review_assigned'
    END;

    PERFORM enqueue_memory_review_notification(
      NEW.tenant_id,
      NEW.id,
      candidate_uuid,
      NEW.client_id,
      NEW.assigned_to,
      assignment_event,
      NEW.title,
      candidate_kind
    );
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.status = 'pending'
     AND NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
     AND NEW.assigned_to IS NOT NULL THEN
    PERFORM enqueue_memory_review_notification(
      NEW.tenant_id,
      NEW.id,
      candidate_uuid,
      NEW.client_id,
      NEW.assigned_to,
      'review_reassigned',
      NEW.title,
      candidate_kind
    );
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.requested_by IS NOT NULL THEN
    IF NEW.status = 'changes_needed' THEN
      PERFORM enqueue_memory_review_notification(
        NEW.tenant_id,
        NEW.id,
        candidate_uuid,
        NEW.client_id,
        NEW.requested_by,
        'review_changes_requested',
        NEW.title,
        candidate_kind
      );
    ELSIF NEW.status = 'approved' THEN
      PERFORM enqueue_memory_review_notification(
        NEW.tenant_id,
        NEW.id,
        candidate_uuid,
        NEW.client_id,
        NEW.requested_by,
        'review_approved',
        NEW.title,
        candidate_kind
      );
    ELSIF NEW.status = 'rejected' THEN
      PERFORM enqueue_memory_review_notification(
        NEW.tenant_id,
        NEW.id,
        candidate_uuid,
        NEW.client_id,
        NEW.requested_by,
        'review_rejected',
        NEW.title,
        candidate_kind
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS review_request_enqueue_memory_notifications
  ON review_request;
CREATE TRIGGER review_request_enqueue_memory_notifications
AFTER INSERT OR UPDATE OF assigned_to, status
ON review_request
FOR EACH ROW
EXECUTE FUNCTION enqueue_memory_review_notifications_from_workflow();

-- Backfill only current pending assignments. Terminal events are intentionally
-- not synthesized because doing so would send stale historical notifications.
INSERT INTO memory_review_notification_outbox (
  tenant_id,
  review_request_id,
  candidate_id,
  client_id,
  recipient_user_id,
  event_type,
  idempotency_key,
  payload_jsonb
)
SELECT
  rr.tenant_id,
  rr.id,
  rr.subject_id::uuid,
  rr.client_id,
  rr.assigned_to,
  CASE
    WHEN mc.predecessor_candidate_id IS NOT NULL
      THEN 'review_revision_assigned'
    ELSE 'review_assigned'
  END,
  concat_ws(
    ':',
    rr.id::text,
    CASE
      WHEN mc.predecessor_candidate_id IS NOT NULL
        THEN 'review_revision_assigned'
      ELSE 'review_assigned'
    END,
    rr.assigned_to::text
  ),
  jsonb_build_object(
    'workflow', 'memory_review_v2',
    'schemaVersion', 1,
    'reviewRequestId', rr.id,
    'candidateId', rr.subject_id::uuid,
    'clientId', rr.client_id,
    'eventType', CASE
      WHEN mc.predecessor_candidate_id IS NOT NULL
        THEN 'review_revision_assigned'
      ELSE 'review_assigned'
    END,
    'candidateKind', COALESCE(
      NULLIF(rr.payload_jsonb ->> 'candidateKind', ''),
      'standard'
    ),
    'title', left(
      COALESCE(NULLIF(btrim(rr.title), ''), 'Memory proposal'),
      300
    ),
    'requiresCurrentAuthorization', true
  )
FROM review_request rr
JOIN memory_candidate mc
  ON mc.tenant_id = rr.tenant_id
 AND mc.id = rr.subject_id::uuid
WHERE rr.surface = 'memory'
  AND rr.subject_type = 'memory_candidate'
  AND rr.status = 'pending'
  AND rr.assigned_to IS NOT NULL
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
