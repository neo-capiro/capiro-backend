-- Phase 2 increment 1: durable memory-review workflow foundation.
-- Reuses the already-modeled review_request table and adds only SQL features
-- Prisma cannot express: a memory-specific partial unique index and checks.
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
