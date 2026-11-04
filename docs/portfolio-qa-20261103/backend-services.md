# Portfolio QA: backend services evidence

Source base: `471e3451b48674d881b395b354ea5b1292b698ca` (`backend-import`).
Qualified services head: `49ec95115a3edb4edd5720c3d84ec3998a45eac2`.
This records local source/regression evidence, not deployed acceptance. No live database, deployment, or saved customer artifact was changed.

## Changes and limits

| Finding | Source change and evidence | Remaining acceptance |
| --- | --- | --- |
| F02 opportunities/programs | The opportunity SQL adapter now uses Prisma's existing native transaction deadline, including acquisition/statement limits and awaited cleanup. All selected catalog searches and their optional freshness reads share a 20-second source budget; freshness cannot start a fresh allowance after a slow catalog read. Optional public award/identity context uses one native 5-second transaction and retains tenant facts if unavailable. All-source failure identifies the selected sources; partial results and unknown totals remain distinct from zero. The PE relevance service already uses a shared 15-second query budget; its existing deadline regressions pass unchanged. Independent static inspection found the source SQL column references present in the current Prisma schema. | The observed deployed outage is **not diagnosed or proven restored**. No deployed requests, service logs, database schema/version, flags, permissions, or query plans were inspected. Initial scope/profile reads and final decoration are separate from the source budget; this is not a hard whole-HTTP latency guarantee. Frontend bounded recovery is complementary. Native PostgreSQL source cases still require the explicit isolated test database. |
| F04 meeting prep | Final composition no longer re-appends every per-batch extractor limitation after the accepted draft has reconciled those caveats. Accepted draft limitations and deterministic source-coverage, omission-budget, and incomplete-review limitations are retained. Regression exercises a repaired blanket metadata-only claim, supported commitment, and mandatory partial-coverage disclosure together. | This prevents one demonstrated composition failure for future results; it does not validate every free-form assertion or repair the previously saved synthetic artifact. No model, prompt, Fill with Meri flow, or saved content was changed. The frontend separately flags inconsistent saved structured content for review. |
| F08 facility district | `normalizeFacilityDistrictCode` maps Census facility code `98` to map code `00` only for DC, AS, GU, MP, PR, and VI. New geocodes and selected candidates use that canonical code. Existing facility responses, representation, District Nexus aggregation/evidence, and detail membership resolve the same seat without a database rewrite. Revision tokens continue to describe the raw saved snapshot. Unknown jurisdiction, multi-district/undefined codes, and raw award-source sentinel semantics remain unchanged. | Actual saved-address/geocoder matches and current public representation/boundary availability still need deployed acceptance. Existing rows are normalized at read boundaries; no bulk data migration ran. |
| F09 bill coverage | Investigation found **two different membership tables**: Core `tracked_bill` (UUID tenant/client keys) and Intelligence `intel_tracked_bill` (TEXT keys). The UI supports either configured tracker owner. Core `GET clients/metrics?trackerBackend=core\|intelligence` now selects exactly that owner and echoes `trackerBackend`; omission preserves the existing Core default. Both counts use the same active, visible, non-prospect Core client population. Missing/unavailable selected data returns unavailable, never the other owner's count or zero. The native preview admission accepts only the exact closed tracker selector on metrics GET/HEAD; all other query refusals remain. Targeting topics are configuration, not tracked-bill membership. PostgreSQL/WASM tests execute both SQL branches with different counts and hidden/other-tenant data. | The earlier same-table conclusion applies **only when the UI selects Core**, not Intelligence. No live `TRACKER_BACKEND` or table contents were inspected, so the audit's exact discrepancy remains unverified. This reuses the established Core cross-schema read pattern; deployment must align the Core/Intelligence database and role permissions. Frontend request/schema/cache binding to the configured owner is part of the paired change. |
| F19 capability fit | A cache miss now returns `status: 'not_computed'`, `computedAt: null`, no matches and no confirmed contributing sources. Successfully computed empty results remain `empty`. | Complete refresh and persisted fresh scoring require an available deployed scoring/source environment. |
| Report-tail mail association | Profile contacts are normalized and deduplicated by client/email pair; only active candidate clients contribute. A tied largest contact count remains unassigned and cannot fall through to the same contact score to select the first database row. Unique leaders and ordinary no-contact matching remain supported. Tests reverse database ordering and cover duplicate primary/person rows, unique leaders and inactive contacts. | This does not establish which reported imported messages were misassociated or rewrite historical associations. The existing timeline contact-email policy is unchanged. |

Objectives findings F05/F10 and Fill with Meri changes were excluded. Authorization, tenant/client/wall predicates and current-actor rechecks were retained.

## Verification

Toolchain: Node `v24.22.1`, pnpm `9.12.0`, Prisma generated client `5.22.0`. Shared/auth/runtime package dependencies were built by the integration owner before the successful run.

Consolidated services command at `f2a02e77`, from the services worktree:

```bash
node /root/.npm/_npx/d558bce9e1a0aca4/node_modules/pnpm/bin/pnpm.cjs --filter @capiro/api run test --runInBand --runTestsByPath \
  src/clients/client-capability-fit.service.spec.ts \
  src/clients/client-capability-fit.controller.spec.ts \
  src/common/district-code.util.spec.ts \
  src/external/census-geocoder/census-geocoder.client.spec.ts \
  src/clients/facility-geocode.util.spec.ts \
  src/clients/client-facilities.service.spec.ts \
  src/clients/facility-geocode-candidate-cas.spec.ts \
  src/clients/representation-resolver.service.spec.ts \
  src/district-nexus/district-nexus.evidence.spec.ts \
  src/district-nexus/district-nexus.aggregate.spec.ts \
  src/district-nexus/district-nexus.firm-aggregate.spec.ts \
  src/district-nexus/district-nexus.firm-aggregate.all-districts.spec.ts \
  src/district-nexus/district-nexus.detail-keys.spec.ts \
  src/funding-opportunities/funding-opportunity-v2-search.service.spec.ts \
  src/funding-opportunities/funding-opportunity-v2-search.sql.spec.ts \
  src/engagement/client-association.service.spec.ts \
  src/engagement/meeting-prep-comprehensive.spec.ts \
  src/intelligence/client-pe-candidates.spec.ts \
  src/intelligence/client-pe-relevance.service.spec.ts \
  src/clients/portfolio-metrics.http.spec.ts \
  src/clients/portfolio-metrics.spec.ts
```

Exit **0**: **21 suites passed; 448 tests passed, 8 skipped, 456 total; 0 snapshots** (14.906 seconds). The eight skipped cases are the existing native PostgreSQL opportunity SQL cases; the explicit isolated `FUNDING_OPPORTUNITIES_TEST_DATABASE_URL` was absent. No skip or assertion was weakened. PostgreSQL/WASM tests establish SQL population/candidate-CAS behavior, not native Prisma-engine, RLS, or production acceptance. Existing deadline/scoping and negative-role regressions remain in the run.

The subsequent native metrics admission prerequisite at `49ec9511` passed its exact affected suites, exit **0**: **2 suites, 154 tests passed, 0 skipped**, 2.493 seconds:

```bash
node /root/.npm/_npx/d558bce9e1a0aca4/node_modules/pnpm/bin/pnpm.cjs --filter @capiro/api run test --runInBand --runTestsByPath \
  src/auth/preview-native-read-mode.spec.ts \
  src/clients/clients.metrics-native-read.controller.spec.ts
```

The middleware/controller fixture uses the application's actual Express query parser. Positive checks cover both owners; negatives retain unknown, repeated, extra-authority and malformed target refusals. Across these runs, **602 tests passed** and the same eight native database cases remain skipped.

`git diff --check` passed. Initial setup runs failed for missing built workspace packages; one test invocation named a nonexistent candidate test path, corrected to the existing CAS suite. New test fixture assumptions and the intended facility display contract were corrected before the final run. The default PATH pnpm was 11 and refused its implicit dependency check against a symlink; the successful command uses the pinned pnpm directly.

Full API typecheck/build/lint and integrated exact-head review are owned by the integration session, not claimed by this isolated run. The API declares a lint command but the current backend manifests do not declare/install an ESLint executable. No package, lockfile, schema, migration, generated output, or infrastructure file changed in this services lane. Test dependency symlinks and logs remain untracked scratch setup only.

## Commits

- `93c95571`: explicit uncomputed capability fit state.
- `7fe8d41f`: preserve reconciled prep limitations during final composition.
- `62e79aee`: native deadlines for opportunity sources and optional profile context.
- `5990aaf2`: facility-only delegate district normalization and regression coverage.
- `2e74d7c7`: deduplicated, tie-safe client contact association.
- `f2a02e77`: selected tracker owner for portfolio bill coverage.

- `49ec9511`: exact native metrics tracker selector admission and negative regressions.
