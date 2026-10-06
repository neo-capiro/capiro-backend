-- Only for the disposable localhost planner_qa database. These minimal tables
-- supply the canonical membership reads; no production schema is modified.
CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid $$;
CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.bypass_rls', true), '') = 'true' $$;
CREATE TABLE users (id uuid PRIMARY KEY, clerk_user_id text UNIQUE, first_name text, last_name text, email text);
CREATE TABLE tenant_memberships (tenant_id uuid, user_id uuid, status text);
INSERT INTO users VALUES
('90000000-0000-4000-8000-000000000001','user_owner','Owner','QA','owner@example.test'),
('90000000-0000-4000-8000-000000000002','user_viewer','Viewer','QA','viewer@example.test'),
('90000000-0000-4000-8000-000000000003','user_outsider','Outsider','QA','outsider@example.test'),
('90000000-0000-4000-8000-000000000004','user_foreign','Foreign','QA','foreign@example.test');
INSERT INTO tenant_memberships VALUES
('10000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','active'),
('10000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002','active'),
('10000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000003','active'),
('10000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000004','active');
