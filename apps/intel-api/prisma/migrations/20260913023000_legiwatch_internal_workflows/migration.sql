CREATE TABLE intel_legiwatch_preparation_request (
 tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,
 snapshot_id TEXT NOT NULL,PRIMARY KEY(tenant_id,owner_clerk_id,request_key)
);
CREATE TABLE intel_legiwatch_workflow (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,name TEXT NOT NULL,
 template TEXT NOT NULL CHECK(template IN ('hearing_preparation','added_bill_review','published_review','report_review')),
 state TEXT NOT NULL DEFAULT 'paused' CHECK(state IN ('active','paused')),version INTEGER NOT NULL DEFAULT 1,
 config JSONB NOT NULL,baseline_at TIMESTAMPTZ NOT NULL DEFAULT now(),cursor TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE intel_legiwatch_workflow_action (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,workflow_id TEXT,
 request_key TEXT NOT NULL,template TEXT NOT NULL,input_hash TEXT NOT NULL,input JSONB NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','partial','complete','held','stale','denied','failed','paused')),
 steps JSONB NOT NULL DEFAULT '{}',reason TEXT,attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,owner_clerk_id,request_key)
);
CREATE INDEX legiwatch_workflow_due ON intel_legiwatch_workflow_action(tenant_id,owner_clerk_id,state,updated_at);
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['intel_legiwatch_preparation_request','intel_legiwatch_workflow','intel_legiwatch_workflow_action'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY workflow_owner ON %I USING (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true)) WITH CHECK (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO capiro_app',t);EXECUTE format('REVOKE DELETE,TRUNCATE ON %I FROM capiro_app',t);
 END LOOP;
END $$;
CREATE POLICY workflow_system_read ON intel_legiwatch_workflow FOR SELECT USING(rls_bypass());
CREATE POLICY workflow_action_system_read ON intel_legiwatch_workflow_action FOR SELECT USING(rls_bypass());
CREATE FUNCTION legiwatch_workflow_input_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.input IS DISTINCT FROM OLD.input OR NEW.input_hash<>OLD.input_hash OR NEW.owner_clerk_id<>OLD.owner_clerk_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.template<>OLD.template OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id THEN
  RAISE EXCEPTION 'WORKFLOW_ACTION_INPUT_IMMUTABLE';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER workflow_action_input_immutable BEFORE UPDATE ON intel_legiwatch_workflow_action
 FOR EACH ROW EXECUTE FUNCTION legiwatch_workflow_input_immutable();
