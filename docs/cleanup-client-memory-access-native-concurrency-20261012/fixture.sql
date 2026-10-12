-- Invocation-owned final-shape adapter fixture, not a migration replay or
-- Prisma Client/AuditLog schema acceptance. No persistent/public objects.
CREATE TABLE tenants(id uuid PRIMARY KEY,status text NOT NULL DEFAULT 'active');
CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text NOT NULL UNIQUE);
CREATE TABLE tenant_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),user_id uuid NOT NULL REFERENCES users(id),role text NOT NULL,status text NOT NULL,UNIQUE(tenant_id,user_id));
CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text NOT NULL,status text NOT NULL DEFAULT 'active',memory_wall boolean NOT NULL DEFAULT true,UNIQUE(tenant_id,id));
CREATE TABLE client_memory_access(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id),granted_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id),UNIQUE(tenant_id,client_id,user_id));
CREATE TABLE client_objectives(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid NOT NULL,version integer NOT NULL DEFAULT 1,deleted_at timestamptz,FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id));
CREATE TABLE client_objective_revisions(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid NOT NULL,objective_id uuid NOT NULL REFERENCES client_objectives(id),version integer NOT NULL DEFAULT 1);
CREATE TABLE audit_logs(seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,id uuid NOT NULL DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),actor_user_id uuid NOT NULL REFERENCES users(id),actor_role text NOT NULL,action text NOT NULL,entity_type text NOT NULL,entity_id uuid NOT NULL,before_json jsonb NOT NULL,after_json jsonb NOT NULL);
-- Fixture tenant isolation only. Canonical reader independently rechecks actor,
-- tenant, membership, current wall/grant and objective revision authority.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants USING(id=NULLIF(current_setting('app.current_tenant',true),'')::uuid) WITH CHECK(id=NULLIF(current_setting('app.current_tenant',true),'')::uuid);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['tenant_memberships','clients','client_memory_access','client_objectives','client_objective_revisions','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING(tenant_id=NULLIF(current_setting(''app.current_tenant'',true),'''')::uuid) WITH CHECK(tenant_id=NULLIF(current_setting(''app.current_tenant'',true),'''')::uuid)',tab);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA capiro_wall_writer_20261012 TO capiro_wall_writer_app_20261012;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA capiro_wall_writer_20261012 TO capiro_wall_writer_app_20261012;
