# Phase 8 Defense API — Session 2 handoff (closeout)

## Status

- Workstream C implementation: complete and verified
- Workstream D implementation: complete and verified
- Disposable PostgreSQL migration/role/RLS rehearsal: **passing** (36 checks,
  `SESSION2_DB_REHEARSAL_PASS`), including `apps/defense-api`'s own
  database-backed `/readyz` acceptance tests
- Full frozen-lockfile/Nest/Prisma build: **passing**
- Docker build, non-root smoke test, entrypoint negative controls: **passing**
- Truth freeze: still blocked (unchanged — out of Session 2's scope)
- Production cutover: not authorized and not attempted
- Verdict: **SESSION2_COMPLETE**

## Repository coordinates

- Repository: `neo-capiro/capirov2`
- Recorded `main` at bundle time (historical only): `a03efaa2d96a973ace36d695d079aadeda2a6d3e`
- `main` this closeout actually branched from (verified via `git ls-remote` at
  closeout time): `f556e564aa459c0a2cb017ba109b4b28e8d1908c`
- Session 1 branch: `agent/phase8-session1-boundary-packages-v2`
- Session 1 head (verified via `git ls-remote` to match exactly): `3d318c716e8a8eea2f7bd96874f94f52809d1658`
- Closeout branch: `agent/phase8-session2-closeout`

The Session 1 packages (`packages/defense-contracts`, `packages/defense-domain`,
`packages/defense-client`) were confirmed absent from current `main` and were
restored from the Session 1 branch via `git restore --source=...` before
applying the Session 2 patch. The patch applied cleanly against current `main`
with no conflicts.

## Mandatory corrections applied in this closeout

1. **Migration ordering.** The migration was renamed from
   `20260817173000_phase8_defense_runtime_roles` (which sorted *before* the
   Phase 7 migration that creates `defense_budget_active_snapshot` and
   `defense_budget_canonical_snapshot`) to
   `20261120200000_phase8_defense_runtime_roles`, chosen to sort after the
   actual migration ledger tip (`20261120190000_retrieval_v2_exact_lexical_indexes`,
   288 migrations) rather than just after Phase 7. All workflow, verifier, and
   documentation references were updated to the new path.
2. **Active-snapshot model and `/readyz` query.** The Prisma model was
   corrected from an `Int @id` with only `snapshotId` to match the
   authoritative table exactly: UUID `id`, `domain`, `environment`, UUID
   `snapshot_id`, UUID `activation_id`, `updated_at`, unique
   `(domain, environment)`. `/readyz` now selects the pointer for the
   configured `(domain, environment)` — using the same
   `PE_SNAPSHOT_ENVIRONMENT`/`NODE_ENV` resolution convention as
   `PeSnapshotGateService` in `apps/api` — joined to
   `defense_budget_canonical_snapshot`, and requires `status = 'ACTIVE'`.
   `defense_budget_canonical_snapshot` was added to `capiro_defense_serve`'s
   read grants to make the join possible. Six database-backed acceptance
   scenarios were added and pass against a real database.
3. **RLS bypass removed.** `PrismaService.withSystem()` and its
   `app.bypass_rls` call are gone. Tenant/membership resolution before
   `app.current_tenant` is known — the one place that needed it — now calls
   three narrow SECURITY DEFINER SQL functions
   (`capiro_defense_resolve_tenant_by_clerk_org`,
   `capiro_defense_resolve_tenant_by_id`, `capiro_defense_has_active_membership`)
   added in the migration: locked `search_path`, minimum fields, no
   caller-supplied SQL, `EXECUTE` revoked from `PUBLIC` and granted only to
   `capiro_defense_serve`. `tenants`/`users`/`tenant_memberships` were removed
   from the capability roles' direct table grants (they were never reachable
   there anyway, since those tables carry `FORCE ROW LEVEL SECURITY`). A
   repo-wide static check (`scripts/verify-phase8-session2.mjs`) now rejects
   `app.bypass_rls`, `withSystem`, promoter credentials, and
   snapshot-activation code anywhere under `apps/defense-api` (excluding test
   files and comments, to avoid flagging the guards and negative tests that
   are themselves the point). `packages/auth`'s guard was not touched.
4. **Real login-role verification.** `/readyz`'s role check no longer trusts
   `pg_has_role(..., 'member')` alone. It also verifies the login has no
   SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE, or schema CREATE; is not a
   member of `capiro_pe_promoter`; cannot INSERT/UPDATE/DELETE
   `defense_budget_active_snapshot`; and holds no unexpected direct grants
   (`information_schema.role_table_grants` for the current login). The
   disposable-DB rehearsal separately proves that `ALTER ROLE
   capiro_defense_serve SET statement_timeout` does **not** propagate to a
   login that merely inherits membership — PostgreSQL applies role-level
   session defaults only to the role actually used to authenticate — and
   documents that production's bootstrap-roles process must apply the same
   `ALTER ROLE <login> SET ...` directly to the real login role.
5. **Disposable-DB rehearsal rebuilt from scratch.**
   `scripts/verify-phase8-session2-db.sh` (invoked via the unchanged
   `pnpm verify:phase8-session2:db` entry point) starts a disposable
   `pgvector/pgvector:pg16` container (or uses `REHEARSAL_DATABASE_URL` if
   already provided, e.g. a CI service), bootstraps extensions and
   `capiro_app` exactly like local dev's `docker/postgres/init/01-extensions.sql`,
   runs `prisma migrate deploy` from empty, creates real
   `p8s2_serve_rehearsal`/`p8s2_job_rehearsal`/`p8s2_main_api_rehearsal` login
   roles with production-shape capability grants, seeds two tenants and
   minimal Program Elements fixtures, and asserts — with a nonzero exit on any
   failure — all of: capability-role safety, real-login safety and timeout
   enforcement, the SECURITY DEFINER tenant functions, own-tenant reads/writes
   succeeding, foreign-tenant reads/writes failing, the serve/job table
   boundary (including that serve cannot touch job-only tables and vice
   versa), that neither role can create objects/alter tables/become the
   promoter, that the parser plane holds no database role, and a **guarded
   main-api cutover-revocation rehearsal exercised only inside this disposable
   database** (before: main-api login can mutate `program_element`; after
   `cutover-revoke-main-api.sql`: it cannot, but can still read). Finally it
   runs `apps/defense-api`'s own test suite with `REHEARSAL_DATABASE_URL`/
   `REHEARSAL_SERVE_URL` set, so the database-backed acceptance tests from
   correction 2 execute for real. Total: 36 checks, all passing.
6. **Real build/CI boundary.** `@capiro/auth`, `@capiro/defense-contracts`,
   `@capiro/defense-domain`, `@capiro/defense-client` all build cleanly.
   `@capiro/defense-api` prisma:validate/typecheck/test/build all pass. Fixed
   two real, unrelated bugs found along the way: `apps/defense-api`'s
   `request-context.middleware.ts` module augmentation needed
   `@types/express-serve-static-core` as an explicit devDependency (it was
   only a transitive dependency before, unresolvable under pnpm's strict
   linking), and the Dockerfile only copied 5 of 19 workspace members'
   `package.json` files, which left `pnpm-workspace.yaml`'s globs pointing at
   nothing for the rest and silently broke `packages/auth`'s own `typescript`
   devDependency resolution — this is why `packages/auth`'s `tsc` build failed
   with `MODULE_NOT_FOUND` inside the image even though `pnpm install
   --frozen-lockfile` "succeeded". The CI workflow
   (`.github/workflows/phase8-session2-boundary.yml`) now has three jobs:
   `build-and-verify` (static verifier, prisma:validate, typecheck, test,
   build, entrypoint negative controls), `db-rehearsal` (the disposable-DB
   script), and `docker` (image build, non-root smoke test, entrypoint
   rejection against the built image). Path filters now include root
   `package.json`/`pnpm-lock.yaml`, the renamed migration, the verifier
   scripts, and the boundary/handoff/ownership docs.
7. **Evidence and metadata corrected.** See below.

## Delivered

- `apps/defense-api` dark Nest scaffold
- shared Clerk/tenant resolver wiring via SECURITY DEFINER functions (no
  generic bypass)
- request context and JSON logging
- signed internal-service guard
- liveness and corrected mode-aware readiness (real domain/environment join,
  real login-safety check)
- custom Prisma subset matching the authoritative active-snapshot table
- safe entrypoint and non-root container
- additive defense serve/job role migration, correctly ordered
- deterministic, passing disposable-DB rehearsal (not a placeholder)
- guarded future cutover revoke template, rehearsed inside the disposable
  database
- static verifier (with a repo-wide RLS-bypass/promoter/snapshot-activation
  guard) and a three-job CI workflow
- machine-readable ownership record

## Commands (all pass; see evidence logs)

```bash
corepack enable
corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
pnpm install --frozen-lockfile
pnpm --filter @capiro/auth build
pnpm --filter @capiro/defense-contracts build
pnpm --filter @capiro/defense-domain build
pnpm --filter @capiro/defense-client build
pnpm verify:phase8-session2
pnpm --filter @capiro/defense-api prisma:validate
pnpm --filter @capiro/defense-api typecheck
pnpm --filter @capiro/defense-api test
pnpm --filter @capiro/defense-api build
pnpm verify:phase8-session2:db
docker build -f apps/defense-api/Dockerfile -t capiro-defense-api:phase8-session2 .
git diff --check
```

Notes from actually running these on this closeout's environment (Windows +
Docker Desktop/WSL2): `corepack prepare` failed with an `EPERM` writing to
`C:\Program Files\nodejs\pnpm` (a Windows permission issue, not a project
issue) — the already-installed global `pnpm@9.12.0` (matching the
root-declared `packageManager`) was used directly and produced identical
results. `prisma validate`/`generate` need `DATABASE_URL` present in the
environment even though they never connect; the CI workflow sets a
placeholder value for this reason, matching the repo's other Prisma-touching
CI jobs. `.dockerignore`'s `node_modules` exclusion was observed not to
reliably apply for nested package directories under this specific Docker
Desktop/WSL2/Windows-path configuration — a local host `node_modules` in a
copied package directory leaked into the build context with Windows-absolute
symlink targets. This is an environment artifact (a fresh CI checkout has no
`node_modules` at all, so the condition cannot occur there); it was
worked around locally by removing local `node_modules` from the five
directories the Dockerfile copies before building, which produced a clean,
reproducible build.

## Entry gate for Session 3

Before moving any Program Elements route or mutation:

1. confirm no unknown direct Program Elements consumer;
2. preserve the truth-freeze rule: no production read/ingestion cutover
   without an accepted canonical snapshot;
3. production's bootstrap-roles process must apply the same login-level
   `ALTER ROLE <login> SET statement_timeout/lock_timeout/idle_in_transaction_session_timeout`
   used for the rehearsal logins directly to the real
   `capiro_defense_serve`/`capiro_defense_job` login roles (see mandatory
   correction 4 above) — this is a deployment action, not something Session 2
   or 3's code can enforce by itself;
4. Session 3 is responsible for Program Elements routes, public traffic,
   ingestion schedules, production data ownership, and canonical promotion —
   none of which this session touches.

## Mutation statement

- Commit: not created (working tree only, pending user confirmation)
- Push: not performed
- PR: not created
- AWS mutation: none
- Shared/production migration applied: none — all migration/role/RLS
  verification ran only inside a disposable, locally-managed PostgreSQL
  container, destroyed after each run
- Production data accessed or changed: none
- Routing/schedule/IAM/secret change: none
- Snapshot activation or promotion: none (the disposable-DB fixtures used for
  the "valid active pointer" test exist only in the disposable container)
- `cutover-revoke-main-api.sql`: exercised only inside the disposable
  database's rehearsal; never applied to any shared or production database
