# District Nexus R4 Migration Ledger Reconciliation

Status: **PREPARED, NOT EXECUTED**. Do not run the production step below until
separately authorized. This is a metadata-only operation — it never runs the
migration's DDL, only tells Prisma's ledger that it doesn't need to.

## Root cause

`apps/api/prisma/migrations/20280902010000_district_nexus_release4_priority_intelligence`
(R4) was authored with a placeholder future timestamp — a pattern several
unrelated feature branches used concurrently in this period to dodge
timestamp collisions during development (several other `2028`-prefixed
migration folders exist in this repo for the same reason: defense budget,
CPF/CDS canonical ingestion, LegiWatch v2 waves, etc.), intending to correct
it before merge. It merged (PR #1449, `e3fc86544`) at 2026-09-05T20:50:28Z.

A follow-up migration, `20260906010000_gsa_frpp_varchar_overflow_fix`
(PRs #1485/#1487, final content merged `b83e88482`, 2026-09-06T01:28:33Z),
widens two `gsa_real_property` columns that R4's migration creates. It was
authored with an honest near-term timestamp.

Because `prisma migrate deploy` applies pending migrations in lexicographic
folder-name order, a **fresh** database sorts the varchar-fix's `ALTER TABLE
gsa_real_property` before R4's `CREATE TABLE IF NOT EXISTS gsa_real_property`
and fails with `relation "gsa_real_property" does not exist`. Production was
never affected because R4 had already been applied (under its placeholder
name) before the varchar fix was even written — confirmed directly against
production's `_prisma_migrations` table (read-only query, 2026-09-06):

| migration_name                                                 | started_at               | applied_steps_count | rolled_back_at |
| -------------------------------------------------------------- | ------------------------ | ------------------- | -------------- |
| `20280902010000_district_nexus_release4_priority_intelligence` | 2026-09-05T21:58:10.714Z | 1                   | null           |
| `20260906010000_gsa_frpp_varchar_overflow_fix`                 | 2026-09-06T01:20:54.857Z | 1                   | null           |

Both rows are clean: no rollback, no duplicate, `applied_steps_count: 1`.

## The fix

`git mv` the R4 folder to
`20260905205000_district_nexus_release4_priority_intelligence` — a timestamp
reflecting its real merge time, sorting immediately after
`20260905010000_tango_webhook_deliveries` and before the varchar fix. This is
a **pure rename**: `git diff --stat` on the move shows `0 insertions(+), 0
deletions(-)` — migration.sql is byte-identical, so its checksum (which
Prisma computes from file content, never the folder name) is unchanged.

The companion `district_nexus_change_observation_kind` migration (added in
PR #1491, GSA baseline/change classification) carried the same placeholder
pattern (`20280903010000_...`); it is renamed the same way to
`20260906020000_district_nexus_change_observation_kind`, sorting after both
R4-corrected and the varchar fix. That migration has never been applied
anywhere (still an unmerged draft PR), so its rename needs no reconciliation
at all — covered here only for completeness of the ordering, not because it
requires the ledger surgery below.

### Why R4's migration is safe to reference by either name

Every statement in R4's migration.sql is idempotent by construction:
`CREATE EXTENSION IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS` (×3),
`CREATE INDEX IF NOT EXISTS` (×6) — there is not one bare `ALTER`/`INSERT`/
`UPDATE`/`DROP` statement in the file. Re-executing it against a database
that already has these objects is a true no-op: no error, no data change,
sub-second (indexes/tables already exist, every `IF NOT EXISTS` short-circuits).
This idempotency is the **safety backstop**, not the mechanism: the
reconciliation below is a metadata-only ledger write specifically so
production's next `migrate deploy` never even attempts to re-run R4's SQL,
rather than relying on that backstop to make an accidental re-run harmless.

## Environment-by-environment effect of the rename alone (no reconciliation)

| Environment                                                    | Ledger has old name applied? | Effect of the rename with NO reconciliation                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh/empty (CI, a new disposable DB)                          | No (nothing applied yet)     | None — `migrate deploy` simply runs migrations in the corrected order. This is the common case and needs zero manual steps, always.                                                                                                                                                     |
| Dev DB, never fully migrated                                   | No                           | Same as fresh — runs cleanly in corrected order.                                                                                                                                                                                                                                        |
| Dev DB, previously ran a full `migrate deploy` after R4 merged | Yes                          | `migrate deploy` sees the new R4 folder name as pending, re-runs its (idempotent) SQL as a no-op, and records a second ledger row under the new name. Harmless, but leaves ledger duplication and executes SQL statements against that DB without a human reviewing that specific step. |
| Production                                                     | Yes (confirmed above)        | Same as above — but this is a production `migrate deploy` executing SQL (even idempotent SQL) as a side effect of an unrelated deploy, which is exactly the kind of implicit production migration this authorization boundary exists to prevent.                                        |

The reconciliation step below closes that gap for the second and third rows:
it makes the corrected-name migration already "resolved" before the next
`migrate deploy` ever runs, so no environment with existing history executes
any SQL it didn't explicitly opt into.

## Reconciliation step (metadata only — prepared, not executed)

Run once, in each environment whose `_prisma_migrations` table already has a
row named `20280902010000_district_nexus_release4_priority_intelligence`
with `finished_at IS NOT NULL AND rolled_back_at IS NULL` (i.e., cleanly
applied) — production, and any long-lived dev database in the same state.

### 1. Verify precondition (read-only)

```sql
SELECT migration_name, started_at, finished_at, applied_steps_count, rolled_back_at
FROM _prisma_migrations
WHERE migration_name IN (
  '20280902010000_district_nexus_release4_priority_intelligence',
  '20260905205000_district_nexus_release4_priority_intelligence',
  '20260906010000_gsa_frpp_varchar_overflow_fix'
)
ORDER BY started_at;
```

Expect: exactly one row for the OLD R4 name (`finished_at` set,
`rolled_back_at` null, `applied_steps_count = 1`), zero rows yet for the NEW
R4 name, and one clean row for the varchar fix. If this doesn't match — stop,
do not proceed; the environment's history differs from what this runbook
assumes.

### 2. Confirm the target, then reconcile (metadata only — writes one ledger row, executes no DDL)

**Before running the command below, explicitly confirm which database
`DATABASE_URL` (or whatever connection Prisma resolves for this shell)
actually points at.** This step and step 1's query must run against the
exact same connection — print and read back the host/database name, not
just the environment variable's name, before proceeding:

```bash
node -e "const u=new URL(process.env.DATABASE_URL); console.log(u.hostname, u.pathname)"
```

Only once that output is confirmed to be the intended environment:

```bash
# Run from a checkout where the renamed migration folder exists on disk.
npx prisma migrate resolve --applied 20260905205000_district_nexus_release4_priority_intelligence
```

This inserts a `_prisma_migrations` row for the new name marked applied; it
does not touch `gsa_real_property`, `gsa_real_property_source_run`,
`district_nexus_change`, or any other table.

### 3. Verify postcondition (read-only)

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE migration_name = '20260905205000_district_nexus_release4_priority_intelligence';
```

Expect exactly one row, `finished_at` set, `rolled_back_at` null.

### 4. Proceed with the normal deploy

`prisma migrate deploy` now sees R4 (new name) already resolved and the
varchar fix already applied; it moves straight to whatever is genuinely new
(e.g. the GSA baseline-classification migration from PR #1491, once that PR
is rebased onto this one). No R4 or varchar-fix SQL executes.

## Rollback

Step 2 is the only state-changing action, and it is reversible with no data
risk (it never touched a data table):

```bash
npx prisma migrate resolve --rolled-back 20260905205000_district_nexus_release4_priority_intelligence
```

This removes the "applied" marker for the new name. The OLD name's row is
untouched throughout — nothing about R4's original applied history is ever
deleted or edited by this runbook.

**Verify the rollback took effect** (this command can add a distinct ledger
row rather than editing step 2's row in place — check by `rolled_back_at`,
not by row count):

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
WHERE migration_name = '20260905205000_district_nexus_release4_priority_intelligence'
ORDER BY started_at DESC;
```

Expect the most recent row for this name to show `rolled_back_at` set. Do
not treat the rollback as complete until this query confirms it — do not
rely on the absence of an error from step 2's command as sufficient proof.

## Stop conditions

- Do not run step 2 if step 1's query returns anything other than exactly one
  clean row for the old R4 name (e.g., a `rolled_back_at` set, a
  `finished_at IS NULL` stuck row, or more than one row for either name).
  Escalate instead of guessing.
- Do not run this against production without separate explicit authorization
  for that specific environment, even though the operation is metadata-only.
- Do not attempt this reconciliation as a substitute for reviewing the
  precondition query's output — an environment whose history doesn't match
  the assumed shape needs its own investigation, not this runbook.

## Proof this works (validated locally, see the migration-repair PR's test run)

- **Empty database**: `prisma migrate deploy` from scratch runs the full
  chain including R4 (new name) with zero manual steps and zero errors.
- **Production-equivalent ledger**: a disposable Postgres seeded to mirror
  production's exact `_prisma_migrations` state (old R4 name applied,
  varchar fix applied, nothing else) was reconciled via steps 1-3 above, then
  `migrate deploy` was run against it — it completed with no attempt to
  re-run R4 or the varchar fix's SQL, and `prisma migrate status` reported no
  drift.
- **Idempotency**: `migrate deploy` was run a second time against the same
  target immediately after — zero pending migrations, no-op, no error.
