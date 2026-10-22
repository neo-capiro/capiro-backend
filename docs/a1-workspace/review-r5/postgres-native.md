# Workspace native PostgreSQL qualification harness

Requested by Fable's bounded A1 correction in backend #105 comment
6342196826, with direct implementation authorization from Neo. This harness is
**Fable-run**. No database was reachable or contacted in this author's run.

## Recorded local result

The unchanged canonical Workspace Jest configuration collected
`test/ws03-postgres.int-spec.ts`: **37 skipped, 0 passed, 0 failed, 0 runtime-error
suites; exit 0**. Each name contains the explicit reason:
`A1_NATIVE_PG_URL is unset; disposable PostgreSQL 16 qualification is Fable-run.`
This proves collection and the no-database skip path, **not native acceptance**.

Command from the repository root:

```sh
node node_modules/jest/bin/jest.js --config apps/workspace/jest.config.cjs --runInBand --runTestsByPath apps/workspace/test/ws03-postgres.int-spec.ts --json --outputFile=/dev/shm/a1-r5-workspace-native/no-db-skip.json
```

This used the existing partial cached dependency/generated-client closure. The
raw local receipt is `/dev/shm/a1-r5-workspace-native/no-db-skip.json` and its
adjacent `.log`. Both new TypeScript files also transpile with zero syntax
diagnostics. Neither observation replaces the central clean-install gate.

A separate, serialized TypeScript semantic check included the new test entry
and native harness as roots, using the actual Workspace tsconfig options with
`rootDir: src` unchanged and no diagnostic suppression. It exited **2** with
**three TS6059 test-root boundary diagnostics only**; there were **zero other
diagnostics**, including zero native fixture/constructor/field errors. These
files intentionally live under the canonical Jest `test/` root, outside the
production build's `src` root. This is not a clean project typecheck. Command:
`node --max-old-space-size=1536 /dev/shm/a1-r5-workspace-native/semantic-check.cjs`.
The compact receipt and exact source hashes are in `postgres-native.json`;
the complete local compiler output is in `semantic-check.{json,log}` beside
the skip receipt. No database or application imports executed in that check.

## Native runner prerequisites

Follow `scripts/testing/a1-disposable-postgres.cjs` and its safety contract. Set
`A1_NATIVE_PG_URL` only to a newly provisioned disposable PostgreSQL 16 database
with the helper's required name and loopback endpoint, and set
`A1_NATIVE_PG_ALLOW_DISPOSABLE=1`. Never provide a live database, tunnel or
production credential. No `DATABASE_URL` fallback is accepted by this harness.
The database must support the extensions declared by the canonical Core schema.

Set `WS03_FRONTEND_CHECKOUT` to frontend #117 at
`67b71caaf5994465c5162c320cda02a3e588d413`, tree
`f27b5f7ede8ee5fc02cc025152da70d6ff68b455`. Install its locked test dependencies.
The runner checks that tree and that the exercised gateway/test files are
unchanged. No frontend production or test file is modified.

Generate the canonical Core and Workspace Prisma clients before running the
same Jest command above with those explicit native environment variables. The
helper creates a random owned schema, combines the canonical Core/Workspace
datamodels and invokes `prisma db push`; it never runs the broken migration
chain. Cleanup removes only that helper-owned schema.

`ws_source_action` exists only in a Workspace SQL migration and is absent from
both canonical Prisma datamodels. The disposable datamodel therefore appends
`test/support/ws-source-action.fixture.prisma`, mirroring the table columns and
primary key from
`20260913020000_legiwatch_preparation_actions/migration.sql`. No production schema
or migration is changed. This supplement does not reproduce the migration's
grants or immutable trigger. Offline validation of the merged datamodel passed
with 532 models and 45 enums; that is schema validation, not SQL execution.

## Coverage when Fable runs it

- The original 13 comments/checks/edit-lock/anonymization descendant routes each
  refuse an active, unrelated same-tenant member with 404, and each retains its
  owner positive path.
- The adjacent document list and quality-fix routes also refuse with 404. The
  three version paths retain their established 403 role refusal and positive
  owner paths; this harness does not change that policy.
- All 18 direct refusal cases assert no protected payload, no nominated full
  descendant fetch, no generation call and no descendant write. Native
  before/after snapshots cover drafts, documents, comments, locks, versions and
  proposals.
- The actual frozen frontend generic and typed gateways dispatch through local
  HTTP to the same native services. Seven existing frontend cases are selected:
  original-route unrelated refusal and owner access; three typed-comment owner
  positives; adjacent-route unrelated refusal and owner access. The remaining
  50 cases in that file are explicitly filtered and must not be counted as
  native passes. The seven cases expand to 42 gateway requests.

The native harness uses the real TenantGuard, PrismaOrgTenantResolver,
CollaboratorsService, descendant controllers/services, Prisma client and
PostgreSQL identity/draft rows. Only external Clerk token verification and
comment text generation are fixture providers. The unrelated actor has a real
active membership and no draft collaborator grant; a general authentication
refusal would be 403 and would fail the required 404 checks.

## Limits retained

`db push` does not install migration-authored RLS, grants or triggers. This is
not migration parity, native RLS qualification, concurrency/lock-contention
qualification, real Clerk signature validation, live browser/provider proof or
an image qualification. These ordinary draft fixtures have no client binding;
separate client-wall/source/prospect revocation and held-draft gates remain.
Prisma middleware counters cover nominated descendant reads; the existing
authority lookup legitimately selects config. No claim is made that every
content-bearing byte or every SQL statement was absent.

All native assertions remain unexecuted here. Frontend #117/#118 wait for the
corrected backend to be live. Review, image, clone migration and release holds
remain; this document is not a ship approval.
