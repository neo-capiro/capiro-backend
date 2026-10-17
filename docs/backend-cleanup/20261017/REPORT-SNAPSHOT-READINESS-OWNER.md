# Report snapshot readiness owner

Source base: backend PR #55, `74d6b3338da98844e1a9fba4f7f371c0dceaf8ff`. This is a source-only cleanup of a production-used report path.

## Reachability and build path

- `apps/api-strategy/src/main.ts` boots `AppModule` and mounts `/strategy-api`; `AppModule` imports `StrategyModule`.
- `StrategyModule` registers `StrategyController`, `StrategyReportService`, and `ReportSnapshotService` as providers. The controller's guarded `GET strategies/:id/reports/preflight` and `POST strategies/:id/reports/export` call `StrategyReportService`, which calls the snapshot service for the same snapshot and readiness policy. The controller uses `TenantGuard` and `StrategyPlannerGuard`.
- The snapshot service also exports capacity/readiness helpers used by its existing tests and `StrategyReportService`, and `stableJson` used by report narrative. These exports remain at their original module path.
- The report graph uses static imports and Nest provider registration. A search of the report source and module found no dynamic import, runtime glob, `ModuleRef`, or `DiscoveryService` registration for the snapshot policy. The report directory has a separate `playwright-core` runtime require in `pdf-browser.driver.ts`; this extraction does not touch it.
- `apps/api-strategy/package.json` builds with `nest build`; `nest-cli.json` uses `src` as source root, while `tsconfig.build.json` excludes tests. The service Dockerfile copies the entire `apps/api-strategy/src` directory before that build and ships its compiled `dist`. The new sibling policy source is therefore in the same compile and runtime graph without a manifest or loader change.

## Change

`report-snapshot-policy.ts` now owns the unchanged capacity limits, capacity issue ordering and messages, readiness blockers, and warning ordering and messages. `report-snapshot.service.ts` imports those pure functions and re-exports its three existing public symbols for compatibility. The service still owns tenant-scoped snapshot reads, audience projection, warning inputs, fiscal-cycle warning append, OOXML normalization, capacity assignment, and snapshot hashing. Its `build` and `preflightFromSnapshot` expressions are unchanged.

The focused characterization in `report-snapshot-policy.spec.ts` covers six simultaneous warnings, including singular member/omitted-step/stale-document copy and exact order. Existing `report-capacity.spec.ts`, `report-readiness.spec.ts`, and `report-snapshot.service.spec.ts` cover the old service exports and snapshot integration.

## Qualification and limits

Independent source review: **ACCEPT** for the scoped extraction and warning characterization. Raw UTF-8 comparison against the PR #55 Git blob confirms that the moved policy body is exact except for the required `buildWarnings` export, and that the entire `ReportSnapshotService.build` body is byte-identical. `git diff --check` passed.

Focused Jest and API Strategy TypeScript qualification are **pending** the Objective lane's reserved local process window. The planned Jest scope is `report-capacity.spec.ts`, `report-readiness.spec.ts`, `report-snapshot.service.spec.ts`, `strategy-report.service.spec.ts`, and the new `report-snapshot-policy.spec.ts`. No dependency install, compiler, or Jest process was started for this checkpoint. No database, migration, browser, image, AWS, or deployed service is changed or qualified by this cleanup.
