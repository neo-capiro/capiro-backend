CREATE TABLE client_notetaker_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  consent_jsonb jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_notetaker_preferences_scope_key UNIQUE (tenant_id, client_id, user_id)
);
CREATE TRIGGER client_notetaker_preferences_updated_at
  BEFORE UPDATE ON client_notetaker_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE client_notetaker_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_notetaker_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY client_notetaker_preferences_isolation ON client_notetaker_preferences
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_notetaker_preferences TO capiro_app;
  END IF;
END $$;
