-- Workspace-owned remote idempotency. A removed draft leaves its receipt so a
-- retry cannot resurrect a user's deleted work. No FK to a cascading draft.
CREATE TABLE ws_source_action (
 tenant_id UUID NOT NULL,owner_id TEXT NOT NULL,source_type TEXT NOT NULL,
 source_key TEXT NOT NULL,input_hash TEXT NOT NULL,draft_id UUID NOT NULL,
 context_item_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,owner_id,source_type,source_key)
);
GRANT SELECT,INSERT ON ws_source_action TO capiro_app;
REVOKE UPDATE,DELETE,TRUNCATE ON ws_source_action FROM capiro_app;
CREATE FUNCTION ws_source_action_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'WORKSPACE_SOURCE_ACTION_IMMUTABLE'; END $$;
CREATE TRIGGER ws_source_action_immutable BEFORE UPDATE OR DELETE ON ws_source_action
 FOR EACH ROW EXECUTE FUNCTION ws_source_action_immutable();
