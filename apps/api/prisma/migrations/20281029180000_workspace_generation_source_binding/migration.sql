-- A generation transcript keeps the exact Workspace source restriction that
-- created it. Generic metadata edits cannot remove or replace this origin.
BEGIN;
CREATE FUNCTION protect_workspace_generation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.metadata_jsonb->'workspaceProspectGeneration') IS DISTINCT FROM
     (OLD.metadata_jsonb->'workspaceProspectGeneration') THEN
    RAISE EXCEPTION 'Workspace generation source is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.metadata_jsonb ? 'workspaceProspectGeneration' AND
     ROW(NEW.id,NEW.tenant_id,NEW.user_id,NEW.client_id) IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.user_id,OLD.client_id) THEN
    RAISE EXCEPTION 'Workspace generation identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clio_workspace_generation_source_immutable
  BEFORE UPDATE ON clio_conversations
  FOR EACH ROW EXECUTE FUNCTION protect_workspace_generation_source();
COMMIT;
