-- Source-only handoff; not executed here.
-- Run independently against each service's existing authorized target.
-- A catalog result or SELECT privilege does not prove complete RLS visibility.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '1s';

SELECT
  transaction_timestamp() AS checked_at,
  current_database() AS database_name,
  current_user AS database_role,
  current_schema() AS current_schema_name,
  current_setting('search_path') AS search_path,
  current_setting('transaction_read_only') AS transaction_read_only,
  current_setting('server_version_num') AS server_version_num,
  pg_is_in_recovery() AS is_replica;

SELECT
  n.nspname AS ledger_schema, c.relname AS ledger_table,
  pg_get_userbyid(c.relowner) AS ledger_owner,
  c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
  has_schema_privilege(current_user, n.oid, 'USAGE') AS schema_usage,
  has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
  array_agg(a.attname ORDER BY a.attnum) AS columns
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
WHERE c.relname = '_prisma_migrations'
  AND c.relkind IN ('r', 'p')
  AND a.attnum > 0 AND NOT a.attisdropped
GROUP BY n.nspname, c.relname, c.relowner, c.relrowsecurity,
  c.relforcerowsecurity, n.oid, c.oid
ORDER BY n.nspname;

ROLLBACK;
