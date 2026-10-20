-- Disposable, deliberately small predecessor for the *actual* Core first-chat
-- receipt migration. This is not a replacement for full migration replay.
-- Keep names and relevant constraints aligned with Core's 2026-05 identity,
-- client, Clio and 2026-07 ethical-wall migrations.

CREATE FUNCTION current_tenant_id() RETURNS UUID AS $$
DECLARE
  v_raw TEXT := current_setting('app.current_tenant', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN RETURN NULL; END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION rls_bypass() RETURNS BOOLEAN AS $$
BEGIN
  RETURN current_setting('app.bypass_rls', true) = 'on';
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE users (
  id UUID PRIMARY KEY,
  clerk_user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT
);
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  memory_wall BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE client_memory_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT client_memory_access_uniq UNIQUE (tenant_id, client_id, user_id)
);
CREATE TABLE clio_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  workspace_key TEXT NOT NULL DEFAULT 'workspace',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ(6)
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_isolation ON tenants
  USING (rls_bypass() OR id = current_tenant_id())
  WITH CHECK (rls_bypass() OR id = current_tenant_id());
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_isolation ON clients
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE client_memory_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_memory_access FORCE ROW LEVEL SECURITY;
CREATE POLICY client_memory_access_isolation ON client_memory_access
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE clio_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE clio_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY clio_conversations_isolation ON clio_conversations
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
