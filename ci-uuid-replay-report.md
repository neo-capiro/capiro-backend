# Bounded client-intel UUID dedup replay repair

## Scope

- Base: `5f63b98d0951953ed31d8f85a3eafb7541f0a7c2`
- Branch: `codex/meri-ci-uuid-replay`
- Source failure: GitHub Actions run `36368117824`, migration `20281003010000_dedup_client_intel_mapping`, PostgreSQL error `42883` (`min(uuid)` is undefined).
- Changed application SQL only in the existing migration directory; the migration was not renamed.
- Added `scripts/ci/client-intel-dedup-replay.test.mjs` for PGlite CI coverage and opt-in owned-local PostgreSQL coverage.

## SQL repair

The migration now ranks each `(client_id, source, external_id)` group by UUID and deletes ranks greater than one. It deterministically retains the lowest UUID. UUID ordering is only the retention rule and does not prove creation chronology.

Raw migration SQL SHA-256:

- Before, from base `5f63b98d0`: `3f982ab8d2a7dea5ee37cf738317b9eaf4b2b16f248309ff9a1d6968074ee724`
- After, LF-only: `57352c011c97da81e38b8b6601b9331198f02209a0587206e3d2724f7ea2117c`

No UUID aggregate was installed, no migration or gate was skipped, and no checksum bypass was added.

## Replay evidence

The test reads the exact original migration SQL from base `5f63b98d0` and asserts PostgreSQL code `42883`. It then executes the checked-in repaired SQL against unordered fixtures and verifies:

- one row remains for each distinct group;
- the lowest UUID remains for duplicate groups;
- a singleton remains unchanged;
- duplicate rows whose nullable `external_id` is `NULL` form one group and retain the lowest UUID;
- a second repaired-SQL execution is idempotent;
- the generated schema is absent after transaction rollback.

Before any local PostgreSQL mutation, the test rejects credential configuration outside the fixed owned-local host, port, user, and database, connects without constructing or printing a URL, and verifies the server-reported host, port, user, and database. The credential password is read programmatically and is not logged or committed.

## Commands and exits

- `CLIENT_INTEL_DEDUP_POSTGRES_CONFIG='C:/dev/cap-meri-foundation-evidence/private/local-postgres.json' node --test scripts/ci/client-intel-dedup-replay.test.mjs` — exit `0`; PGlite and owned-local PostgreSQL tests passed (`2/2`).
- `node --test scripts/ci/*.test.mjs` — exit `0`; all CI script tests passed (`15/15`), including offline PGlite replay.
- `node scripts/check-migration-timestamps.mjs --base 5f63b98d0` — exit `0`; migration timestamp guard passed.
- `./node_modules/.bin/prettier --check scripts/ci/client-intel-dedup-replay.test.mjs` — exit `0`.
- `git diff --check` — exit `0`.
- `sha256sum apps/api/prisma/migrations/20281003010000_dedup_client_intel_mapping/migration.sql` — exit `0`; returned the after hash above.

## Qualification boundary

This is a bounded SQL regression repair. It does not claim a full migration replay, a live-environment qualification, or any AWS/remote database validation. No provider, deployment, push, merge, or live database action was performed. The only database execution was PGlite in memory and the fixed owned local PostgreSQL cluster, using a generated schema inside a rolled-back transaction.
