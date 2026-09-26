# Meri B1/B3/B6 exact-HEAD database requalification

Date: 2026-09-26 (America/New_York)

Status: local qualification passed; this is not deployment or live acceptance

Branch: `integration/meri-provisional-346-20260925`

Baseline under test: `ec10cbbdb`

## Scope

This package adds a checked-in, one-command rehearsal for the six migrated PostgreSQL B1/B3/B6
suites on one combined source tree. The rehearsal is disposable and loopback-only. It neither reads
nor changes a shared or production database.

Command:

```text
pnpm --filter @capiro/api run verify:meri-b1-b6-requalification:db
```

Harness: `apps/api/scripts/meri-b1-b6-requalification-rehearsal.ts`

## Database proof

The successful run used `pgvector/pgvector:pg16` and:

- created all legacy database names before applying the API ledger;
- applied the API ledger once to the pristine `b1_accept` database;
- observed the expected fail-closed error at
  `20280928050000_meri_phase4_route_operator` before applying the disposable test privilege
  baseline;
- revoked PUBLIC table, sequence, and non-extension function privileges, retained only the two
  required pgcrypto extension routine grants, marked the failed migration rolled back, and resumed;
- applied all **440** API migrations successfully;
- verified `440|0|f|0`: 440 completed migrations, no authority-owner memberships, no authority-owner
  `public` schema CREATE, and no PUBLIC non-extension routines;
- cloned the exact migrated database for the remaining fixtures instead of recreating cluster-global
  Phase 4 roles;
- applied all **61** intel migrations only to the randomly named B3 clone;
- used dedicated test-only principals and passwords for the B1, B6 research, B6 entity, and B6
  integrated suites;
- bound PostgreSQL only to loopback ports 5498, 55446, 55447, and 55448.

The exact container `capiro-meri-b1-b6-requalification` was removed by the harness `finally` block.
Post-run inspection found no matching container and no matching rehearsal process.

## Test result

All six suites and all 28 tests passed:

| Suite | Result | Evidence covered |
| --- | ---: | --- |
| `meri-b1-visibility.db.integration.spec.ts` | 6/6 | wall filtering before limits; omitted/explicit client paths; grant; known-ID access; revocation |
| `meri-v3-visual-analysis.wall.db.integration.spec.ts` | 3/3 | unwalled/null-client success; user/admin denial before sandbox; revocation during computation |
| `funding-opportunity-v2-search.http.integration.spec.ts` | 5/5 | six-source controller path; repeated profile keywords; client visibility; capability independence; honest health/disabled state |
| `meri-research-evidence.db.integration.spec.ts` | 7/7 | provenance/paging; identity and wall denials; attachment/source/byte drift; cursor binding; truncation; unavailable handoff; guarded HTTP |
| `meri-b6-entity.db.integration.spec.ts` | 4/4 | persisted federal provenance; canonical IDs; state-session ambiguity; null/absent identities |
| `meri-b6-integrated.db.integration.spec.ts` | 3/3 | DB-to-guarded-tool-to-V3 exact values; qualified bill; oversized-result limitation |

Observed Jest wall times were approximately 161, 182, 158, 158, 170, and 171 seconds,
respectively. Each suite ran serially with a 4 GiB Node heap.

## Defect found and corrected

The first full attempt passed B1 6/6 but suite 2 failed during ts-jest compilation. The helper's
default `conversationId` parameter had been inferred as Node's UUID template-literal return type,
while the ID selected through Prisma was correctly typed as `string`.

The test helper now explicitly accepts `conversationId: string`. This is test-only typing; it does
not widen a runtime authorization or persistence boundary. The complete rehearsal was rerun from a
new disposable container after the correction and passed as recorded above.

Two earlier development iterations corrected harness setup rather than product behavior:

- all legacy database names are created before the API migration ledger because an older migration
  expects the `capiro` database;
- the API ledger is applied once and cloned because the Phase 4 authority roles are cluster-global.

## Boundary

This result closes the six-suite migrated-database portion of local exact-HEAD B1/B3/B6
requalification for this package. It does not prove:

- deployed B1-B6 behavior or factual-answer accuracy;
- ordinary-user B1 acceptance in the sole production environment;
- production PUBLIC privilege reconciliation or migration-executor safety;
- Phase 4 activation, caller/reconciler ownership, effect receipts, topology, durability, backup, or
  rollback;
- Phase 5 adjudication, Phase 6 live evidence, or legacy-retirement observation.

No deployment, activation, production database operation, provider call, browser QA, or Hermes
session occurred in this package.
