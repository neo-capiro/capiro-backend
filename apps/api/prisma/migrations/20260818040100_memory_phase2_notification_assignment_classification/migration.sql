-- Correct first-assignment classification for workflow rows created unassigned.
-- A trigger-created review_request starts with assigned_to NULL. Its first named
-- reviewer receives review_assigned (or review_revision_assigned), while only a
-- later reviewer change receives review_reassigned.

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
    IF OLD.assigned_to IS NULL THEN
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
    ELSE
      assignment_event := 'review_reassigned';
    END IF;

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
