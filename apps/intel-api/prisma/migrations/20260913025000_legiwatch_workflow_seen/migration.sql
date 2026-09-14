-- Enumerate committed unseen events so late commits cannot fall behind a time cursor.
CREATE TABLE intel_legiwatch_workflow_seen(
 tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,workflow_id TEXT NOT NULL,workflow_version INTEGER NOT NULL,event_key TEXT NOT NULL,
 observed_at TIMESTAMPTZ NOT NULL,recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,owner_clerk_id,workflow_id,workflow_version,event_key));
ALTER TABLE intel_legiwatch_workflow_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_legiwatch_workflow_seen FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_seen_owner ON intel_legiwatch_workflow_seen USING(tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting('app.folder_actor',true));
GRANT SELECT,INSERT ON intel_legiwatch_workflow_seen TO capiro_app;
REVOKE UPDATE,DELETE,TRUNCATE ON intel_legiwatch_workflow_seen FROM capiro_app;
