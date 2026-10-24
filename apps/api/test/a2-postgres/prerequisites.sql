-- Deliberately minimal historical schema subset, only in a guarded empty fixture schema.
-- The actual 20260914120000 and 20281023040000 migrations are applied afterward.
CREATE TYPE tenant_role AS ENUM ('capiro_admin','user_admin','standard_user','client_portal_user');
CREATE TYPE membership_status AS ENUM ('invited','active','removed');
CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.current_tenant',true),'')::uuid $$;
CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE TABLE tenants (id uuid PRIMARY KEY);
CREATE TABLE users (id uuid PRIMARY KEY,clerk_user_id text NOT NULL UNIQUE);
CREATE TABLE tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),role tenant_role NOT NULL,status membership_status NOT NULL,
  UNIQUE(tenant_id,user_id)
);
CREATE TABLE clients (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),status text NOT NULL DEFAULT 'active',
  account_owner_user_id uuid REFERENCES users(id),account_owner_version integer NOT NULL DEFAULT 0,
  memory_wall boolean NOT NULL DEFAULT false,UNIQUE(tenant_id,id)
);
CREATE TABLE client_memory_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
  client_id uuid NOT NULL REFERENCES clients(id),user_id uuid NOT NULL REFERENCES users(id),
  UNIQUE(tenant_id,client_id,user_id)
);
CREATE TABLE engagement_attachments (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid REFERENCES clients(id),
  prospect_id uuid,folder varchar(120),uploaded_by_user_id uuid REFERENCES users(id),
  viewer_mode varchar(16) NOT NULL DEFAULT 'all' CHECK(viewer_mode IN ('all','restricted')),
  viewer_user_ids text[] NOT NULL DEFAULT ARRAY[]::text[],source_entity_type varchar(64),
  file_name text NOT NULL DEFAULT 'Synthetic.pdf',created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_memberships','clients','client_memory_access','engagement_attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id())',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON tenants,users,tenant_memberships,clients,client_memory_access,engagement_attachments TO capiro_app;
