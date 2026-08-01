# MeriV2 Phase 18 — Database Release Rehearsal

## Status

**BLOCKED — not accepted.**

Phase 18 requires successful execution against both a clean PostgreSQL + pgvector database and a production-equivalent upgrade database, with no manual SQL repair. The complete executable rehearsal is committed, but GitHub Actions did not start a legitimate job, and this environment has no authenticated or cached repository checkout from which to run Docker locally.

No migration, backfill, policy publication, feature flag, or customer-data mutation was executed against any shared or production environment.

## Release baseline

- Repository: `neo-capiro/capirov2`
- Release branch: `agent/meriv2-world-class-closeout`
- Primary PR: `#679`
- Current main at implementation start: `b792f2d24920d56d7addcda88a602c6282563f47`
- First synchronized Phase 18 implementation base: `582c8e5ae3264164a784f23eebc14eac7ed036ee`
- Branch relation at implementation start: **0 commits behind**, mergeable, draft, unmerged
- Database image selected by the existing replay harness: `pgvector/pgvector:pg16`

The final evidence SHA must be replaced with the exact successful-run SHA when the workflow control plane is restored.

## Executable rehearsal committed

### Orchestrator

`apps/api/scripts/meriv2-phase18-database-rehearsal.sh`

The orchestrator:

1. Reuses `apps/api/scripts/pe-phase-9-migration-replay.sh` rather than creating a second migration-replay implementation.
2. Creates two disposable databases in one PostgreSQL 16 + pgvector container:
   - `capiro` — clean replay from migration zero;
   - `pe_phase9_upgrade` — current-main migration state, schema-only snapshot/restore, then branch migration application.
3. Requires exactly 14 branch-only MeriV2 migrations and compares the final clean/upgrade migration-name sets.
4. Runs Prisma validation and migration status on both databases.
5. Runs `prisma migrate diff --exit-code` on both databases; any schema drift remains a release blocker.
6. Runs migrated-table/column/index/check/RLS assertions on both databases.
7. Runs the real governed-memory lifecycle, Context Packet v2 persistence, outbox, backfill, and policy-pack rehearsals on both databases.
8. Runs the actual `capiro_app` role RLS matrix against the production-named clean database.
9. Emits bounded JSON/log artifacts and fails if any gate fails.
10. Always destroys the disposable container.

### Migrated-schema assertions

`apps/api/scripts/meriv2-phase18-schema-assertions.sql`

The SQL assertions verify:

- all governed-memory, policy, assurance, feedback-fixture, and backfill control tables exist;
- required governance, lineage, packet, exact-outbox, and decision-binding columns exist;
- all Phase 18 tenant-scoped control tables have both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`;
- required indexes and checks exist;
- all 14 MeriV2 migrations are recorded as successfully applied;
- PostgreSQL and pgvector versions are captured without secrets or row content.

### Actual application-role RLS rehearsal

`apps/api/scripts/meriv2-phase18-rls-rehearsal.sh`

Using the real `capiro_app` login created by repository migrations, the rehearsal verifies:

- no tenant/user context is fail-closed;
- same-tenant insert/read succeeds;
- cross-tenant insert is rejected by RLS;
- cross-tenant update/delete targets remain invisible;
- a denied tenant's row remains unchanged;
- private memory is isolated by `app.current_user` inside the same tenant;
- every governed control table is RLS-enabled and RLS-forced.

The script uses fixed disposable fixture IDs and deletes them on exit.

### Application lifecycle and exact outbox rehearsal

`apps/api/scripts/meriv2-phase18-application-rehearsal.ts`

This script uses the real `PrismaService` and canonical services. Only external embedding/projection network calls are replaced with deterministic local stubs; transaction, row lock, authorization, migration trigger, RLS, and outbox state remain database-real.

It covers:

- shared proposal creation;
- self-review denial;
- concurrent independent approval with exactly one winner;
- canonical candidate-to-item lineage;
- private immediate activation and owner isolation;
- ethical-wall denial;
- denial when wall read access exists but governed review grant is missing;
- approval after an explicit, reasoned, expiring client review grant;
- Context Packet v2 compile, persistence, read-after-write, and exact packet ID;
- immutable shared correction and independent approval;
- contradiction, conflict group creation, and conflict resolution;
- revoke and restore as a new version;
- legal-hold destructive-operation denial;
- effective-tenant and impersonation-session transition evidence;
- durable job left after a simulated request-time projection failure;
- exact worker success;
- retry after projector failure;
- stale lease recovery;
- dead-letter transition at the attempt ceiling;
- rejection of a mismatched exact-version receipt;
- exact fast-path completion of one deletion obligation.

### Backfill verification and idempotency

`apps/api/scripts/meriv2-phase18-backfill-rehearsal.ts`

This supplements the existing drift-safe rollback script and verifies:

- prepare/dry-run changes no canonical row;
- execute converges exactly to the stored expected state;
- execute rerun returns `idempotent: true` and preserves that state;
- rollback restores the exact stored before state when no later drift exists;
- rollback rerun is idempotent;
- append-only events exist for the lifecycle.

The existing `apps/api/scripts/test-memory-governance-backfill-rollback.sh` remains in the matrix to prove later human drift is skipped rather than overwritten.

### Policy-pack lifecycle

The existing `apps/api/scripts/test-policy-pack-lifecycle-concurrency.sh` runs on both database shapes and proves:

- first-review concurrency serialization;
- owner self-review denial;
- independent second approval;
- reviewed decision material immutability;
- illegal transition denial;
- retire/rollback lifecycle behavior;
- non-production publication denial.

### Hosted workflow

`.github/workflows/meriv2-phase18-database-rehearsal.yml`

The workflow performs a frozen-lockfile install, generates all five Prisma clients, builds imported workspace packages, statically checks the rehearsal scripts, runs the complete disposable-database orchestrator, and uploads bounded evidence with 30-day retention.

It contains no AWS credential step, no production database URL, no feature-flag operation, and no shared-environment mutation command.

## Execution attempts

### Attempt 1

- Code SHA: `af7150137c1ea564c86394e1bba6516ffa3d6f6c`
- GitHub run: `30679806044`
- Result: `startup_failure`
- Jobs executed: **0**
- Database commands executed: **0**

### Attempt 2

- Code SHA: `aa1db401938ee2302b59a52f7087b227e557ec75`
- GitHub run: `30679856804`
- Result: `startup_failure`
- Jobs executed: **0**
- Database commands executed: **0**

Both attempts were registered under orphan workflow identity `324351375`, the same repository-level `BuildFailed` condition blocking prior hosted acceptance. Neither run is test evidence.

## Acceptance matrix

| Gate | Clean replay | Upgrade replay | Current result |
|---|---:|---:|---|
| Apply every migration in repository order | required | required | not executed |
| Prisma schema validate | required | required | not executed |
| Prisma migration status | required | required | not executed |
| `migrate diff --exit-code` | required | required | not executed |
| Tables/columns/defaults/indexes/checks | required | required | not executed |
| RLS enabled and forced | required | required | not executed |
| Actual application-role isolation | required | clean production-named DB | not executed |
| Governed-memory lifecycle | required | required | not executed |
| Exact outbox/retry/lease/dead-letter | required | required | not executed |
| Backfill dry-run/execute/verify/idempotency/rollback | required | required | not executed |
| Policy-pack lifecycle | required | required | not executed |
| Context Packet v2 persistence | required | required | not executed |
| No manual SQL repair | required | required | not established |

## Acceptance decision

**Phase 18 remains BLOCKED and must not be marked complete.**

Acceptance requires one exact synchronized SHA on which:

1. the hosted workflow runs real jobs, or the same orchestrator is run from an authenticated checkout;
2. both disposable database shapes complete successfully;
3. every gate artifact is preserved;
4. any drift output is explained and remediated rather than ignored;
5. no manual SQL repair is used;
6. the final PostgreSQL version, pgvector version, migration counts, commands, exit codes, and scenario counts are copied into this document;
7. PR #679 is updated with the successful evidence SHA and remains draft/unmerged.

## Rollback

No application or database rollback is needed for this attempt because no database rehearsal job started and no shared environment was touched.

For a successful future rehearsal, container destruction is the environment rollback. The production release strategy remains application rollback with additive schema retained; destructive down migrations are not the primary rollback path.
