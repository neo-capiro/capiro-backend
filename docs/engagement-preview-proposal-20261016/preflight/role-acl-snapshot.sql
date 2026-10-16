-- PROPOSAL ONLY: no target database execution has been performed.
-- PostgreSQL 16. $1 binds an independently approved database NAME, never a URL.
-- An authorized collector would run these four statements on ONE connection,
-- binding $1 only on the catalog SELECT. No connection runner is included.
-- Any error/missing result/unsupported version means UNKNOWN, never PASS.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- Execute this before parsing/binding the SELECT on the same connection.
SET LOCAL search_path = pg_catalog, pg_temp;

WITH expected(table_name) AS (VALUES
  ('engagement_plans'), ('engagement_plan_waves'),
  ('engagement_plan_command_receipts'), ('engagement_plan_revisions')
),
roles AS MATERIALIZED (
  SELECT oid, rolname::text AS name, rolsuper AS superuser,
    rolbypassrls AS bypass_rls, rolcreaterole AS create_role,
    rolcreatedb AS create_database, rolreplication AS replication,
    rolcanlogin AS login, rolinherit AS default_inherit
  FROM pg_catalog.pg_roles
),
app AS (SELECT oid FROM roles WHERE name='capiro_app'),
tables AS MATERIALIZED (
  SELECT 'public'::text AS schema_name, e.table_name, c.oid,
    c.relowner AS owner_oid, owner.rolname::text AS owner_name,
    c.relkind::text AS kind, c.relpersistence::text AS persistence,
    c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
    c.relacl::text AS raw_acl,
    CASE WHEN c.oid IS NOT NULL THEN
      COALESCE(c.relacl, pg_catalog.acldefault('r',c.relowner)) END AS acl
  FROM expected e
  LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name
  LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner
),
memberships AS MATERIALIZED (
  SELECT oid, roleid AS role_oid, member AS member_oid, grantor AS grantor_oid,
    admin_option, inherit_option, set_option
  FROM pg_catalog.pg_auth_members
),
app_reach AS MATERIALIZED (
  SELECT r.oid AS role_oid,
    pg_catalog.pg_has_role(a.oid,r.oid,'MEMBER') AS member,
    pg_catalog.pg_has_role(a.oid,r.oid,'USAGE') AS usage,
    pg_catalog.pg_has_role(a.oid,r.oid,'SET') AS can_set
  FROM roles r CROSS JOIN app a
),
table_acl AS MATERIALIZED (
  SELECT t.oid AS table_oid, x.grantor AS grantor_oid,
    x.grantee AS grantee_oid, x.privilege_type, x.is_grantable
  FROM tables t CROSS JOIN LATERAL pg_catalog.aclexplode(t.acl) x
),
columns AS MATERIALIZED (
  SELECT t.oid AS table_oid, a.attnum AS number, a.attname::text AS name,
    a.attacl::text AS raw_acl
  FROM tables t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
  WHERE a.attnum>0 AND NOT a.attisdropped
),
column_acl AS MATERIALIZED (
  SELECT t.oid AS table_oid, a.attnum AS number,
    x.grantor AS grantor_oid, x.grantee AS grantee_oid,
    x.privilege_type, x.is_grantable
  FROM tables t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid
  CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
  WHERE a.attnum>0 AND NOT a.attisdropped
),
role_table AS MATERIALIZED (
  SELECT r.oid AS role_oid, t.oid AS table_oid,
    pg_catalog.pg_has_role(r.oid,t.owner_oid,'USAGE') AS owner_usage,
    pg_catalog.has_any_column_privilege(r.oid,t.oid,'UPDATE') AS any_column_update,
    (SELECT pg_catalog.jsonb_object_agg(p,pg_catalog.has_table_privilege(r.oid,t.oid,p))
     FROM pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS privileges(p)) AS effective,
    (SELECT pg_catalog.jsonb_object_agg(p,pg_catalog.has_table_privilege(r.oid,t.oid,p||' WITH GRANT OPTION'))
     FROM pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS privileges(p)) AS grantable
  FROM roles r CROSS JOIN tables t WHERE t.oid IS NOT NULL
),
default_acl AS MATERIALIZED (
  SELECT d.oid, d.defaclrole AS owner_oid, d.defaclnamespace AS schema_oid,
    CASE WHEN d.defaclnamespace=0 THEN '<global>' ELSE n.nspname::text END AS schema_name,
    d.defaclacl::text AS raw_acl,
    (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
      FROM pg_catalog.aclexplode(d.defaclacl) x) AS entries
  FROM pg_catalog.pg_default_acl d
  JOIN roles r ON r.oid=d.defaclrole AND r.name='capiro_master'
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
  WHERE d.defaclobjtype='r' AND (d.defaclnamespace=0 OR n.nspname='public')
)
SELECT pg_catalog.jsonb_build_object(
  'format', 'engagement-role-acl-v1',
  'boundExpectedDatabase', $1::text,
  'database', pg_catalog.current_database(),
  'serverVersionNum', pg_catalog.current_setting('server_version_num')::integer,
  'serverVersion', pg_catalog.version(),
  'observedAt', pg_catalog.statement_timestamp(),
  'sessionUser', SESSION_USER, 'currentUser', CURRENT_USER,
  'transactionReadOnly', pg_catalog.current_setting('transaction_read_only'),
  'transactionIsolation', pg_catalog.current_setting('transaction_isolation'),
  'searchPath', pg_catalog.current_setting('search_path'),
  'catalogCounts', pg_catalog.jsonb_build_object(
    'roles',(SELECT pg_catalog.count(*) FROM roles), 'memberships',(SELECT pg_catalog.count(*) FROM memberships),
    'tables',(SELECT pg_catalog.count(*) FROM tables), 'appReach',(SELECT pg_catalog.count(*) FROM app_reach),
    'tableAcl',(SELECT pg_catalog.count(*) FROM table_acl), 'columns',(SELECT pg_catalog.count(*) FROM columns),
    'columnAcl',(SELECT pg_catalog.count(*) FROM column_acl), 'roleTable',(SELECT pg_catalog.count(*) FROM role_table),
    'defaultAcl',(SELECT pg_catalog.count(*) FROM default_acl)),
  'roles',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY oid),'[]'::jsonb) FROM roles r),
  'memberships',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY oid),'[]'::jsonb) FROM memberships m),
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)-'acl' ORDER BY table_name) FROM tables t),
  'appReach',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY role_oid),'[]'::jsonb) FROM app_reach r),
  'tableAcl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY table_oid,grantee_oid,grantor_oid,privilege_type),'[]'::jsonb) FROM table_acl a),
  'columns',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY table_oid,number),'[]'::jsonb) FROM columns c),
  'columnAcl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY table_oid,number,grantee_oid,grantor_oid,privilege_type),'[]'::jsonb) FROM column_acl a),
  'roleTable',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY role_oid,table_oid),'[]'::jsonb) FROM role_table p),
  'defaultAcl',(SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY oid),'[]'::jsonb) FROM default_acl d)
) AS snapshot;

ROLLBACK;
