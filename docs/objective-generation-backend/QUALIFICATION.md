# Bounded Objective generation source qualification

This is application source and non-live fixture qualification. It does not claim
deployed operation, provider execution, PostgreSQL concurrency qualification,
frontend receiving, activation, or Planner materialization.

## Evidence and limits

- Eight focused suites, 198 tests pass. They exercise the actual Strategy draft
  writer and actual VersioningService over disposable transaction fixtures,
  including rollback after receipt, exact saved version, stale claims, deadline
  expiry, changed Objective/authority/source collections, lost commit response,
  public cross-field validation, context budgets and legacy generic drafts.
- Strategy application full TypeScript check passes with the lock-resolved
  TypeScript 5.9.3. Fixture transpilation uses isolated ts-jest and therefore is
  not a substitute for full semantic typechecking.
- Core full TypeScript check exceeded a 1 GB Node heap. It did not pass. The
  changed Core paths execute in focused fixtures; full Core type qualification
  remains required in an appropriately sized Linux environment.
- PostgreSQL privileges, actual competing-connection inserts/moves/deletes,
  lock waits/deadlocks, RLS and real transaction commit-loss behavior have not
  been run. Source migrations provide grant evidence only. The fixtures exercise
  the application's guards and rollback model, not PostgreSQL's implementation.
- Source-set insert/move/delete and mailbox/history changes are exercised as
  fixture witness changes. Do not present those as native PG concurrency tests.
- No schema, migration, lockfile, shared package, generator/provider protocol,
  standalone Meri runtime, diagnostic, Planner, AWS or deployment changes.

## Reproduction

Use the unchanged repository lockfile and pnpm 9.12.0. Install with
`pnpm install --frozen-lockfile --ignore-scripts --filter @capiro/api-strategy... --filter @capiro/api...`.
This task used an isolated task-local store after shared-cache failure, three
network requests at a time and one child process. Dependencies came from the
official npm registry. Prisma 5.22.0 clients were generated locally from the
unchanged schemas with `prisma generate --no-engine`; no database was contacted.
Build unchanged shared/auth/strategy-verifier/meriv2-core packages for imports.

From repository root, run one test process:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=768'
node apps/api-strategy/node_modules/jest/bin/jest.js --config docs/objective-generation-backend/fixture.jest.cjs --runInBand --runTestsByPath apps/api-strategy/src/meri/objective-generation.spec.ts apps/api-strategy/src/meri/meri.service.spec.ts apps/api-strategy/src/meri/draft-job-worker.service.spec.ts apps/api-strategy/src/meri/draft-job.service.spec.ts apps/api-strategy/src/meri/governed-strategy-meri.factory.spec.ts apps/api-strategy/src/meri/strategy-context-plane.client.spec.ts apps/api/src/context/objective-generation-context.service.spec.ts apps/api/src/context/strategy-context-plane.service.spec.ts
node apps/api-strategy/node_modules/typescript/bin/tsc -p apps/api-strategy/tsconfig.json --noEmit --incremental false --pretty false
```

The fixture config places its cache in the parent task directory, outside source.
For Linux Core qualification, use the same locked dependencies and unchanged
generated clients, then run `node apps/api/node_modules/typescript/bin/tsc -p
apps/api/tsconfig.json --noEmit --incremental false --pretty false` with sufficient
memory. Native PostgreSQL tests must use an isolated disposable database and the
actual application role. Never point fixtures or qualification at production.

## Remaining integration

The coordinator approved the explicit observed-history semantics in DESIGN.md;
the frontend owner acknowledged additive `context.reobservedAt`. Desktop
receiving still needs its own allocated operation/schema adapter and exact
Strategy navigation. Planner materialization remains a subsequent owned slice:
consume this exact saved Strategy version/Objective revision receipt, recheck
current authority, and establish idempotent project/task lineage and stale/partial
outcomes under reviewed activation rules. No one-project policy or task cap is
established here.
