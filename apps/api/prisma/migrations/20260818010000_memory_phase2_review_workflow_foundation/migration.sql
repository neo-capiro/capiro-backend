-- Phase 2 increment 1: durable memory-review workflow foundation.
-- Reuses the already-modeled review_request table and adds only SQL features
-- Prisma cannot express: memory-specific partial indexes, checks, and triggers.
-- `changes_needed` is the bounded DB token for the public `changes_requested` state.

DO $$
BEGIN
  ALTER TABLE review_request
    ADD CONSTRAINT review_request_memory_phase2_shape_check
    CHECK (
      surface <> 'memory'
      OR (
        subject_type = 'memory_candidate'
        AND subject_id IS NOT NULL
        AND requested_by IS NOT NULL
        AND status IN (
          'pending',
          'changes_needed',
          'approved',
          'rejected',
          'withdrawn',
          'superseded'
        )
        AND (assigned_to IS NULL OR assigned_to <> requested_by)
        AND char_length(reason) BETWEEN 1 AND 500
        AND jsonb_typeof(payload_jsonb) = 'object'
        AND pg_column_size(payload_jsonb) <= 4096
      )
    ) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE review_request
  VALIDATE CONSTRAINT review_request_memory_phase2_shape_check;

CREATE UNIQUE INDEX IF NOT EXISTS review_request_memory_candidate_unique
  ON review_request (tenant_id, subject_id)
  WHERE surface = 'memory'
    AND subject_type = 'memory_candidate'
    AND subject_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS review_request_memory_assignment_idx
  ON review_request (tenant_id, assigned_to, status, created_at DESC)
  WHERE surface = 'memory';

-- Every existing shared pending candidate receives a body-free workflow row.
-- Assignment remains NULL until the application evaluates current role, grant,
-- expiry, archived-client, and ethical-wall policy. A NULL assignment blocks a
-- decision rather than guessing who may review it.
INSERT INTO review_request (
  tenant_id,
  risk_tier,
  surface,
  subject_type,
  subject_id,
  client_id,
  title,
  reason,
  payload_jsonb,
  status,
  requested_by,
  assigned_to,
  created_at
)
SELECT
  mc.tenant_id,
  'moderate',
  'memory',
  'memory_candidate',
  mc.id::text,
  mc.client_id,
  'Memory proposal',
  'Memory candidate awaiting independent review.',
  jsonb_build_object(
    'workflow', 'memory_review_v2',
    'schemaVersion', 1,
    'sourceKind', mc.source_kind,
    'scope', mc.scope
  ),
  'pending',
  mc.proposed_by,
  NULL,
  mc.created_at
FROM memory_candidate mc
WHERE mc.status = 'pending'
  AND mc.scope IN ('firm', 'client')
ON CONFLICT DO NOTHING;

-- Create the workflow obligation in the SAME transaction as every future
-- shared-candidate insert. It is body-free and intentionally starts unassigned;
-- the application assigns only after evaluating the live authorization policy.
CREATE OR REPLACE FUNCTION ensure_memory_review_request_for_candidate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'pending' AND NEW.scope IN ('firm', 'client') THEN
    INSERT INTO review_request (
      tenant_id,
      risk_tier,
      surface,
      subject_type,
      subject_id,
      client_id,
      title,
      reason,
      payload_jsonb,
      status,
      requested_by,
      assigned_to,
      created_at
    ) VALUES (
      NEW.tenant_id,
      'moderate',
      'memory',
      'memory_candidate',
      NEW.id::text,
      NEW.client_id,
      'Memory proposal',
      'Memory candidate awaiting independent review.',
      jsonb_build_object(
        'workflow', 'memory_review_v2',
        'schemaVersion', 1,
        'sourceKind', NEW.source_kind,
        'scope', NEW.scope
      ),
      'pending',
      NEW.proposed_by,
      NULL,
      NEW.created_at
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_candidate_ensure_review_request ON memory_candidate;
CREATE TRIGGER memory_candidate_ensure_review_request
AFTER INSERT ON memory_candidate
FOR EACH ROW
EXECUTE FUNCTION ensure_memory_review_request_for_candidate();

-- Enforce named-reviewer authority at the same database write that changes the
-- candidate's terminal state. This closes assignment-change races and prevents
-- an older compatibility route from bypassing the Phase 2 workflow service.
CREATE OR REPLACE FUNCTION enforce_memory_review_assignment_on_decision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  workflow_requested_by uuid;
  workflow_assigned_to uuid;
  workflow_status text;
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
     AND OLD.scope IN ('firm', 'client') THEN
    SELECT requested_by, assigned_to, status
      INTO workflow_requested_by, workflow_assigned_to, workflow_status
    FROM review_request
    WHERE tenant_id = NEW.tenant_id
      AND surface = 'memory'
      AND subject_type = 'memory_candidate'
      AND subject_id = NEW.id::text
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_WORKFLOW_REQUIRED'
        USING ERRCODE = '42501';
    END IF;
    IF workflow_status <> 'pending' THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_NOT_PENDING'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.decided_by IS NULL
       OR workflow_assigned_to IS NULL
       OR NEW.decided_by <> workflow_assigned_to THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_ASSIGNED_REVIEWER_REQUIRED'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.decided_by = workflow_requested_by THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_SELF_DECISION_DENIED'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_candidate_enforce_review_assignment ON memory_candidate;
CREATE TRIGGER memory_candidate_enforce_review_assignment
BEFORE UPDATE OF status, decided_by ON memory_candidate
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_review_assignment_on_decision();

-- Candidate activation/rejection/withdrawal already runs in an atomic row-locked
-- transaction. Mirror that terminal truth into its workflow in the SAME DB
-- transaction, so a process crash after candidate commit cannot leave a pending
-- review row. The service separately writes the bounded human reason and audit.
CREATE OR REPLACE FUNCTION sync_memory_review_request_terminal_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('approved', 'rejected', 'withdrawn') THEN
    UPDATE review_request
    SET status = NEW.status,
        decided_by = NEW.decided_by,
        decided_at = COALESCE(NEW.decided_at, now())
    WHERE tenant_id = NEW.tenant_id
      AND surface = 'memory'
      AND subject_type = 'memory_candidate'
      AND subject_id = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_candidate_sync_review_terminal ON memory_candidate;
CREATE TRIGGER memory_candidate_sync_review_terminal
AFTER UPDATE OF status, decided_by, decided_at ON memory_candidate
FOR EACH ROW
EXECUTE FUNCTION sync_memory_review_request_terminal_status();
