# A1 R5: native Mail and migration fixtures

Base: `backend-import` `efd03f1997ef61b99bee315706f39dc1fa341f54`. Prior remote #106 head: `89f99aa7c61be8596cc11af48a2711100a20ff9e`.

The requested native tests are supplied. **No PostgreSQL/native case or SQL ran here. Native qualification is Fable-run and remains open.** The machine has no disposable PostgreSQL runtime, and the cached canonical API Jest environment cannot start because `sanitize-html` is absent. This is not a green native or canonical Jest receipt.

## Mailbox cases

`apps/api/src/engagement/mailbox-collision.postgres.spec.ts` defines six cases: Graph, Gmail backfill and Gmail incremental, each with upsert and removal. Each case:

1. Seeds a real tenant, active membership, connected mailbox and retained mail rows through the real Core Prisma client.
2. Calls production OAuth `disconnect`; verifies the actual foreign-key `ON DELETE SET NULL` effects, with every other old-row field preserved.
3. Calls production Add/start and callback for the same provider account, obtaining a different connection ID. Signed state, membership admission, row/advisory locks and token writes remain real.
4. Calls production public `syncConnectionByTenant` with provider fixtures containing the colliding old message followed by valid new mail.
5. Requires one held message, a fixed redacted warning, unchanged old rows, fresh mail on the new connection and the advanced cursor/held count in the committed connection row.

Provider exchange/response, token encryption and association-scoring ports are fixtures. Persistence, reads, transactions, token identity admission and sync control flow are real. No new email, recovery, reservation or production behavior is added.

## PF-12 migration cases

`meeting-debrief-approval-migration.postgres.spec.ts` defines nine native cases for the specified additive migration: absent columns; repeated application with existing values; matching unvalidated FK; four incompatible column shapes; incompatible delete action; and an orphan approver. It checks preservation, exact FK identity/actions, validation and refusal without rewriting existing data. Fixture-only old-schema alterations occur inside disposable transactions and roll back.

## Disposable setup and invocation

The common `scripts/testing/a1-disposable-postgres.cjs` requires both `A1_NATIVE_PG_ALLOW_DISPOSABLE=1` and an explicit `A1_NATIVE_PG_URL` naming a loopback PostgreSQL16 database with the `a1_disposable_<nonce>` prefix. It never uses the inherited/default `DATABASE_URL`. Each suite creates a random owned schema and builds it with `prisma db push` from `apps/api/prisma/schema.prisma`, avoiding the inherited migration-chain failure. The runner must provide PostgreSQL16 with the schema's required extensions, including pgvector.

When the dedicated URL is absent or the disposable server is unreachable, the suite title carries an explicit skip reason and Fable-run attribution. Invalid/unsafe configuration fails closed. No skipped native case counts as a pass. Runtime Mail service imports are deferred until the native opt-in setup.

After supplying the dedicated disposable environment, run from the repository root:

```sh
node node_modules/jest/bin/jest.js --config apps/api/jest.config.cjs --runInBand --runTestsByPath apps/api/src/engagement/mailbox-collision.postgres.spec.ts apps/api/src/engagement/meeting-debrief-approval-migration.postgres.spec.ts --json --outputFile=/tmp/a1-native-mail.json
```

`db push` does not install migration-owned RLS policies/triggers. These tests are native storage/foreign-key/transaction proof, not a substitute for the separate RLS, concurrency, real-provider, browser or exact-image gates.

## Local evidence

- Canonical mailbox Jest attempt: **0 tests collected, 0 passed, 0 skipped**, one runtime-error suite. Startup failed in `jest.native-runtime-environment.cjs` on missing cached `sanitize-html`. The migration suite was not separately retried against the same broken environment.
- Targeted strict compiler: actual `apps/api/tsconfig.json` options, the three new native test roots, real transitive imports, and the exact regenerated #106 Prisma client. **Zero diagnostics in the three native files.** Two existing transitive missing-`@azure/msal-node` diagnostics remain. The evidence driver exits0 for zero changed-file diagnostics; this is **not** a clean full-project typecheck/build pass.
- Host Node `v24.19.0`, reused dependency closure, Prisma `5.22.0`. No dependency or Jest configuration change. This is not Fable's pinned clean-install recipe.
- Initial compiler found four private-class `Object.assign` intersection typing errors; explicit service return shapes corrected them. The final exact-client check completed before a requested termination during memory pressure; its complete JSON and exit0 were retained. Exact-client generation succeeded after two parent-reported resource-killed attempts. Neither generation nor compilation ran SQL.

Machine-readable diagnostics, commands, setup disclosures and source hashes: `review-r5-native.json`. Raw local receipts are `/dev/shm/a1-r5-mail-native/{skipped.json,skipped.log,typecheck.json,typecheck-final.json,typecheck-final.log,typecheck-final.exit}`.

Dot must re-review the exact published heads before updated ship requests. Clean frozen closure/build/parity, actual PostgreSQL16 execution, image/clone/migration qualification and release gates remain. Frontend #117/#118 wait for the corrected backend to be live. No merge, deploy or live-database action occurred.
