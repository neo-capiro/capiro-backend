-- Preserve channel/rule control changes without changing the approved query version.
CREATE TABLE intel_legiwatch_keyword_control_history (
 id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, tenant_id TEXT NOT NULL,
 owner_clerk_id TEXT NOT NULL, rule_id TEXT NOT NULL, payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION legiwatch_keyword_retain_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.state,NEW.activation,NEW.config->'deliveryEnabled') IS DISTINCT FROM
    ROW(OLD.state,OLD.activation,OLD.config->'deliveryEnabled') THEN
  INSERT INTO intel_legiwatch_keyword_control_history(tenant_id,owner_clerk_id,rule_id,payload)
   VALUES(NEW.tenant_id,NEW.owner_clerk_id,NEW.id,jsonb_build_object('before',to_jsonb(OLD),'after',to_jsonb(NEW),'actor',current_setting('app.folder_actor',true)));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER keyword_retain_control AFTER UPDATE ON intel_legiwatch_keyword_rule
 FOR EACH ROW EXECUTE FUNCTION legiwatch_keyword_retain_control();
-- Append overlapping rule contributions; the original delivery body stays frozen.
CREATE TABLE intel_legiwatch_keyword_delivery_reference (
 tenant_id TEXT NOT NULL, owner_clerk_id TEXT NOT NULL, intent_key TEXT NOT NULL,
 rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, suggestion_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,owner_clerk_id,intent_key,rule_id,rule_version,suggestion_id)
);
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['intel_legiwatch_keyword_control_history','intel_legiwatch_keyword_delivery_reference'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY keyword_delivery_history_owner ON %I USING (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true)) WITH CHECK (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true))',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',t);
  EXECUTE format('CREATE TRIGGER keyword_delivery_history_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION legiwatch_decision_immutable()',t);
 END LOOP;
END $$;
