-- Preserve unresolved Advocacy History review work across Fill-with-Meri runs.
--
-- Source cursors (LDA, testimony, client submissions, private evidence, etc.)
-- are client-scoped and incremental, while findings are intentionally scoped
-- to a single run. Without this bridge a finding discovered in run A can stay
-- pending, the source cursor can correctly move past the underlying evidence,
-- and run B can no longer show the unresolved item because it only reads
-- findings whose run_id = run B.
--
-- This trigger moves only the review proposal, never the underlying source
-- cursor and never a client/Advocacy record. Old rows remain for audit.

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
    SELECT f.*
      FROM client_profile_fill_finding f
     WHERE f.tenant_id = NEW.tenant_id
       AND f.client_id = NEW.client_id
       AND f.run_id <> NEW.id
       AND f.status = 'pending'
       AND f.kind IN ('advocacy_record', 'advocacy_outcome', 'regulatory_outcome')
     FOR UPDATE
  ),
  eligible AS (
    -- Historical retries may have left more than one unresolved copy for the
    -- same content hash. One current review item is sufficient; use the newest
    -- copy because it carries the latest evidence/proposal representation.
    SELECT DISTINCT ON (pending.content_hash) pending.*
      FROM locked_pending pending
     WHERE NOT EXISTS (
       SELECT 1
         FROM client_profile_fill_finding terminal
        WHERE terminal.tenant_id = pending.tenant_id
          AND terminal.client_id = pending.client_id
          AND terminal.content_hash = pending.content_hash
          AND terminal.status IN ('accepted', 'rejected')
     )
     ORDER BY pending.content_hash, pending.created_at DESC, pending.id DESC
  ),
  inserted AS (
    INSERT INTO client_profile_fill_finding
      (run_id, tenant_id, client_id, kind, target_key, source, fact_kind,
       current_value_jsonb, proposed_value_jsonb, evidence_jsonb, confidence,
       status, content_hash)
    SELECT NEW.id,
           eligible.tenant_id,
           eligible.client_id,
           eligible.kind,
           eligible.target_key,
           eligible.source,
           eligible.fact_kind,
           eligible.current_value_jsonb,
           eligible.proposed_value_jsonb,
           eligible.evidence_jsonb,
           eligible.confidence,
           'pending',
           eligible.content_hash
      FROM eligible
    ON CONFLICT (run_id, content_hash) DO NOTHING
    RETURNING content_hash
  )
  UPDATE client_profile_fill_finding old
     SET status = 'informational',
         updated_at = now()
   WHERE old.tenant_id = NEW.tenant_id
     AND old.client_id = NEW.client_id
     AND old.run_id <> NEW.id
     AND old.status = 'pending'
     AND old.kind IN ('advocacy_record', 'advocacy_outcome', 'regulatory_outcome')
     AND EXISTS (
       SELECT 1
         FROM inserted
        WHERE inserted.content_hash = old.content_hash
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
