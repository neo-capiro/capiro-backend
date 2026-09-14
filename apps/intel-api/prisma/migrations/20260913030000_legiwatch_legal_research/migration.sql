CREATE TABLE intel_legiwatch_legal_membership (
 tenant_id text NOT NULL,folder_id text NOT NULL,reference_id text NOT NULL,version integer NOT NULL DEFAULT 0,
 removed boolean NOT NULL DEFAULT false,edition text,notes text,source_memberships jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(tenant_id,folder_id,reference_id)
);
CREATE TABLE intel_legiwatch_legal_decision (
 id text PRIMARY KEY,tenant_id text NOT NULL,folder_id text NOT NULL,actor_id text NOT NULL,
 request_key text NOT NULL,request_hash text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,actor_id,request_key)
);
CREATE TABLE intel_legiwatch_statute_rule (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,staged_id text,
 name text,source_id text,source_hash text,config jsonb NOT NULL,version integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'needs_review',activation jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,staged_id)
);
CREATE TABLE intel_legiwatch_research_selection (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,folder_id text,
 client_id text,request_key text NOT NULL,input_hash text NOT NULL,payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,owner_clerk_id,request_key)
);
ALTER TABLE intel_legiwatch_statute_rule ADD COLUMN last_run_at timestamptz;
CREATE TABLE intel_legiwatch_statute_match (
 id text PRIMARY KEY,tenant_id text NOT NULL,owner_clerk_id text NOT NULL,
 rule_id text NOT NULL REFERENCES intel_legiwatch_statute_rule(id),rule_version integer NOT NULL,
 baseline boolean NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['intel_legiwatch_legal_membership','intel_legiwatch_legal_decision'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY legal_read ON %I FOR SELECT USING(tenant_id=current_tenant_id()::text)',t);
  EXECUTE format('CREATE POLICY legal_insert ON %I FOR INSERT WITH CHECK(tenant_id=current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',t);EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['intel_legiwatch_statute_rule','intel_legiwatch_research_selection','intel_legiwatch_statute_match'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY research_owner ON %I USING(tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true)) WITH CHECK(tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',t);EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',t);
 END LOOP;
END $$;
CREATE POLICY legal_membership_update ON intel_legiwatch_legal_membership FOR UPDATE
 USING(tenant_id=current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id))
 WITH CHECK(tenant_id=current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id));
GRANT UPDATE ON intel_legiwatch_legal_membership,intel_legiwatch_statute_rule TO capiro_app;
CREATE TRIGGER legal_decision_immutable BEFORE UPDATE OR DELETE ON intel_legiwatch_legal_decision FOR EACH ROW EXECUTE FUNCTION legiwatch_decision_immutable();
CREATE TRIGGER research_selection_immutable BEFORE UPDATE OR DELETE ON intel_legiwatch_research_selection FOR EACH ROW EXECUTE FUNCTION legiwatch_decision_immutable();
CREATE TRIGGER statute_match_immutable BEFORE UPDATE OR DELETE ON intel_legiwatch_statute_match FOR EACH ROW EXECUTE FUNCTION legiwatch_decision_immutable();
CREATE TABLE intel_legiwatch_legal_import_decision (
 id text PRIMARY KEY,tenant_id text NOT NULL,actor_id text NOT NULL,request_key text NOT NULL,input_hash text NOT NULL,
 staged_id text NOT NULL,source_version integer NOT NULL,outcome jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,actor_id,request_key)
);
ALTER TABLE intel_legiwatch_legal_import_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_legiwatch_legal_import_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY legal_import_admin ON intel_legiwatch_legal_import_decision USING(tenant_id=current_tenant_id()::text AND current_setting('app.folder_admin',true)='on') WITH CHECK(tenant_id=current_tenant_id()::text AND actor_id=current_setting('app.folder_actor',true) AND current_setting('app.folder_admin',true)='on');
GRANT SELECT,INSERT ON intel_legiwatch_legal_import_decision TO capiro_app;
REVOKE UPDATE,DELETE,TRUNCATE ON intel_legiwatch_legal_import_decision FROM capiro_app;
CREATE TRIGGER legal_import_decision_immutable BEFORE UPDATE OR DELETE ON intel_legiwatch_legal_import_decision FOR EACH ROW EXECUTE FUNCTION legiwatch_decision_immutable();
