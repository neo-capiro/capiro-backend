# JEV A2 billable repair timeout accounting — acceptance

## Scope

- Baseline: `06748f1ccdb87b285721d696d6f4551d208fd814`.
- Isolated worktree/branch: `C:\dev\main\jev-a2-billable-repair-worktree` / `jev-a2-billable-repair-20260925`.
- Changed only shadow/canary accounting and its tests/report aggregation. No provider/routing behavior, feature flags, or deployment actions changed.

## Correction

When the outer repair fence returns on timeout, abort, or rejected dispatched work, the finalized response remains unchanged and the fence still does not wait for the background Promise. The failed-stage event now reports `repairUsage: "unknown"`; repair and legacy token counts and total estimated cost are null rather than false zeros. Successful completed repair usage is marked `measured`; turns without repair remain `not_attempted`.

Canary parsing accepts nullable usage/cost fields. Cost reports now return null for totals/per-task/released-turn averages when a completed sample contains unknown cost, expose known/unknown turn counts, and compute percentiles over measured rows only. Correct-completed-task cost is null with reason `usage_unknown` when any selected task has unknown usage.

## Evidence

Before the implementation, the focused hanging-provider regression failed as expected: it received `estimatedCostUsd: 0`, `tokens.repair: 0`, and `tokens.legacy: 0` instead of unknown values.

Passed after the fix:

- `pnpm --filter @capiro/meriv2-orchestrator exec jest src/meri/meriv3/meriv3-assistant.service.spec.ts --runInBand` — 72 passed.
- `pnpm --filter @capiro/meriv2-orchestrator exec jest src/meri/canary/canary-turn-collector.spec.ts --runInBand` — 6 passed.
- `pnpm --filter @capiro/meriv2-core exec jest src/canary/canary-report.spec.ts --runInBand` — 10 passed.
- `pnpm --filter @capiro/meriv2-core typecheck` — passed.
- `pnpm --filter @capiro/meriv2-core build` — passed.
- `pnpm --filter @capiro/meriv2-orchestrator typecheck` — passed.
- `pnpm --filter @capiro/meriv2-orchestrator build` — passed.
- Workspace dependency builds for `@capiro/shared`, `@capiro/auth`, `@capiro/meriv2-core`, and `@capiro/strategy-verifier` — passed.
- Prisma client generated from `apps/api/prisma/schema.prisma` using orchestrator Prisma 5.22.0 — passed; temporary copied schema removed.
- `git diff --check` — passed.

## Follow-up completeness hardening

Commit `685fc7122` was reviewed for false-zero provider-call and claim-outcome metrics after a dispatched but uncompleted repair. The follow-up now sets `repair.outcomesComplete: false` and nulls `cost.jevCalls`, `cost.legacyCalls`, and `cost.repairLoops` when usage is unknown. Canary aggregation excludes incomplete claim-outcome rows from attempted/success denominators and exposes `outcomeCompleteTurns` / `outcomeIncompleteTurns`. Call-count component totals and means are null when any released row is unknown, with measured-only percentiles and known/unknown counts. Historical events remain parseable: the new fields are optional, and missing legacy cost components retain their prior zero-default behavior.

Follow-up verification passed:

- `pnpm --filter @capiro/meriv2-orchestrator exec jest src/meri/meriv3/meriv3-assistant.service.spec.ts --runInBand -t "hanging judge provider"` — 1 passed.
- `pnpm --filter @capiro/meriv2-orchestrator exec jest src/meri/canary/canary-turn-collector.spec.ts --runInBand` — 6 passed.
- `pnpm --filter @capiro/meriv2-core exec jest src/canary/canary-report.spec.ts --runInBand` — 10 passed.
- Core and orchestrator typechecks and builds — passed.

## Residuals

- The report intentionally preserves repair-time cost as unknown at turn scope even if synthesis/passage-selection costs were measured; the full turn total cannot be reconstructed from the available post-timeout data.
- Canary p50/p95 cost percentiles describe measured turns only; consumers must use `knownTurns` and `unknownTurns` to assess completeness.
- Legacy events without `repair.outcomesComplete` remain treated as complete for backward compatibility. Newly emitted timed-out repairs explicitly mark incompleteness.
- This acceptance covers the orchestrator service suite and canary/report tests, package builds, and package typechecks. It does not claim a full monorepo test run or deployment validation.
