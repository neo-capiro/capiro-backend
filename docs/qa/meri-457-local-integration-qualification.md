# Meri local integration on the API :457 release source

Date: 2026-09-25. Release source base: `30a9ab33458fe3b2d6b76b73c00c773979b8cebb`. Integrated code HEAD before this record: `a8a46b863`. This is a local source qualification, not a deployment or release signoff.

## Source integration

Selected implementation commits from the B1–B6, Phase 2, Phase 2A, A2, and Phase 3–6 package branches were replayed in dependency order. The release branch's `20280925020000_package9_source_bundle_reader_grant` and `20280927010000_business_development_phase4_brief` migrations are unchanged. `git diff --name-only 30a9ab334..HEAD -- apps/api/prisma apps/api/src/business-development apps/web/src/vnext/pages/business-development` is empty. The prospect and `turnScope` lines in the overlapping Meri services are unchanged from the release base. The Phase 6 offline evaluator was integrated only after a separate reviewer approved its duplicate-unit and split-gate fixes.

Four merge resolutions were required: combine the approved tenant-wide directory-note description with the Phase 2 search contract; retain both federal-award and research mock stores; include `servedBy: 'legacy-v1'` alongside the newer prospect `turnScope` receipt; and keep the Phase 5 README's verified historic artifact counts without treating those cases as adjudicated ground truth. No source file was deleted from the release base.

## Checks on the integrated candidate

- Offline frozen install with ignored package scripts passed (1,491 packages from the local store); the Prisma client was generated from this worktree's schema.
- Builds passed for `@capiro/shared`, `@capiro/meriv2-core`, `@capiro/auth`, `@capiro/strategy-verifier`, `@capiro/defense-domain`, and `@capiro/defense-contracts`.
- `pnpm --filter @capiro/meriv2-orchestrator typecheck` passed.
- `pnpm --filter @capiro/api typecheck` passed, including `PE_PHASE_A_B_SAFETY_OK`. The first run failed because the two defense workspace packages had no compiled outputs after an install with ignored scripts; those packages were built and the full command passed on rerun.
- `pnpm --filter @capiro/api build` passed.
- Six targeted orchestrator evidence/citation/final-schema suites passed, 42/42 tests, on the code before the Phase 6 replay; Phase 6 changed only Meri core evaluation files and documentation.
- Focused API Jest selection passed: six suites and 110 tests covering the B1 research wall, Phase 2 task/action envelopes, Phase 3 authenticated scope, Phase 4 tool view, and A2 FedRAMP parser/retry.
- The explicit B1–B6 non-database API Jest selection below passed: 18 suites and 320 tests, zero failed. The 18 suites are a reproducible reconstruction from changed files, not a replay of an unavailable original test command. The earlier package baseline recorded 290 tests; additional tests in the integrated selection explain why this count is different. Do not add the six focused suites to 320 because they overlap.
- Phase 5 Node validators/adjudication gate passed 21/21; narrow ECS release-helper tests passed 5/5; Hermes overlay Python tests passed 5 with one pinned-archive check skipped because the archive path was not supplied.
- Phase 6 offline shadow auditor passed 8/8 focused core tests on the final integrated code. `pnpm --filter @capiro/meriv2-core typecheck`, its standalone CLI TypeScript check, and the core build passed. There is no runtime producer, live traffic, or provider activation in this package.
- After the Phase 6 core build, `pnpm --filter @capiro/api exec tsc --noEmit --rootDir .` and `pnpm --filter @capiro/meriv2-orchestrator typecheck` both passed again. The earlier full API typecheck and Nest build tested the identical API source; Phase 6 added only the offline core evaluator and its export.

The 18-suite command was run from the repository root with `TS_JEST_LOG=stderr:error`:

```powershell
pnpm --filter @capiro/api exec jest --runInBand --forceExit `
  src/meri/meri-tools.firmdata.spec.ts `
  src/meri/meri-tools.client-resolve.spec.ts `
  src/meri/meri-research-evidence.helpers.spec.ts `
  src/meri/meri-research-handoff.spec.ts `
  src/meri/meri-research.service.spec.ts `
  src/meri/meri-resolve-entity.spec.ts `
  src/meri/meri-scrape.helpers.spec.ts `
  src/meri/meri-research-continuity.spec.ts `
  src/meri/meri-v3-research-runner.spec.ts `
  src/meri/meri-bill-status-tool.spec.ts `
  src/meri/meri-committee-roster-representation-tool.spec.ts `
  src/meri/meri-state-bill-status-tool.spec.ts `
  src/funding-opportunities/funding-opportunity-v2-search.service.spec.ts `
  src/funding-opportunities/meri-opportunity-tools.spec.ts `
  src/intelligence/actions/action-recommendation-read.service.spec.ts `
  src/engagement/engagement-task-wall.spec.ts `
  src/meri/analytics/analytics-db.service.spec.ts `
  src/observability/meri-delegated-request-id.spec.ts
```

## Open acceptance gates

The five migrated B1/B3/B6 database suites have not been run on this integrated source; the earlier isolated source passed them on a disposable database. The current source also has no deployed B1–B6/Hermes browser replay, no ordinary-user wall proof (test identities/grants were declined), no B5 private-route traffic acceptance, no pinned worker archive execution proof, no independently adjudicated Phase 5 cohort, and no Phase 6 shadow/canary sample. FedRAMP negative/current claims remain dark pending a complete authoritative current source. Phase 2A retirement needs the planned four-week route-traffic/parity record. The exact candidate release still requires a fresh deployment decision and separate final live QA.
