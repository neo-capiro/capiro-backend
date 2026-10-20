# Core first-chat migration ledger comparison — audit held

Core PR #44 contains source-only preparation for a fixed-purpose ledger audit. The pinned application source remains PR #43 `13d12a7d7bdbe0be021cb218dd4cf7690cc4420b`. **No audit task definition has been registered, no audit task has run, no database SQL has been issued for this audit, and no database secret value has been fetched to the jump box.** Separate source-bucket, IAM, and CodeBuild preparation for the preview is outside this audit hold.

## Why an audit task is needed

- The target is the Aurora writer `capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com`, database `capiro`, in account `967807252336`, `us-east-1`. RDS Data API is disabled. The jump box has a network path but no approved direct ledger login. Do not fetch a database password to it.
- The existing `capiro_analytics_ro` role is SELECT-only on twelve named tables and does not cover `public."_prisma_migrations"`. Core source grants `capiro_app` SELECT on public tables, including this ledger, but that application login is **write-capable**. The audit therefore uses the existing app secret only inside ECS and enforces a read-only session and transaction; it must not be described as a read-only database role. Its live SELECT grant remains to be attested by the task.
- The existing migration task defaults to a write-capable migration operation. `prisma migrate status` alone cannot establish every live checksum, database-only migration, or unresolved history. Neither is a substitute for the fixed ledger export.

## Prepared source, not executed

From the repository root, `infra/deploy/first-chat-core-ledger-audit.cjs` is a fixed `node -e` entrypoint source. `infra/deploy/first-chat-core-ledger-audit-taskdef.mjs` renders a reviewable JSON task definition at the task root `first-chat-core-ledger-audit-taskdef.json`; rendering is local only and does not contact AWS. The source and renderer are being reviewed together before any registration.

The candidate task definition uses new family `capiro-preview-first-chat-core-ledger-audit`, an existing retained ARM64 API image pinned by digest `sha256:d2f5a2a76c6c1dfc0bd5843df84cb1f36bb9c2bea7fafcb5819006c22ab6c5ae`, Fargate 512 CPU/1024 MiB, the existing API execution role, no task role, and existing `/capiro/dev/api` logs. It injects only `DB_USER` and `DB_PASSWORD` from the existing `/capiro/dev/aurora/app` secret into ECS; no secret value belongs in the task definition or output. The task has a fixed host, port 5432, database, `capiro_app` username, empty `NODE_OPTIONS` and command, and source embedded in `entryPoint`; the source rejects positional command overrides and has no arbitrary SQL input. A future task run would use the existing private subnets and API network security group, with no public IP.

The reader pins the public RDS regional CA bundle at `docs/meri/releases/2026-10-02/composed-eval-prerequisites/readback/rds-us-east-1-bundle.pem` (SHA-256 `52ef9c903529fa3999e576fea1bd6ea3251c4b1cd229d2fa41c65b0ff7464c11`) and requires TLS certificate authorization and the exact Aurora writer hostname. It rejects unexpected runtime settings, then executes only this sequence with short statement, lock, and idle transaction timeouts:

```sql
SET default_transaction_read_only = on;
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- Attest database, current/session user, transaction_read_only, writer, and ledger SELECT privilege.
-- Check the fixed prerequisite relations/functions/role.
-- Read migration_name, checksum, finished, rolled_back, has_error from public."_prisma_migrations".
COMMIT;
```

The source emits one JSON envelope only after successful commit: `schemaVersion: 1`, pinned `sourceSha`, true TLS/database/role/read-only/writer/SELECT attestation flags, true prerequisite flags, and at most 1,000 ledger rows with only the five fields above. On failure it emits a generic `BLOCK` without credentials or query error detail. The offline comparator requires this exact envelope and separately compares the ledger to the pinned SQL bytes; no browser receipt or client input is ledger authority.

## Exact local comparison

The pinned PR #43 tree has **475** `apps/api/prisma/migrations/*/migration.sql` files. Its final local migration is `20281016020000_clio_conversation_bootstrap_receipts`, SHA-256 `943ef85f23922de246c4ec53771630f586f4ad4d99b8a871504c341ee66e9ff0`. The Objective `20281016010000_*` migration must be absent. From the repository root, use the offline comparator only against the exact source/image migration tree and the attested metadata envelope:

```text
node infra/deploy/first-chat-ledger-compare.mjs <exact-image-apps/api/prisma/migrations> <attested-ledger.json> [--post]
```

The comparator verifies all 475 SQL hashes against the pinned PR #43 manifest and passes before migration only when the receipt is the sole pending migration. A database-only migration, altered checksum, unresolved failure, or rolled-back history blocks review. `--post` requires no pending migration after a separately authorized migration. Neither result authorizes an automatic repair or migration.

## Separate authorization gate

Before registration or execution, review the exact reader source, rendered task definition, existing image digest, public CA, IAM/secret injection, networking, and output/log retention. Obtain separate authorization for ECS task-definition registration, a paid one-shot `RunTask`, and the read-only SQL against the shared database. The eventual `RunTask` request must use the exact registered task revision and **no container overrides**: an environment override such as `NODE_OPTIONS=--require ...` could execute code before the fixed reader, even though a command override would be rejected later. Check the actual request and stop if any command, environment, environment-file, or task-role override is present. A preview image build, IAM source-read grant, or source ZIP upload does not authorize this audit run. Recheck the writer ledger immediately before any separately authorized migration.
