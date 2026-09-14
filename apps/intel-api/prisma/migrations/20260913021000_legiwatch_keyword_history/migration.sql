CREATE TABLE intel_legiwatch_suggestion_operation (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,
 request_key TEXT NOT NULL,outcome TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,owner_clerk_id,request_key)
);
CREATE TABLE intel_legiwatch_keyword_rule_version (
 tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,rule_id TEXT NOT NULL,version INTEGER NOT NULL,
 payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,rule_id,version)
);
CREATE FUNCTION legiwatch_keyword_retain_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.version<>OLD.version THEN
  INSERT INTO intel_legiwatch_keyword_rule_version(tenant_id,owner_clerk_id,rule_id,version,payload)
   VALUES(NEW.tenant_id,NEW.owner_clerk_id,NEW.id,NEW.version,to_jsonb(NEW));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER keyword_retain_version AFTER INSERT OR UPDATE ON intel_legiwatch_keyword_rule
 FOR EACH ROW EXECUTE FUNCTION legiwatch_keyword_retain_version();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['intel_legiwatch_suggestion_operation','intel_legiwatch_keyword_rule_version'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY keyword_history_owner ON %I USING (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true)) WITH CHECK (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',t);
  EXECUTE format('CREATE TRIGGER keyword_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION legiwatch_decision_immutable()',t);
 END LOOP;
END $$;
