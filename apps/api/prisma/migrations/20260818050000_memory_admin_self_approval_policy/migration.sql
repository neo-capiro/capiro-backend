-- Follow-up policy change: an active tenant administrator may approve or
-- otherwise decide a shared-memory review even when they proposed it and even
-- when another reviewer is assigned. Assignment remains routing metadata for
-- standard/grant reviewers; it is not an authorization prerequisite for an
-- active user_admin or capiro_admin.

ALTER TABLE review_request
  DROP CONSTRAINT IF EXISTS review_request_memory_phase2_shape_check;

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
      AND char_length(reason) BETWEEN 1 AND 500
      AND jsonb_typeof(payload_jsonb) = 'object'
      AND pg_column_size(payload_jsonb) <= 4096
    )
  ) NOT VALID;

ALTER TABLE review_request
  VALIDATE CONSTRAINT review_request_memory_phase2_shape_check;

-- Keep existing open rows and future trigger-created rows aligned with the new
-- administrator-approval policy. This updates display/audit wording only; it
-- does not alter assignment, status, candidate content, or active memory.
UPDATE review_request
SET reason = 'Memory candidate awaiting administrator review.'
WHERE surface = 'memory'
  AND subject_type = 'memory_candidate'
  AND status = 'pending'
  AND reason = 'Memory candidate awaiting independent review.';

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
      memory_review_workflow_title(NEW.payload_jsonb),
      'Memory candidate awaiting administrator review.',
      memory_review_workflow_metadata(NEW.source_kind, NEW.scope, false),
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

CREATE OR REPLACE FUNCTION enforce_memory_review_assignment_on_decision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  workflow_requested_by uuid;
  workflow_assigned_to uuid;
  workflow_status text;
  workflow_assignment_enforced boolean;
  actor_is_active_admin boolean;
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
     AND OLD.scope IN ('firm', 'client') THEN
    SELECT requested_by,
           assigned_to,
           status,
           COALESCE((payload_jsonb->>'assignmentEnforced')::boolean, false)
      INTO workflow_requested_by,
           workflow_assigned_to,
           workflow_status,
           workflow_assignment_enforced
    FROM review_request
    WHERE tenant_id = NEW.tenant_id
      AND surface = 'memory'
      AND subject_type = 'memory_candidate'
      AND subject_id = NEW.id::text
    FOR UPDATE;

    IF NOT FOUND OR NOT workflow_assignment_enforced THEN
      RETURN NEW;
    END IF;
    IF workflow_status <> 'pending' THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_NOT_PENDING'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.decided_by IS NULL THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_DECIDER_REQUIRED'
        USING ERRCODE = '42501';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM tenant_memberships tm
      WHERE tm.tenant_id = NEW.tenant_id
        AND tm.user_id = NEW.decided_by
        AND tm.status = 'active'::membership_status
        AND tm.role IN ('user_admin'::tenant_role, 'capiro_admin'::tenant_role)
    ) INTO actor_is_active_admin;

    -- Active administrators may decide any review they are otherwise authorized
    -- to see, including their own proposal. The application layer still applies
    -- ethical walls, client status, tenant scope, and current membership checks.
    IF actor_is_active_admin THEN
      RETURN NEW;
    END IF;

    -- Preserve the existing route-containment boundary for non-admin reviewers.
    IF workflow_assigned_to IS NULL
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
