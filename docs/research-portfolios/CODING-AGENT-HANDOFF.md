# Coding-agent handoff: Research Portfolios closeout

## Mission

Close the entire Research Portfolios and Defense Intelligence plan. Do not claim completion until the repository implementation, production-like acceptance, deployment evidence, and rollback evidence satisfy the definition of done in [`PROJECT-CLOSEOUT-PLAN.md`](./PROJECT-CLOSEOUT-PLAN.md).

## Read first

Read these files completely before changing code:

1. [`PROJECT-CLOSEOUT-PLAN.md`](./PROJECT-CLOSEOUT-PLAN.md)
2. [`phase11/requirements-and-screens.md`](./phase11/requirements-and-screens.md)
3. [`phase11/acceptance-results.md`](./phase11/acceptance-results.md)
4. [`phase11/release-controls.md`](./phase11/release-controls.md)
5. [`phase11/README.md`](./phase11/README.md)

These files distinguish implemented seams from verified outcomes. Source-code presence is not completion evidence.

## Baseline facts

- The Phase 9–11 foundation was integrated at `abcd60fdede910850bdf515fefe9ef6c6438d92b`.
- Fetch current `origin/main`; do not assume that commit is still the tip.
- The existing Phase 11 verdict is intentionally `NO-GO`.
- The current implementation includes analytics, contribution ledgers, snapshots, durable CSV output jobs, authenticated downloads, Client Files receipts, personal event state, quiet-first subscriptions, eight Phase 9 Meri tools, server-bound research scope, rollout controls, native web controls, and a five-step tour.
- Major remaining areas include complete Phase 0–10 evidence-backed behavior, full UI/Meri parity, full research-context capture, a real scheduled delivery lane, institutional actions, server-persisted tour state, populated-database security/fault tests, browser acceptance, real-corpus evaluation, builds/deployment, and rollback rehearsal.

## Safety and authority

- Start from a clean isolated worktree based on current `origin/main`.
- Preserve unrelated work and user changes.
- Do not run destructive database or Git commands.
- Do not deploy, activate providers, send notifications, run production ingestion, or change customer cohorts without explicit environment-specific authorization.
- Use one owner at a time for Prisma schema/migrations and the shared Meri capability registry.
- Keep new lanes dark until their gates pass.

## Execution order

1. Reconcile the current SHA and rebuild the requirements/evidence matrix.
2. Close remaining Phase 0–8 code gaps.
3. Finish Phase 9 projection, snapshots, formats, delivery, and Client Files lifecycle.
4. Finish Phase 10 research context, complete UI/Meri action parity, watches, institutional actions, feedback, and tour persistence.
5. Run populated-database authorization, concurrency, fault, retry, reconciliation, and revocation tests.
6. Run desktop/mobile/accessibility journeys.
7. Qualify real source families, independent labels, model quality, and economics.
8. With authorization, build real images, rehearse migrations, deploy to a named internal cohort, and rehearse rollback.
9. Update every Phase 11 evidence row and obtain independent review.
10. Merge only after the complete gate is green.

## Minimum initial commands

```powershell
git fetch origin main
git status --short
git rev-parse HEAD
git rev-parse origin/main
pnpm --filter @capiro/shared build
pnpm --filter @capiro/api exec prisma generate
pnpm --filter @capiro/api exec tsc --noEmit
pnpm --filter @capiro/web exec tsc --noEmit
pnpm verify:research-portfolios-phases9-11
```

The final verifier is expected to remain `NO-GO` until external qualification and release gates are genuinely complete.

## Required final report

Report:

- final local and remote SHAs;
- all changed services, routes, components, migrations, flags, and workers;
- exact tests/builds/deployments run and their outcomes;
- requirement, screen, acceptance, defect, and release-gate dispositions;
- environment, image, migration, cohort, and rollback evidence;
- remaining customer-visible gaps;
- all blocked items and the precise missing authority or external state;
- confirmation that no temporary agent/Hermes sessions remain.

If any required row remains `PARTIAL`, `NOT RUN`, `BLOCKED`, or `NO-GO`, state that the project is not complete.
