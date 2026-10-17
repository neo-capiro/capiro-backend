# Prepared Objective Planner native qualification

The native suite is prepared source, not a native acceptance result. It has not
opened PostgreSQL or applied a migration. With `OBJECTIVE_PLANNER_NATIVE_OPT_IN`
absent, the native suite skips before reading a target manifest, probing a process
or constructing a Prisma client. Its ordinary default-off startup check still
runs without a database.

## Offline checks

Run from the repository root using the existing dependency installation:

```powershell
node --test apps/api-strategy/test/objective-planner-native-target.focused.test.mjs
node apps/api-strategy/node_modules/jest/bin/jest.js --config apps/api-strategy/jest.config.cjs --runInBand --runTestsByPath apps/api-strategy/test/objective-planner-native-fixture.spec.ts apps/api-strategy/test/objective-planner-continuation.db.int-spec.ts
```

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
- A closed ownership manifest at
  `.objective-planner-native/owned-target.json`, matching the exact current source
  commit and workspace. Its type is `ObjectivePlannerNativeManifest` in
  `test/objective-planner-native-target.ts`.
- A real data directory at exactly
  `<workspace>/.objective-planner-native/postgres-data`. Realpaths, `PG_VERSION`,
  `postmaster.pid`, PID existence, original process start, port and loopback-only
  listen addresses must agree with the manifest. The manifest lasts at most 24
  hours and must still be current.

After connection, a read-only catalog query checks the exact database OID, name,
runtime role, server port and postmaster start instant. The database comment must
equal `task-owned:objective-planner-native:<ownershipToken>`. A superuser or
`BYPASSRLS` runtime role is rejected. This check repeats before each new synthetic
fixture. No fixture writes happen until it passes.

Ownership metadata is supplied by the owner of that disposable cluster. A flag,
nonstandard port or database name alone is insufficient. Test credentials must
remain outside committed source and evidence output.

## Prepared native cases and limits

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
history. The suite disconnects its clients but does not purge audit records or
drop databases. Retiring the separately owned cluster remains its owner's exact
resource cleanup action.
