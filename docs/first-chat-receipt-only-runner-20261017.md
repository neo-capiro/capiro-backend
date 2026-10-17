# Core first-chat receipt-only task source

This source-only task stages one migration from the already qualified Core PR #48
linux/amd64 image. It does not build a new image or run a database migration.
The live target is the existing `capiro-dev` Aurora writer, database `capiro`,
schema `public`, as explicitly selected for preview. The prior read-only schema
qualification and ledger audit on this same target remain the baseline.

## Frozen inputs

- Core PR #48 source: `6542f5b089656b6d255465edd464d06c2a0b408f`.
- ECR image:
  `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@sha256:722a483259ebb5e9162b9294c26895bafa890fcfee45dc927ff1d2ec35fa071b`.
- Image-local schema SHA-256 after the qualified generator-only target rewrite:
  `c909a6ce3610f35b9179473af3bf6f418a6e47b4c5ba761bac157aa41b9b0498`.
  The guard reverses that one substitution and requires the canonical schema
  SHA-256 `b532f09179cdba78145816650512424188180b06a89c956150d9955c5009913b`.
- Migration lock SHA-256:
  `693566b52c49db47a2b0901d12400aa3d710d13a49f4a2a154b80c0505ed737c`.
- Sole SQL file `20281016020000_clio_conversation_bootstrap_receipts/migration.sql`:
  2,422 LF bytes, SHA-256
  `31a1dac55108a3f1300e4e6533e4f7f7be738438a89715179ee695f38928b211`.
- Prisma CLI 5.22.0 and engine commit
  `605197351a3c8bdd595af2d2a9bc3025bca48ea2` are checked at task start.
- Writer DNS is pinned in `run.cjs`; migration role is `capiro_master`. The ECS
  task definition selects only `username` and `password` fields of
  `/capiro/dev/aurora/master-P4z1Vo` through a proposed dedicated execution
  role. The task has no application task role or command override.

## Fixed execution

The task definition embeds the reviewed JavaScript in `entryPoint: ["node",
"-e", <source>]` and sets `command: []`. This overrides the API image's legacy
dispatcher. The guard rejects arguments, Prisma/PostgreSQL environment
overrides and nonempty `NODE_OPTIONS`. It stages precisely the schema, lock and
receipt SQL in private `/dev/shm`; it rejects symlinks, extra files, wrong byte
lengths and wrong hashes before any DB connection. No full-tree migration path
is passed to Prisma. The task definition uses the immutable qualified image
digest, `X86_64`, a read-only root filesystem and a dedicated log group.

Direct `pg` preflight uses the existing public RDS regional bundle, pinned at
SHA-256 `52ef9c903529fa3999e576fea1bd6ea3251c4b1cd229d2fa41c65b0ff7464c11`,
with hostname verification. The pinned writer's current RDS CA identifier is
`rds-ca-rsa2048-g1`; the first matching single certificate is passed to pinned
Prisma as `sslcert` with `sslmode=require&sslaccept=strict`. Its single-PEM
SHA-256 is `b4e7459e5d6a98672a557c20bfbb0bd4251983dc563bc4f8e2976ac3426a12ed`.
Prisma's strict native TLS checks the chain and hostname using that root and
system roots; the direct `pg` attestation independently pins the target host.
The Prisma URL is built only in memory with `schema=public` and is never
printed. Prisma 5.22's source recognizes these exact parameters and sets the
schema search path. The pinned Prisma 5.22 CLI reads `db execute --stdin`
through the same staged `--schema` datasource and schema-engine binary as
`migrate deploy`. Its PostgreSQL `simple_query` path discards result rows, so
the fixed one-statement, read-only PL/pgSQL block raises an error unless the
Prisma connection itself has schema `public`, database `capiro`, role
`capiro_master`, writer/read-write state and TLS. It runs after the direct
`pg` preflight and before `migrate deploy`, with a 60-second bound and no URL
or SQL from task arguments. Its output is hashed, never relayed. A failure
or missing pinned CLI success marker holds the task before migration. This
tests the actual target at action time. A separate disposable PostgreSQL run
and Fargate read-only-root execution are still unproven. The local disposable
namespace test was blocked before SQL by Windows `pg_ctl` restricted-token
error 87.

The guard reads only migration-ledger metadata and bounded catalog metadata in
read-only transactions. It checks the already qualified base relation keys,
forced RLS, functions and DDL rights for drift; requires zero unfinished ledger
rows, zero receipt-name rows and absent receipt objects; then invokes the
fixed read-only Prisma namespace preflight and, only on success, invokes
`prisma migrate deploy --schema=<isolated /dev/shm path>` once via `execFile`
without a shell. It does not invoke `migrate resolve`, `db push`, or the API
entrypoint's full-tree `migrate`. After exit, including child failure, it reads
the ledger and receipt catalog again. All prior ledger IDs and metadata must
be unchanged; exactly one finished, unrolled receipt row with the canonical
checksum and exact expected table, constraints, indexes, guard, trigger and
forced RLS policy must be present. Any failure or unreadable postcheck is a
hold with no retry. No client, conversation, receipt or tenant business rows
are read or logged.

The deploy CLI child has a four-minute bound. A killed CLI may leave its schema-engine
child or a database operation completing after the Node wrapper exits; treat
timeout as uncertain, stop the ECS task under the ten-minute operator bound,
and obtain a fresh read-only ledger/catalog result before any further action.
Do not infer rollback from the wrapper exit code or rerun the task.

The separate already registered read-only schema-qualification task can check
the application role's receipt catalog and effective SELECT/INSERT versus
UPDATE/DELETE/TRUNCATE rights after the migration under the bundled approval.
It does not read the migration ledger; the receipt runner owns that comparison.
The application feature stays off until this separate role check and Core/Meri
runtime checks pass. Preserve the receipt table and ledger after an app rollback.

## Reproduce source artifact without AWS access

From a task-owned checkout at this source head, run:

```text
node --test apps/api/scripts/receipt-only/run.test.cjs
node apps/api/scripts/receipt-only/render-taskdef.cjs <saved first-chat-core-schema-qualification-taskdef.json> <new output.json>
```

The renderer reads only the saved earlier task definition to copy its public
RDS CA PEM; it checks the CA hash. It emits JSON and an embedded-entrypoint
hash, but never calls AWS. The exact reviewed task definition candidate is
kept in the task-owned evidence directory, outside this repository. A new
execution role and dedicated 14-day CloudWatch log group must be created and
read back before this task definition can register. It is not executable
solely by having the JSON file. A count-one private `RunTask` and its SQL write
require Neo's bundled action-time approval; no command, environment or
container overrides, no retry, and no other migration are in scope.
