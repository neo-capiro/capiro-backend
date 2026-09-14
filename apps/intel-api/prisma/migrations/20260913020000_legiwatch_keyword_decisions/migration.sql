-- Intel owns private decisions; source facts remain API-owned. No assignment
-- foreign key: decisions and manual exclusions survive membership removal.
CREATE TABLE intel_legiwatch_membership_state (
  tenant_id TEXT NOT NULL, folder_id TEXT NOT NULL, bill_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), suppressed BOOLEAN NOT NULL DEFAULT false,
  human_revision INTEGER NOT NULL DEFAULT 0, membership_id TEXT,
  created_by_action TEXT, contributions JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY(tenant_id,folder_id,bill_id)
);
CREATE TABLE intel_legiwatch_decision (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  folder_id TEXT NOT NULL, bill_id TEXT NOT NULL, request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, action TEXT NOT NULL, origin TEXT NOT NULL,
  rule_id TEXT, state_version INTEGER NOT NULL, outcome TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,actor_id,request_key), CHECK(origin IN ('manual','import','rule'))
);
CREATE INDEX legiwatch_decision_history ON intel_legiwatch_decision(tenant_id,folder_id,bill_id,created_at,id);
CREATE TABLE intel_legiwatch_keyword_rule (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_clerk_id TEXT NOT NULL,
  name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'needs_review' CHECK(state IN ('needs_review','active','paused')),
  config JSONB NOT NULL, activation JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE intel_legiwatch_discovery_run (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_clerk_id TEXT NOT NULL,
  rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, request_key TEXT NOT NULL,
  input_hash TEXT NOT NULL, input JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','running','complete','partial','stale','denied','failed','paused')),
  cursor TEXT, counts JSONB NOT NULL DEFAULT '{}', source_boundary TEXT NOT NULL,
  lease_token TEXT, lease_until TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,owner_clerk_id,request_key), UNIQUE(tenant_id,id)
);
CREATE INDEX legiwatch_discovery_due ON intel_legiwatch_discovery_run(tenant_id,owner_clerk_id,state,updated_at);
CREATE TABLE intel_legiwatch_suggestion (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, owner_clerk_id TEXT NOT NULL,
  rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, run_id TEXT NOT NULL,
  folder_id TEXT NOT NULL, bill_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','added','already_present','dismissed','excluded','stale','denied','undone')),
  payload JSONB NOT NULL, decision_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,owner_clerk_id,folder_id,bill_id,fingerprint)
);
CREATE INDEX legiwatch_suggestion_scope ON intel_legiwatch_suggestion(tenant_id,owner_clerk_id,folder_id,state,id);
CREATE TABLE intel_legiwatch_rule_exclusion (
  tenant_id TEXT NOT NULL, owner_clerk_id TEXT NOT NULL, rule_id TEXT NOT NULL,
  folder_id TEXT NOT NULL, bill_id TEXT NOT NULL, excluded BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id,owner_clerk_id,rule_id,folder_id,bill_id)
);
CREATE FUNCTION legiwatch_decision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'LEGIWATCH_DECISION_IMMUTABLE'; END $$;
CREATE TRIGGER legiwatch_decision_immutable BEFORE UPDATE OR DELETE ON intel_legiwatch_decision
  FOR EACH ROW EXECUTE FUNCTION legiwatch_decision_immutable();
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['intel_legiwatch_membership_state','intel_legiwatch_decision'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY decision_read ON %I FOR SELECT USING (tenant_id=current_tenant_id()::text)',t);
    EXECUTE format('CREATE POLICY decision_write ON %I FOR INSERT WITH CHECK (tenant_id=current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id))',t);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',t);
    EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['intel_legiwatch_keyword_rule','intel_legiwatch_discovery_run','intel_legiwatch_suggestion','intel_legiwatch_rule_exclusion'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY keyword_owner ON %I USING (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true)) WITH CHECK (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true))',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO capiro_app',t);
    EXECUTE format('REVOKE DELETE,TRUNCATE ON %I FROM capiro_app',t);
  END LOOP;
END $$;
CREATE POLICY membership_state_update ON intel_legiwatch_membership_state FOR UPDATE
 USING (tenant_id=current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id))
 WITH CHECK (tenant_id=current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id));
GRANT UPDATE ON intel_legiwatch_membership_state TO capiro_app;
