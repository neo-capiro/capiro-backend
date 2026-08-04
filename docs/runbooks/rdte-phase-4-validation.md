# Runbook — Phase 4 (RDT&E) Validation

Standing validation commands for the Phase 4 surface. All are read-only,
local, and require no shared database.

## Full phase gate

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-4
```

Runs the complete `src/defense-budget/rdte` jest suite (extractors,
builders, reconciler, certifier, projection planner, cycle pipeline, golden
fixtures, architecture gates, negative-control probes) and then
`scripts/verify-rdte-phase-4-safety.ts` (permanent gates over 41+ files,
--commit refusal, migration additivity).

## Prerequisite gates (must stay green)

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-1
pnpm --filter @capiro/api verify:pe-budget-phase-2
pnpm --filter @capiro/api verify:pe-budget-phase-3
pnpm --filter @capiro/api typecheck
pnpm --filter @capiro/api exec prisma validate
```

(`DATABASE_URL` must be set for `prisma validate`; any syntactically valid
Postgres URL works — no connection is made.)

## Focused suites

```bash
cd apps/api
./node_modules/.bin/jest --runInBand --forceExit --no-coverage src/defense-budget/rdte
./node_modules/.bin/jest --runInBand --forceExit --no-coverage src/defense-budget/rdte/projection
./node_modules/.bin/jest --runInBand --forceExit --no-coverage src/defense-budget/rdte/cycle
./node_modules/.bin/jest --runInBand --forceExit --no-coverage src/defense-budget/rdte/gates
```

Never use `npx jest` (babel transform chokes on typed callbacks); always the
package-local jest binary.

## Negative controls (defect injection)

```bash
pnpm --filter @capiro/api exec tsx scripts/verify-pe-budget-phase-4-negative-controls.ts
```

Injects each of the 20 plan §19 defects into a backup-tracked copy, confirms
the targeted test FAILS, reverts, and finishes with a full green rdte suite.
Exit 0 only when all 20 defects are detected and the tree is green
afterwards. Takes ~20 minutes (21 jest runs).

## Golden cycle rehearsal

```bash
pnpm --filter @capiro/api build:rdte-cycle -- \
  --manifest apps/api/scripts/__data__/rdte-golden-fy2027-manifest.json \
  --out /tmp/rdte-golden-cycle
pnpm --filter @capiro/api report:rdte-cycle -- --cycle-dir /tmp/rdte-golden-cycle
pnpm --filter @capiro/api plan:rdte-projection -- \
  --cycle-dir /tmp/rdte-golden-cycle --out /tmp/rdte-golden-cycle/projection-plan.json
```

Expected: build exit 0 (CERTIFIED_RDTE_READY_FOR_PROJECTION), report exit 0,
plan exit 0 with 20 candidates / 8 truthfulness exclusions (4
contextual_only_value + 4 non_annual_cost_value) on the synthetic fixture.

## Migration rehearsal (disposable PostgreSQL)

```bash
bash apps/api/scripts/rdte-phase-4-migration-rehearsal.sh
```

Requires docker + `pgvector/pgvector:pg16` image. Rehearses:
- Path A: fresh `prisma migrate deploy` on an empty database (all 216
  migrations) — new tables exist, `project_code` is VarChar(32).
- Path B: upgrade path — replay every pre-Phase-4 migration, seed
  representative rows, apply the Phase 4 migration, then assert row
  preservation, no truncation, 32-char code acceptance, valid-position
  acceptance, duplicate-natural-key rejection, invalid-quarter rejection,
  fake period/date rejection, truthful-period acceptance.

NEVER point this script at a shared database. It creates a disposable
container `pe-p4-mig-rehearsal` (port 55441) and drops it on exit
(`P4_REHEARSAL_KEEP=1` to retain).

## Formatting

```bash
pnpm exec prettier --check apps/api/src/defense-budget/rdte apps/api/scripts
```

(Pre-existing CRLF/LF noise in unrelated files is tracked separately; scope
format checks to Phase 4 paths.)

## What a clean run proves

- 323+ rdte tests green across 16 suites;
- all 20 negative controls detect their defect and revert clean;
- golden cycle certifies deterministically and projects through the WS M
  planner with truthful exclusions;
- migration applies fresh and upgrades without data loss on disposable PG16;
- no canonical write, no shared migration, no paid parser call occurred.
