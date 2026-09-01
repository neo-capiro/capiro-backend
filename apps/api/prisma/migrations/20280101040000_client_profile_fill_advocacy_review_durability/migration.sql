-- Preserve unresolved Advocacy History review work across Fill-with-Meri runs.
--
-- Advocacy source cursors (LDA, testimony, client submissions, private
-- evidence, etc.) are client-scoped and incremental, while findings are
-- intentionally run-scoped. Without this bridge a finding discovered in run
-- A can stay pending, the source cursor can correctly move past the underlying
-- evidence, and run B can no longer show the unresolved item because it only
-- reads findings whose run_id = run B.
--
-- The SAME pending finding row is re-homed onto the newest workflow-v2 run.
-- We deliberately do not clone it: preserving the finding id means a review
-- action already in flight against the old run cannot create a second decision
-- or lose its terminal state simply because a new run started concurrently.
-- Evidence, proposal, content hash and created_at remain unchanged. No source
-- cursor and no canonical client/Advocacy record is touched here.

CREATE OR REPLACE FUNCTION carry_forward_pending_advocacy_fill_findings_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Legacy runs predate the durable completion workflow. They must retain
  -- their historical behavior and never acquire advanced Advocacy findings.
  IF COALESCE(NEW.workflow_version, 1) < 2 THEN
    RETURN NEW;
  END IF;

  WITH locked_pending AS (
    SELECT f.id, f.content_hash, f.created_at
      FROM client_profile_fill_finding f
      JOIN client_profile_fill_run prior_run
        ON prior_run.id = f.run_id
       AND prior_run.tenant_id = f.tenant_id
       AND prior_run.client_id = f.client_id
     WHERE f.tenant_id = NEW.tenant_id
       AND f.client_id = NEW.client_id
       AND f.run_id <> NEW.id
       AND f.status = 'pending'
       AND f.kind IN ('advocacy_record', 'advocacy_outcome', 'regulatory_outcome')
       -- startRun already refuses to create a second active run. Keeping this
       -- gate here makes the DB behavior fail-safe if two creators race.
       AND prior_run.status <> 'running'
     FOR UPDATE OF f
  ),
  eligible AS (
    SELECT pending.id,
           pending.content_hash,
           ROW_NUMBER() OVER (
             PARTITION BY pending.content_hash
             ORDER BY pending.created_at DESC, pending.id DESC
           ) AS review_rank
      FROM locked_pending pending
     WHERE NOT EXISTS (
       SELECT 1
         FROM client_profile_fill_finding terminal
        WHERE terminal.tenant_id = NEW.tenant_id
          AND terminal.client_id = NEW.client_id
          AND terminal.content_hash = pending.content_hash
          AND terminal.status IN ('accepted', 'rejected')
     )
  ),
  moved AS (
    UPDATE client_profile_fill_finding current_review
       SET run_id = NEW.id,
           updated_at = now()
      FROM eligible
     WHERE current_review.id = eligible.id
       AND eligible.review_rank = 1
    RETURNING current_review.id, current_review.content_hash
  )
  -- If historical retries somehow left duplicate pending copies, retain the
  -- newest as the one current review item and retire the older copies. A hash
  -- with an accepted/rejected decision is also terminal and cannot resurrect.
  UPDATE client_profile_fill_finding old
     SET status = 'informational',
         updated_at = now()
   WHERE old.id IN (SELECT id FROM locked_pending)
     AND old.status = 'pending'
     AND NOT EXISTS (
       SELECT 1
         FROM moved
        WHERE moved.id = old.id
     );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_profile_fill_run_advocacy_review_carry_forward
  ON client_profile_fill_run;

CREATE TRIGGER client_profile_fill_run_advocacy_review_carry_forward
AFTER INSERT ON client_profile_fill_run
FOR EACH ROW
EXECUTE FUNCTION carry_forward_pending_advocacy_fill_findings_v1();
