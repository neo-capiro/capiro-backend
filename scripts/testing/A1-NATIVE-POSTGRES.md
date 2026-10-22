# A1 disposable PostgreSQL qualification

These are **Fable-run operator tests**, not release clearance. Run only against a **new local throwaway PostgreSQL 16 instance with pgvector**. Never supply a live, shared, preview or forwarded production database. Do not use the inherited migration chain: its fresh-database failure is a separate gate.

## Prepare the disposable target

Use the pinned backend recipe (`node:22.23.3-alpine3.24`, pnpm 9.12.0, frozen install) and the repository's existing package builds/Prisma generation. The helper accepts only:

- `A1_NATIVE_PG_URL`: `postgresql://<disposable-user>:<disposable-password>@127.0.0.1:<explicit-port>/a1_disposable_<nonce>`. The nonce is 8–48 lowercase letters, digits or underscores. IPv6 loopback and `localhost` are also accepted; the port must be 1024–65535. No URL query or fragment is accepted.
- `A1_NATIVE_PG_ALLOW_DISPOSABLE=1`: the operator's explicit disposable-target opt-in.
- PostgreSQL major version 16 and the exact named database. The Core datamodel requires the `vector`, `pg_trgm`, `citext` and `uuid-ossp` extensions.

`DATABASE_URL`, `PGHOST` and other ordinary database settings are **not** fallback targets. The database name is a safety check, not permission to rename or use an existing database. Provision a new local instance and database first; use only its new credentials. If the test runner is containerized, run it in the disposable database container's network namespace so `127.0.0.1` addresses that instance. Do not introduce a production tunnel.

Each suite creates its own random `a1_native_<nonce>` schema, records an ownership marker and runs `prisma db push --skip-generate` into that schema. Setup uses the checked-in Core datamodel; Workspace adds its datamodel and the fixture-only `ws_source_action` model. The helper does not use `migrate deploy`, `--force-reset` or `--accept-data-loss`. Cleanup refuses a schema without its exact ownership marker. Remove the operator-owned disposable instance after all test clients have stopped, including after a failed run.

## Prepare the exact sources

Use the corrected backend PR heads, or Fable's recorded combined tree. Install their existing locked dependencies and generate both clients before running the relevant native suite:

```sh
pnpm install --frozen-lockfile
DATABASE_URL="$A1_NATIVE_PG_URL" pnpm -C apps/api exec prisma generate --schema prisma/schema.prisma
DATABASE_URL="$A1_NATIVE_PG_URL" pnpm -C apps/workspace exec prisma generate --schema prisma/schema.prisma
```

Generation does not build a database. The integration helper performs the disposable-schema `db push` during setup. Do not run a manual `db push` against the database's default schema.

For Workspace's real gateway child, provide an absolute `WS03_FRONTEND_CHECKOUT` pointing to unchanged frontend #117 head **`67b71caaf5994465c5162c320cda02a3e588d413`**, tree **`f27b5f7ede8ee5fc02cc025152da70d6ff68b455`**. Prepare that checkout's locked dependencies (`npm ci --ignore-scripts`) and existing `@capiro/meri-client` build; do not edit its sources or configuration. The test verifies the tree and the exercised files before launching the existing Vitest test file. Frontend #117/#118 remain held until the corrected backend is live.

## Canonical Jest commands

From the backend repository root, after setting the explicit disposable variables above:

```sh
# On #106 or the combined tree: six mailbox cases and nine PF-12 cases.
pnpm -C apps/api exec jest --config jest.config.cjs --runInBand --runTestsByPath \
  src/engagement/mailbox-collision.postgres.spec.ts \
  src/engagement/meeting-debrief-approval-migration.postgres.spec.ts

# On #105 or the combined tree, with WS03_FRONTEND_CHECKOUT set.
pnpm -C apps/workspace exec jest --config jest.config.cjs --runInBand --runTestsByPath \
  test/ws03-postgres.int-spec.ts
```

Record exact backend/frontend heads and trees, commands, process exits, passed/failed/skipped counts and failures. A missing or unreachable disposable database produces an explicit skip reason. **Skipped cases are not native passes.** An unsafe supplied URL, wrong PostgreSQL version, authentication/configuration error or failed schema setup fails qualification rather than silently skipping it.

## What the suites are intended to check

- **Mailbox: 6 Jest cases.** Graph, Gmail backfill and Gmail incremental each exercise upsert and removal collisions after real production disconnect/re-add flows. Database reads, FK `SET NULL`, transactions, held counts, later valid writes and persisted cursors are native. Provider responses and external token/crypto ports are test substitutes; this is not real-provider qualification.
- **PF-12: 9 Jest cases.** The full Core schema is created with `db push`; rollback-scoped changes inside the owned schema model absent/matching/mismatched columns and relationships. The numbered migration is applied to those fixtures, including repeated application, wrong shape/FK and invalid actor validation. These tests never apply it to an application database.
- **Workspace: 37 Jest cases.** Eighteen direct refusals, eighteen owner controls and one joined gateway case. The original thirteen descendant routes plus document/quality admission use opaque404; the three version routes retain their existing403 policy. The joined case runs **7 selected frontend cases with 50 explicitly filtered**, using the frozen generic and typed gateways against the native Workspace fixture. Real TenantGuard/current identity SQL and Prisma services run; the external Clerk verifier is a fixture. Refused operations compare native storage snapshots and nominated descendant reads/effects.

`db push` does **not** recreate migration-owned RLS policies, grants, triggers or concurrency guarantees. The fixture-only `ws_source_action` datamodel mirrors its table shape, not its immutable trigger or grants. These tests do not clear native RLS/grant/trigger, provider, live identity, concurrency, image, fresh-clone migration or deployment gates. Authority lookups may read content-bearing config; nominated-operation counters do not prove zero content-bearing bytes in every query.

## Local author evidence

No database was reached locally and no native test pass is claimed. The shared helper's **24 safety checks passed** without database/network access. The combined Core/Workspace/fixture datamodel passed cached Prisma validation (532 models, 45 enums). Those are setup/source checks, not PostgreSQL qualification or release-gate passes. The operator must run the native suites and retain their own exact-head receipts.
