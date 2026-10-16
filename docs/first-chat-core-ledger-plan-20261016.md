# Core first-chat migration ledger comparison — held

This plan has performed **no production SQL, Secrets Manager value read, ECS task run, migration, or AWS write**. The Core preview proposal is PR #44, whose pinned runtime source is PR #43 `13d12a7d7bdbe0be021cb218dd4cf7690cc4420b`.

## Current access facts (read-only inventory, 2026-10-16)

- Aurora cluster `capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv` in account `967807252336`, `us-east-1`, database `capiro`, is available; its RDS Data API is disabled. IAM database authentication is enabled at cluster level, but no migration ledger reader with `rds_iam` grant is present in the repository's role creation SQL. Cluster metadata alone cannot prove such a live role exists.
- This Windows jump host is in the database VPC, and the Aurora SG permits its SG on 5432. That establishes a network path, **not** a read-only DB login. PostgreSQL 16's `psql.exe` exists locally outside `PATH`, but no proven ledger reader credential is available. Do not fetch the master/app/analytics password to the jump box to bridge this gap.
- `capiro_analytics_ro` is the only explicitly SELECT-only login role in Core source. Its migration grants SELECT to twelve named global-data tables only; `_prisma_migrations` is deliberately outside that list. Do not broaden this role for a schema audit.
- Existing `capiro-dev-api-migrate:136` runs with secret injection and can use the guarded `migration-status` entrypoint verb, but it defaults to `migrate` and holds the **write-capable master** DB credential. The proposed PR #44 task defaults to `migration-status` and is separate. A new `RunTask` is a paid AWS action and still needs approval. `prisma migrate status` alone does not establish every live checksum or database-only migration.

## Exact local side

The pinned PR #43 tree has **475** `apps/api/prisma/migrations/*/migration.sql` files. The intended final local migration is `20281016020000_clio_conversation_bootstrap_receipts`, SHA-256 `943ef85f23922de246c4ec53771630f586f4ad4d99b8a871504c341ee66e9ff0`. The Objective `20281016010000_*` migration must be absent from the image. Run the offline comparator only against an exact source checkout/image migration tree:

```text
node infra/deploy/first-chat-ledger-compare.mjs <exact-image-apps/api/prisma/migrations> <metadata-only-ledger.json>
```

It computes SHA-256 from SQL bytes and compares all 475 files to the hash-pinned PR #43 manifest, refuses unexpected JSON fields, and prints only migration metadata. It passes only if the sole pending migration is the first-chat receipt; no DB-only migration, altered checksum, unresolved failure, or rolled-back history can be silently ignored. `--post` requires no pending migration after a separately approved migration. A historical rolled-back row yields BLOCK for human review, not an automatic ledger repair.

## Approved-run candidate, not yet executed

Use a **separately reviewed, one-shot audit task** in the existing private subnets and API network SG, with DB host fixed to the canonical Aurora writer, DB name `capiro`, and master secret injected by ECS into the container (never returned through AWS CLI). Its code must verify the server certificate and hostname (`sslmode=verify-full` or equivalent) against a reviewed RDS CA bundle. It must compare `current_database()` to `capiro`, `current_user` to the injected expected DB username, and `pg_is_in_recovery()` to `false`, refusing any mismatch without printing the credential or username. Immediately issue `SET default_transaction_read_only = on`, then run exactly one transaction:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SELECT current_database() AS db, current_user AS role,
       current_setting('transaction_read_only') AS read_only,
       pg_is_in_recovery() AS replica;
SELECT COALESCE(json_agg(json_build_object(
         'migration_name', migration_name,
         'checksum', checksum,
         'finished', finished_at IS NOT NULL,
         'rolled_back', rolled_back_at IS NOT NULL,
         'has_error', COALESCE(length(logs), 0) > 0
       ) ORDER BY started_at, migration_name), '[]'::json)
FROM public."_prisma_migrations";
SELECT to_regclass('public.tenants') IS NOT NULL AS tenants_present,
       to_regclass('public.clio_conversations') IS NOT NULL AS conversations_present,
       to_regprocedure('public.current_tenant_id()') IS NOT NULL AS tenant_fn_present,
       to_regprocedure('public.rls_bypass()') IS NOT NULL AS bypass_fn_present,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') AS app_role_present;
COMMIT;
```

The audit task must refuse any DB identity mismatch or `read_only != on`, output only the five ledger metadata fields, boolean prerequisites, and a pass/fail DB identity attestation, and have no arbitrary SQL or command input. A fixed-purpose entrypoint or separate task definition is needed: the PR #43 image's existing entrypoint does not offer a raw ledger-export verb, and ECS `RunTask` command overrides cannot replace its entrypoint. Do not run ad hoc SQL through the production API service or use the write-capable `capiro_app` credential as a supposed read-only role.

Before such a task runs, approve its exact source/image, task definition and master-secret execution role, paid `RunTask`, and read-only query against this shared production database. After export, compare offline; require the PR #43 receipt as sole pending before any separate migration authorization. Recheck the writer ledger in a read-only transaction immediately before an approved migration because Aurora's reader endpoint can lag.
