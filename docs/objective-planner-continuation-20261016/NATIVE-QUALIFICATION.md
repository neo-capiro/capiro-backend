# Objective Planner native qualification

The allocated kernel increment adds seven native Core cases beside the existing
runtime suite. The owned runner now requires an explicit 40-hex
`ReviewedSourceHead`, a clean checkout at exactly that published pin, and the
same guarded local target, focused SQL, restricted roles, budgets and cleanup.
The checkout directory retains its historical `objective-native-b8` name; the
manifest and actual checked HEAD determine the qualified source. The runner
type-checks the server codec from that source and executes its task-owned build,
without mutating borrowed dependency outputs. Both native suites and the new
schema-2 fixture source checks run in default-off preflight before credentials
or SQL setup. The final enabled result and exact source pin are recorded in the
PR body and task qualification receipt; no post-test source commit is implied.

The new cases cover actual Core applied status, real Objective edit/ready
advancement, concrete owner/kernel/new Planner consent and exact receipt replay;
same-source/Strategy refusal; uncertain leased history; native membership/wall
revocation; real consent/receipt transaction rollback on synthetic request-proof
release loss; and new Planner consent through saved schema-2 generation to v3
runtime application. Objective mutation, Planner consent, native records and
runtime SQL are actual. The request-proof adapter, separately seeded Strategy
generation consent and Meri/provider custody observations are explicitly
synthetic. These cases do not qualify real HTTP/token admission, an operational
Strategy retry/issuer/SDK path or frontend receiving behavior.

The additional historical case uses a real committed lease, Core cancellation,
runtime terminal accounting and subsequent Core consent/read to exercise native
historical lineage. Immutable ledger UPDATE/DELETE privileges are explicitly
checked through the application role before positive Core proof reads.

The first final-source attempt at `3ebecd93f3d5a99e1d9346b2710a3605591ed9d3`
passed all 13 offline preflight checks, then refused all 18 enabled cases at the
read-only catalog identity guard before fixture writes. Its owned cluster and
credentials were retired. The schema-1 guard incorrectly equated the PID-file
startup second with the later catalog startup second. PostgreSQL 16 assigns
`MyStartTime` early and records it in `postmaster.pid`, then separately assigns
`PgStartTime` later during startup ([postmaster source](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/postmaster/postmaster.c),
[PID-file source](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/utils/init/miscinit.c)).
The schema-2 ownership manifest captures both exact observations independently.
The filesystem guard still requires the original PID-file timestamp; the catalog
guard requires its separately captured timestamp. No timestamp tolerance is
introduced, and their order must be PID-file time <= catalog time <= manifest
creation. The prior failed attempt remains evidence of refusal, not application
qualification. Final successor results belong to their exact published pin.

The next attempt at `a82e49b1d6c0949b898b914840ece813008fe2e7` passed the
ownership fence, all 13 offline checks and all twelve existing native runtime
cases. Three new Core cases failed, giving 16/19 total including default-off.
The sanitized server log identified permission denial on immutable work intents:
the new proof queries requested `FOR SHARE` on immutable intents and revisions,
while the exact migrations intentionally revoke UPDATE/DELETE. PostgreSQL row
locking also requires UPDATE privilege ([SELECT permissions](https://www.postgresql.org/docs/16/sql-select.html)).
Applied and historical proof reads now lock only mutable membership/user rows;
all immutable joins and lineage validation remain intact. The regeneration test
helper likewise locks only its mutable control/canonical rows. No grant,
migration, immutable trigger or proof expectation is relaxed. Direct applied and
historical proof regressions pass 34/34 and 44/44. The failed attempt and verified
owned cleanup are retained separately; they do not establish full native Core
qualification. The final exact-pin result is recorded after execution.

## Prior parent-source qualification

The pinned parent source `b8b7262aa0ae8b4d9ef30e75df41b147b2d6e3cf`
passed **12 native PostgreSQL cases plus the default-off check (13/13)** on
2026-10-17. This is a focused local qualification of that parent, not of the later
shared-codec, positive Core status, regeneration or historical-terminal source.
With `OBJECTIVE_PLANNER_NATIVE_OPT_IN` absent, the native suite still skips
before reading a target manifest, probing a process or constructing Prisma.

Automatic review initially denied disposable credentials/schema setup before
process creation. Neo explicitly approved those local-only actions at
2026-10-17 00:36:33 UTC. An approved attempt then exposed a Windows daemon-output
pipe stall after PostgreSQL startup and before schema setup; its exact owned
cluster was stopped and removed. The original runner was preserved. Independent
review accepted the narrow bounded-output/start fix at runner SHA256
`cd8ff0c25c9bff978e665c39a8df3d364bfabd10c85c387c30c935918a2a7ddb`.
The next normally approved run completed. Process-only Git trust was limited to
the exact native worktree and restored afterward; no global Git or ACL changed.

The executed runner pinned published source
`b8b7262aa0ae8b4d9ef30e75df41b147b2d6e3cf` and reserves only
`127.0.0.1:56455`. Its 38 hashed SQL units form an explicitly focused Core
baseline plus all 28 Strategy and six Objective migrations. Installed
`uuid-ossp`, `citext` and `pg_trgm` were activated inside that new database;
the unavailable vector extension was omitted. This is not whole Core migration
replay or qualification of a later source successor. The separate NOLOGIN DDL
owner created the focused schema; tests ran as `capiro_app`, with no owner
membership, superuser status or BYPASSRLS. The guarded native cases verified
effective tenant isolation and immutable revision privileges through that role.

The sanitized run evidence is retained in the task workspace under
`objective-planner-native-evidence/90ac1a229e664ccab6c2ad82be69813e`.
`outcome.json` records suite exit 0 and the exact source pin; the separate final
`cleanup.json` confirms cluster removal, listener removal and credential
retirement. Fresh checks confirmed the recorded postmaster PID was gone, the
owned root was absent, port 56455 had no listener and both existing host port
5432 listeners were unchanged. The native checkout remained clean. No AWS,
application database, task3 checkout or production credential was changed.

## Offline checks

Run from the repository root using the existing dependency installation and the
normally built `@capiro/shared/objective-planner-owner-codec` subpath from this
exact checkout:

```powershell
node --test apps/api-strategy/test/objective-planner-native-target.focused.test.mjs
node apps/api-strategy/node_modules/jest/bin/jest.js --config apps/api-strategy/jest.config.cjs --runInBand --runTestsByPath apps/api-strategy/test/objective-planner-native-fixture.spec.ts apps/api-strategy/test/objective-planner-continuation.db.int-spec.ts
```

This task borrowed a read-only dependency tree. Its source checks mapped the new
server-only subpath to task-owned source/compiled output with temporary Jest and
TypeScript configuration. They did not rebuild or mutate borrowed package
outputs. The checked-in Node source suites use
`--import ./apps/api/test/objective-planner-shared-codec.preload.mjs` for that
subpath's real source.

The ownership guard checks are pure. Fixture checks import the actual request,
completion, normalization, producer and retained-generation code without source
rewrites, over an explicitly synthetic transaction. These checks qualify fixture
construction and source composition; they do not execute the fixture SQL or prove
PostgreSQL constraints, permissions, locks or concurrency.

The native fixture builder owns all synthetic tenant, user, membership, client,
wall grant, ready Objective/revision/intent, canonical reservation, and both
separate action consent/control/command-receipt sets. It then uses the actual
normalization and producer writers, exact saved Strategy/version and five private
generation ledgers. It reconstructs the saved generation through the real reader
before returning the Planner work. There is no external seeded fixture to obtain.
The retained Meri observation is explicitly synthetic test data; it makes no
provider execution, issuer or genuine SDK custody claim.

## Native target prerequisite

Native execution requires a separately authorized, task-owned PostgreSQL 16
cluster with the existing Core and Strategy baseline schemas already applied.
The suite provisions no cluster, schema, role, credential or migration. It never
uses the machine's shared PostgreSQL service or the root `docker-compose.yml`.
The target must use a non-5432 loopback port and database `planner_qa`.

All of these must be present before the suite will construct Prisma:

- `OBJECTIVE_PLANNER_NATIVE_OPT_IN=1` and `CI_DISPOSABLE_POSTGRES=1`.
- Explicit `OBJECTIVE_PLANNER_NATIVE_DATABASE_URL`, with PostgreSQL protocol,
  loopback host, explicit non-5432 port, nonempty test-only credentials and exact
  `/planner_qa` path. Query strings and fragments are rejected.
- No inherited `DATABASE_URL` or libpq target/service/options/credential variables.
- Committed, clean application source under `apps`, `packages` and `scripts`.
- A closed schema-2 ownership manifest at
  `.objective-planner-native/owned-target.json`, matching the exact current source
  commit and workspace. Its type is `ObjectivePlannerNativeManifest` in
  `test/objective-planner-native-target.ts`.
- A real data directory at exactly
  `<workspace>/.objective-planner-native/postgres-data`. Realpaths, `PG_VERSION`,
  `postmaster.pid`, PID existence, original process start, port and loopback-only
  listen addresses must agree with the manifest. The manifest lasts at most 24
  hours and must still be current.

After connection, a read-only catalog query checks the exact database OID, name,
runtime role, server port and separately captured catalog postmaster start
instant. The database comment must
equal `task-owned:objective-planner-native:<ownershipToken>`. A superuser or
`BYPASSRLS` runtime role is rejected. This check repeats before each new synthetic
fixture. No fixture writes happen until it passes.

Ownership metadata is supplied by the owner of that disposable cluster. A flag,
nonstandard port or database name alone is insufficient. Test credentials must
remain outside committed source and evidence output.

## Passed parent-source native cases and limits

The twelve native cases call the actual `ObjectivePlannerContinuationRuntime`,
application owner, Planner owner, store, native consent fences and generated
Prisma client. They cover:

1. Discovery from a durable completed generation without a browser, paired
   application receipt/output/accounting, and the unchanged original deadline.
2. Two independent clients competing for the same operation and output set.
3. A deliberate throw after actual application writes and before accounting,
   proving rollback of outputs, receipt and head while retaining the prior lease.
4. A deliberately discarded committed caller reply, then recovery by a fresh
   runtime with the original operation, attempt, run and deadline identities.
5. Expiry after the actual operation accounting CAS, using a bounded native
   sleep and DB clock, rolling back outputs/accounting at the final release fence.
6. Expired original Planner consent refusing a new effect.
7. Human Planner project/task edits surviving retained recovery.
8. Actual reciprocal Planner consent cancellation before an effect.
9. Current native membership and client-wall revocation refusing retained reads.
10. Tenant opt-out despite process opt-in.
11. The reserved generation delegation's `enabled=false` database constraint
    continuing to refuse enablement.
12. Raw tenant isolation, effective immutable-revision privileges and Planner
    resource `FORCE ROW LEVEL SECURITY` through the actual runtime role.

The discarded-reply case does not inject a PostgreSQL socket or commit-ack
failure. Real transport failure, whole migration replay and deployed role/session
composition require their own native evidence. Private generation/operation
resources retain application-owned mutation rules; this suite does not invent a
database append-only guarantee for generic `sp_planner_resources` rows.

Fixtures use randomized, dedicated synthetic tenants and retain their audit
history until cluster retirement. The suite disconnects its clients without
purging individual audit records. The runner subsequently retired only its
verified owned disposable cluster and test credentials.
