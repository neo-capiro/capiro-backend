-- Phase 11 companion guard: prepared jobs and snapshots cannot be deleted
-- directly, while a real tenant cascade remains possible for data-subject
-- deletion. pg_trigger_depth() is greater than one for the FK-triggered child
-- deletes issued by a parent tenant cascade.

CREATE OR REPLACE FUNCTION reject_memory_governance_backfill_control_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'memory_governance_backfill_control_delete_forbidden:%', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS memory_governance_backfill_job_delete_guard
  ON memory_governance_backfill_job;
CREATE TRIGGER memory_governance_backfill_job_delete_guard
BEFORE DELETE ON memory_governance_backfill_job
FOR EACH ROW
EXECUTE FUNCTION reject_memory_governance_backfill_control_delete();

DROP TRIGGER IF EXISTS memory_governance_backfill_row_delete_guard
  ON memory_governance_backfill_row;
CREATE TRIGGER memory_governance_backfill_row_delete_guard
BEFORE DELETE ON memory_governance_backfill_row
FOR EACH ROW
EXECUTE FUNCTION reject_memory_governance_backfill_control_delete();

CREATE OR REPLACE FUNCTION reject_memory_governance_backfill_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'memory_governance_backfill_event_append_only'
    USING ERRCODE = 'P0001';
END;
$$;
