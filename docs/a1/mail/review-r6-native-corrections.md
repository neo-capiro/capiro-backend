# A1 R6: typed advisory-lock results and migration fixture

Bounded correction requested in backend #106 comments
[6344103647](https://github.com/neo-capiro/capiro-backend/pull/106#issuecomment-6344103647)
and [6344115433](https://github.com/neo-capiro/capiro-backend/pull/106#issuecomment-6344115433).
Prior published head: `3ec8aa105dbf0d623e0a553276da79f6a4e51d74`, tree
`c6df4d67d26f65b1c0bfa6dd1d36fbe218dc745b`, based on `efd03f19`.

## Corrections

Both advisory-lock statements in `mailbox-oauth-authority.ts` now use
`SELECT 1 FROM pg_advisory_xact_lock(...)`. Prisma receives an integer column
instead of a `void` column. The existing awaited transaction client, lock
function, hash inputs, hash seed, ordering and authority checks are unchanged.
This covers both Add placeholder serialization and duplicate-account callback
serialization. No error is caught or suppressed.

The migration test's tenant fixture now binds `slug` and `name` through separate
`$2` and `$3` parameters with the same existing string value. PostgreSQL can infer
each column's type independently. All nine cases and their assertions remain.
The six native mailbox cases are byte-identical to the prior head.

The production migration is **unchanged**, SHA-256:
`96e39a78f3139045649abf5f48f990f3d56f02708719d3e241693c31eb5f002d`.
No new migration, dependency, test configuration, guard or recovery behavior.

## Local verification

- Existing focused OAuth/Add suites: **53/53 pass in two suites**, exit 0,
  zero failed/skipped/runtime-error suites. These use the unchanged historical
  focused config, cached dependencies, transpile-only ts-jest and mocked ports;
  they do not reproduce Prisma's PostgreSQL result decoding or qualify native
  locking. Canonical full-suite or clean-install parity is not claimed.
- Both changed TypeScript files transpile with zero syntax diagnostics. This is
  not a full semantic typecheck/build.
- Exact-byte comparison proves the source delta consists only of two typed
  projections and one fixture statement; lock-key/transaction expressions and
  all native assertions are unchanged. `git diff --check` passes.
- Independent read-only review found no blocker in this bounded delta; no tests
  or SQL were run by that reviewer.

Focused command from the repository root:

```sh
node --max-old-space-size=1024 node_modules/jest/bin/jest.js --config docs/a1/mail/jest.config.cjs --runInBand --runTestsByPath apps/api/src/engagement/mailbox-oauth.a1.spec.ts apps/api/src/engagement/mailbox-oauth.add-reuse.spec.ts --json --outputFile=/dev/shm/a1-r6-mail/oauth.json
```

Native execution is **unrun / Fable-run**. Local preflight found no `docker`,
`postgres` or `psql` executable, and `A1_NATIVE_PG_URL` is unset. The cached
canonical API runtime still cannot resolve `sanitize-html`; the known startup
failure was not rerun or bypassed. No native skips or passes are claimed for R6.
No database was contacted and no SQL was executed.

The existing disposable-only runner contract and native commands remain in
`scripts/testing/A1-NATIVE-POSTGRES.md`. Re-gate the unchanged six mailbox cases
and all nine migration cases on the already authorized isolated PostgreSQL16
schema. Never use a live database or an inherited/default database URL.

## Attributed prior gates and remaining holds

Fable reported clean-install/base-head non-regression parity at R5, combined
Workspace native 37/37, native Mail 0/6 and migration fixture 4/9. His separate
forward migration runs passed for both pre-existing and absent columns, including
repeat application. Those are prior-head operator receipts, not R6 acceptance.

Dot's exact-head delta review and Fable's native re-gate remain required. Current
cutover/release holds remain. Frontend #117/#118 wait until the corrected backend
is live; live acceptance remains stopped at 2/6 shared turns. No merge,
deployment, production SQL, new email functionality or Wave 2 work.
