-- Read-only metadata preflight. Uses the release owner's existing psql connection.
-- No credentials, catalog bodies, client records, temporary tables or writer locks.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

SELECT current_setting('transaction_read_only') = 'on' AS read_only,
       current_database() = 'capiro' AS expected_database,
       current_setting('server_version_num')::integer AS server_version_num,
       current_setting('server_encoding') AS server_encoding,
       r.rolsuper AS role_is_superuser,
       r.rolbypassrls AS role_has_bypassrls,
       to_regprocedure('public.rls_bypass()') IS NOT NULL AS bypass_function_exists
FROM pg_roles r WHERE r.rolname = current_user;

WITH expected(migration_name, expected_checksum) AS (VALUES
  ('20261024010000_tango_funding_consolidation', '003ae3c6af559ae7ffab4e822a341cab097fa94e063437223e9fd6346f3d0913'),
  ('20261026184000_tango_funding_embedding_prefix', 'c3c2883a8022cac25ee7b894710ce3601ecf32da0bb24d16afd1ac40c6de9089')
)
SELECT e.migration_name, m.migration_name IS NOT NULL AS present,
       m.checksum, m.checksum = e.expected_checksum AS expected_checksum,
       m.finished_at IS NOT NULL AS finished,
       m.rolled_back_at IS NOT NULL AS rolled_back,
       m.applied_steps_count
FROM expected e LEFT JOIN public."_prisma_migrations" m USING (migration_name)
ORDER BY e.migration_name, m.started_at;

WITH selected(table_name) AS (VALUES
  ('federal_grant'), ('sam_opportunity'), ('tango_opportunity_notice'),
  ('opportunity_attachment'), ('opportunity_document_text'),
  ('tango_resource_snapshot'), ('tango_resource_link'), ('context_embeddings')
)
SELECT s.table_name, c.oid IS NOT NULL AS present,
       c.relrowsecurity AS row_security_enabled,
       c.relforcerowsecurity AS row_security_forced,
       has_table_privilege(c.oid, 'SELECT') AS can_select,
       has_table_privilege(c.oid, 'INSERT') AS can_insert,
       has_table_privilege(c.oid, 'UPDATE') AS can_update,
       has_table_privilege(c.oid, 'DELETE') AS can_delete,
       st.n_live_tup AS approximate_rows,
       CASE WHEN c.oid IS NOT NULL THEN pg_total_relation_size(c.oid) END AS total_bytes_including_indexes
FROM selected s
LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || s.table_name)
LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
ORDER BY s.table_name;

WITH selected(table_name) AS (VALUES
  ('federal_grant'), ('sam_opportunity'), ('tango_opportunity_notice'),
  ('opportunity_attachment'), ('opportunity_document_text'),
  ('tango_resource_snapshot'), ('tango_resource_link'), ('context_embeddings')
)
SELECT s.table_name, a.attnum AS ordinal_position, a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS column_type,
       a.attnotnull AS not_null
FROM selected s JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || s.table_name)
WHERE a.attnum > 0 AND NOT a.attisdropped
ORDER BY s.table_name, a.attnum;

WITH selected(table_name) AS (VALUES
  ('federal_grant'), ('sam_opportunity'), ('tango_opportunity_notice'),
  ('opportunity_attachment'), ('opportunity_document_text'),
  ('tango_resource_snapshot'), ('tango_resource_link'), ('context_embeddings')
)
SELECT s.table_name, con.conname AS constraint_name, con.contype AS constraint_type,
       con.convalidated AS validated, con.condeferrable AS deferrable,
       pg_get_constraintdef(con.oid, true) AS definition
FROM selected s JOIN pg_constraint con ON con.conrelid = to_regclass('public.' || s.table_name)
ORDER BY s.table_name, con.conname;

WITH selected(table_name) AS (VALUES
  ('federal_grant'), ('sam_opportunity'), ('tango_opportunity_notice'),
  ('opportunity_attachment'), ('opportunity_document_text'),
  ('tango_resource_snapshot'), ('tango_resource_link'), ('context_embeddings')
)
SELECT s.table_name, ic.relname AS index_name, i.indisunique AS unique_index,
       i.indisvalid AS valid, i.indisready AS ready,
       pg_get_indexdef(i.indexrelid) AS definition
FROM selected s JOIN pg_index i ON i.indrelid = to_regclass('public.' || s.table_name)
JOIN pg_class ic ON ic.oid = i.indexrelid
ORDER BY s.table_name, ic.relname;

SELECT tablename AS table_name, policyname AS policy_name,
       permissive, cmd AS command, qual AS using_expression,
       with_check AS check_expression
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN (
  'federal_grant', 'sam_opportunity', 'tango_opportunity_notice',
  'opportunity_attachment', 'opportunity_document_text',
  'tango_resource_snapshot', 'tango_resource_link', 'context_embeddings'
)
ORDER BY tablename, policyname;
ROLLBACK;
