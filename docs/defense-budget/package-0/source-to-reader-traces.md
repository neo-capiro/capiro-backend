# Defense-budget Package 0 source-to-reader traces

Evidence date: 2026-09-24. Repository baseline: `950072f477055ec8bdf3b7a377e371c4caf1a9aa` before Package C/E reconciliation.

## Annual source lifecycle

1. `apps/defense-api/src/budget-lifecycle/lifecycle-watcher.service.ts` discovers, fetches, classifies and hashes source bytes. First discovery can bootstrap the fiscal year; changed bytes supersede rather than delete an old observation.
2. `apps/defense-api/src/budget-lifecycle/prisma-lifecycle.store.ts` persists expected-source, immutable observation and outbox state in the schema owned by `apps/api/prisma`.
3. `apps/api/src/defense-budget/ingestion-outbox-drain-worker-v1.ts` leases exact outbox rows and invokes `ObservationIngestionBridgeService`.
4. `apps/api/src/defense-budget/observation-ingestion-bridge.service.ts` archives/loads the exact source revision, invokes the parser handoff, persists a durable artifact and records verification readiness. It does not itself approve or publish canonical funding.
5. `apps/api/src/defense-budget/governed-acceptance/scoped-fact-review` records bounded human decisions. Package C makes replacement forward-only and conflict-safe.
6. The separate promotion boundary writes `defense_budget_canonical_snapshot` and `defense_budget_canonical_row` under a segregated promoter role. The live snapshot found 43 active scoped approvals but no canonical snapshot or row, so approval-to-publication is not yet demonstrated.
7. Internal lifecycle reads are implemented under `apps/api/src/defense-budget-lifecycle`; the newer product reads are implemented under `apps/defense-api/src/budget-lifecycle-product`. Code registration is not proof of deployed route ownership.

## Scheduling and catch-up

- The live EventBridge rule `capiro-dev-watch-budget-docs` runs the legacy `watch-budget-docs --commit` command daily and had 31 invocations with no EventBridge delivery failures in the observed 31-day window.
- `ScheduleCoordinatorService.tick` exists, but it intentionally installs no timer. No deployed `defense-api` service or lifecycle-coordinator rule was found.
- The ingestion drain is a manual, finite Fargate task with no service or schedule. Its latest definition defaults to a no-op command and therefore requires an explicit bounded override.
- Package E supplies the exact-manifest lease, heartbeat, stop/resume and reconciliation contract. It does not authorize a production batch by itself.

## Extraction and family certification

- The production resolver wires a durable semantic factory only for `rdte`.
- Procurement, O&M and MILCON builders/factories exist but are not returned by the production resolver.
- `alternative_funding` and `execution` are explicitly unsupported by family readiness and cannot be advertised as published coverage.

## Evidence and storage

- Raw source revisions are stored in the versioned Object-Lock bucket `capiro-defense-budget-raw-dev-967807252336` with KMS encryption and seven-year governance retention.
- Extraction artifacts are stored separately in the versioned KMS bucket `capiro-dev-defense-budget-extraction-artifacts-967807252336`; noncurrent versions expire after 365 days.
- The live approved-data snapshot was collected inside a PostgreSQL read-only transaction by ECS task `5055a48296364d78bba241ac9e431a2d`; no secret value or row content was emitted.

## Activation boundaries

- `apps/api` owns source code, Prisma schema and migrations.
- `apps/defense-api/runtime-source` is a byte mirror used by parity/trusted-proof checks, not compiled application code.
- `apps/defense-api` is not deployed as a service in `capiro-dev`.
- `PHASE8_SESSION8_LIVE_DISCOVERY` is the explicit lifecycle discovery gate; it was not present on the live API task definition.
- API lifecycle/review routes are protected by the internal-tenant boundary; no broad defense-budget tenant feature flag was found.

These traces separate source discovery, extraction, review, canonical publication and customer reads. A row at one stage is not evidence that later stages ran.
