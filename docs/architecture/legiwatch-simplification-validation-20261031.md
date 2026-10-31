# LegiWatch simplification validation — 31 October 2026

## Independent-review corrections and mixed-version transition

The independent review of FE `89a35dd157d11677365ed982e84f555ba2807a8c` and BE
`87fe4228beec91ca7f0491db4919387e30b340c5` returned both heads. The historical
implementation review statements below apply only to their stated earlier
pins, not this correction or deployment acceptance. Corrections are isolated
on `fix/legiwatch-rollout-compatibility-20261031`; they do not include the
concurrent hearing reliability work.

- Research exact-source reads now use `ResearchService.run`, preserving the
  research feature, member, tenant, folder/client match and wall checks without
  requiring the editorial feature. Briefing preparation/distribution retain
  their own gates; other historical exact-source kinds keep their prior gate.
- Retained generated links prefer `LEGISLATIVE_APP_ORIGIN`, fall back to the
  existing `REPORT_APP_ORIGIN`, and default to `https://app.capiro.ai`. No stored
  links or historical records change. The plan generator's default origin is
  corrected; its historical migration/activation sequence is not authorized
  for replay by this correction.
- `run-report-updates` temporarily dispatches to the same retained monitoring
  implementation as `run-monitoring-updates`. It never drains bill reports or
  runs retired subscriptions. No worker or schedule was executed or changed.
- Old `/legiwatch/reports/runs/*`, recipients and rules paths temporarily share
  the retained delivery/monitoring services. Those services still reject old
  bill-report reads/compositions/enqueues/dispatch. The sole definition-list
  route is read-only, requires current folder and editorial access, and returns
  only actor-owned, unarchived, accessible single-folder briefing choices.
- Legacy briefing preview/approve may carry `reportId`. That path checks owner,
  exact selected folder, archive state and research-only sources, retains the
  old preview hash shape/version fields, and freezes/replays the existing
  definition. Approval locks the tenant-scoped definition `FOR SHARE` before
  its version read and holds it through the immutable run insertion, preventing
  an old API instance from updating/archiving it across that check. New inputs
  keep the standalone hash and scope-record behavior. Explicit research-only
  legacy configuration input validates its old definition before discarding
  picker metadata; removed source families and monitor work remain rejected.

Release order: integrate this bounded delta onto current accepted backend main
without importing backend-import's unrelated divergence; qualify/promote that
compatible API first, then the cumulative frontend. The frontend companion
retains old gateway operation names/shapes for cached clients, so frontend
promotion does not strand an already-open retained briefing or delivery screen.
Keep this compatible backend during a frontend rollback. Remove the aliases,
read-only picker and old briefing/configuration shapes together only after the
sole Release owner confirms frontend promotion, cached-client transition and
expiry of the rollback window. Reconcile existing worker command overrides
before removing `run-report-updates`. No new flag, scheduler or deployment
framework is introduced; historical schema/data stay unchanged.

Correction checks use Node 24.22.1 and existing declared dependencies through
owned worktree junctions. Shared/meriv2-core outputs and generated Prisma are
the unchanged task-owned outputs from the earlier implementation; no install,
donor mutation, schema generation or database operation was performed.
Affected Intel checks passed: 69 tests across eight suites (editorial
simplification, independent research exact access, delivery simplification,
delivery domain/boundary, research draft, agenda access and task-runner), plus
`tsc --noEmit --incremental false --pretty false`. The first expanded suite
run exposed an overbroad new test matcher that selected the existing membership
lock; restricting it to the report-definition lock made the 30-test editorial
suite pass. The other seven suites were unchanged and passed. The initial root
Jest CLI lookup was unavailable; checks used Intel's declared app-local Jest.
Frontend checks are recorded in its existing Modules/Settings handover. No
manifest, lockfile, schema or migration changed, and diff checks passed.
Local tests do not prove live target reconciliation, PostgreSQL lock
contention, authenticated deployed routes, provider effects, or rollout/rollback
acceptance. Those remain Release's bounded integration gates. Exact-head
independent correction review remains required.

## Scope and source

The user requested removal of Import review, Research import review, Reports,
News evidence, Florida Budget, Legacy digest, and then explicitly confirmed
removal of Daily subscriptions. Committees moves to Directory with Federal and
State filters. Committee Staff remains separate. The current State committee
room API covers Florida; the interface states that coverage limit.

Both repositories use `feat/legiwatch-simplification-20261031`:

- Frontend base: `6d1465cf903b7a85bc716590eacc33dc2a81c570` (`main`). Reviewed
  implementation: `fd745cc49c58ac794e7903a3c1247efd99999506`. Review metadata head:
  `89a35dd157d11677365ed982e84f555ba2807a8c`; tree
  `fceecb9e490959548465c8f7768bb04588ae24ae`.
- Backend base: `19cdf4b47d01c8d6ad159e66c42947f980368b5b` (`backend-import`).
  Initial implementation reviewed at `060f698af133c669d1a69dbc9a7cdd27022a08a5`.
  Final implementation: `1d1a85aaf860329272b50e2b29604c01d1f59fbd`; tree
  `31ccf0d488531b54a7f3bbda1bdfdb71084ec9e3`.

Deleted feature owners include frontend screens, typed operations, import and
subscription services, report rendering, feature-only controllers, monitor
workers, CLI scripts, obsolete fixtures, and unused helpers. Shared draft
delivery now lives under `tracker/delivery`. Client briefings and research use
their selected sources directly without a saved Reports definition. Retained
exact-source and Meri readers have active callers outside the removed screens.
Held/uncertain delivery recovery remains an explicit operational API to prevent
automatic resend after an ambiguous transport result.

No package manifest, lockfile, Prisma schema or applied migration was changed.
Historical storage contracts and data were preserved. No database migration,
live service mutation, merge, deployment or cloud resource change was performed.

## Executed checks

Windows Node `24.22.1` was used with the existing declared dependency trees.
The available npm/pnpm executables are `11.19.1`/`12.6.0`, rather than the
repository pins; direct Node CLI entry points avoided installation or lockfile
changes. Backend task-local links resolve the rebuilt task versions of
`@capiro/shared` and `@capiro/meriv2-core`. Intel Prisma was generated from the
unchanged task schema, without accessing a database.

| Check | Result |
| --- | --- |
| Frontend TypeScript, `tsc --noEmit --pretty false` | Passed |
| Directory route/filter and screen tests | 23 passed |
| Frontend retirement and retained-operation contracts | 36 passed |
| Playwright Directory + LegiWatch browser harness | 18 passed |
| Focused frontend ESLint, formatting and diff checks | Passed |
| Core analytics HTTP/service suites | 13 passed |
| Initial Intel removal/delivery/research suites | 8 suites, 55 tests passed |
| Initial editorial/source/trust suites | 8 suites, 132 tests passed |
| Intel TypeScript and Nest build | Passed against task-built shared packages |

The two Intel test groups overlap; their counts must not be added together as
a unique total. Later fixes rerun their affected checks, recorded below.

Reproduction entry points (run from the indicated application directory):

```text
apps/web:
node ../../node_modules/typescript/bin/tsc --noEmit --pretty false
node ../../node_modules/@playwright/test/cli.js test --config test/browser/playwright.config.ts test/browser/directory-committees.spec.ts test/browser/legiwatch.spec.ts

apps/api:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/live-hearings/legiwatch-analytics-routes.http.spec.ts src/live-hearings/legiwatch-analytics.service.spec.ts

apps/intel-api:
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/@nestjs/cli/bin/nest.js build
```

Browser checks used synthetic local fixtures and port `5307`, including old
removed URLs, retained pages, client scope navigation, keyboard interaction,
mobile overflow, and Federal/State selection across refresh. These checks do
not establish deployed behavior or live authentication/delivery.

## Preserved failures and unrun qualification

- Frontend production webpack build fails on `node:crypto` imported through
  the unchanged installed shared-package barrel and Objective destination
  code. The exact untouched frontend base was archived and built with the same
  dependencies and command; it reproduces the same error and import chain.
  Command: `node --max-old-space-size=8192 ../../node_modules/next/dist/bin/next build --webpack`.
- Frontend architecture reports the same 11 boundary errors as the untouched
  base. Independent review refreshed exact source-byte size records for the
  changed files; none has a blocking size finding. The 140 unrelated blocking
  size findings remain visible. No scanner policy or threshold was weakened.
- Broad Core API TypeScript checking remains blocked by existing dependency,
  generated-output and cross-application `rootDir` errors. At the reviewed
  implementation, the candidate has 156 diagnostics and the untouched base
  155; the additional diagnostic is a cross-root dependency in the changed
  import graph. Excluding `TS6059`, both have the same 119 file/error-code
  occurrences, with no added semantic diagnostic. The earlier stale imports
  in the hearing integration fixture were corrected. Command:
  `node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit --rootDir . --pretty false`.
- Intel ESLint is not installed in the available dependency tree. Its lint
  command could not run; no dependency installation was attempted.
- The existing CLI smoke suite's 11 failures reproduce on the untouched
  backend base in the same environment (help/no-argument and exit-code
  contracts). These failures were not converted to skips or suppressed.
- PostgreSQL integration cases were preserved/adapted but not executed:
  no disposable database is available, and WSL `Codex-Gates` cannot start
  because its registered VHDX is missing. No clone/live database was used as
  a substitute. Container/image qualification and live preview acceptance
  were not performed.

Local command logs and baseline archives are retained in the task workspace's
`work` directory. The CLI smoke baseline is retained in
`C:/dev/legiwatch-script-base-15chvksk/baseline-result.log`.

## Independent review

Separate GPT-6 Astra Ultra review sessions inspected frontend and backend
source. Frontend review corrected two unused helpers and recorded exact size
responsibilities in `docs/modules-settings/STRUCTURE-REVIEW.md` in the frontend
repository. Backend review identified orphan contact-management/export/context
APIs, retired configurations starving the scheduling batch, and Meri briefing
contracts still advertising removed sources. Their fixes and final review
result are recorded in the follow-up section.

## Follow-up validation

Scheduler correction `2e2efec3a55fc3ae1f7433a173e3578fe2ec5e09` applies current
configuration eligibility before the per-owner batch limit. Independent review
confirmed parity between the SQL and runtime predicates and unchanged RLS.
The same eight editorial/source suites now pass 144 tests, including 12 added
eligibility cases. The real PostgreSQL discovery scenario now places 12 retired
active configurations ahead of a valid one; that database case remains unrun.

```text
apps/intel-api:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/tracker/editorial/editorial-simplification.spec.ts src/tracker/editorial/retained-source-reader.service.spec.ts src/tracker/editorial/publisher-coverage.spec.ts src/tracker/editorial/retained-florida-read.controller.spec.ts src/tracker/editorial/retained-florida-read.service.spec.ts src/tracker/editorial/florida-current-authority.service.spec.ts src/tracker/editorial/retained-florida-trust.spec.ts test/phase8-domain.spec.ts
```

Follow-up `1d1a85aaf860329272b50e2b29604c01d1f59fbd` removes the orphan contact/list
mutations, duplicate run export and unused bill-context route/helper. Existing
recipient selection, opt-out/private-list enforcement and explicit delivery
recovery remain. New briefing sources and citations are restricted to research
in Core's canonical request contract, advertised tool schema and generator.
Retired source kinds are rejected at the mounted HTTP boundary before approval.

Final affected results: Intel's eight removal/delivery/research suites pass 59
tests; the Core mounted briefing HTTP suite passes 16; the generator suite
passes four. Intel TypeScript/Nest build and the generator package build pass
with the scheduler correction included. Focused formatting and diff checks
pass. Commands:

```text
repository root:
node node_modules/typescript/bin/tsc -p packages/meriv2-core/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p apps/intel-api/tsconfig.json

apps/intel-api:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/tracker/delivery/simplification.spec.ts src/tracker/delivery/delivery-domain.spec.ts src/tracker/delivery/delivery-boundary.spec.ts src/tracker/research/research-draft.spec.ts src/tracker/calendar/agenda-rule-access.spec.ts src/hearing/published-record-domain.spec.ts src/hearing/hearing-record-retrieval.controller.spec.ts src/tracker/research/research-domain.spec.ts
node node_modules/@nestjs/cli/bin/nest.js build

apps/api:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/meri/legislative-document-action.http.spec.ts

packages/meriv2-core:
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/tools/hearing/generate-editorial-brief.spec.ts
```

The existing Core `legislative-document-action.bridge.spec.ts` suite cannot
collect because the installed `@capiro/defense-domain/pe-read` entry is missing.
A temporary resolver to exact task source progresses to an unavailable
`simple-statistics` dependency; no checked-in resolver, stub or dependency was
added. The untouched archived backend base reproduces the original missing
package entry with the same Jest command and installed dependencies.

Independent backend review is clean at final implementation
`1d1a85aaf860329272b50e2b29604c01d1f59fbd`. All findings were resolved; the
reviewer found no additional correctness, tenant/client-wall, idempotency,
retirement or standalone-draft regression. The full-base diff check passes.
This is source review acceptance, not deployment qualification.

The reviewer used TypeScript AST spans intersected with rename-aware changed
hunks to assess these modified large methods at the exact final head. Counts
are physical lines; no size policy or scanner threshold was waived.

| Owner / method | Lines | Responsibility assessment |
| --- | ---: | --- |
| MeriToolsService.anthropicToolSchemas | 1734 | Canonical schema registry; existing entries narrowed without adding workflow logic. |
| FolderSourceDataRepository.publishedBills | 159 | Public source aggregation; renamed while retaining private-scope ownership. |
| task-runner.runVerb | 581 | Existing CLI dispatch; report jobs removed, retained work delegated to owners. |
| BillChangeDetector.runDetectionCycle | 283 | Existing detection cycle; tenant-discovery wiring changed. |
| CalendarPreparation.prepare | 109 | Calendar preparation; source-reader rename preserves its boundary. |
| DeliveryService.checkDispatch | 95 | Dispatch authorization; report composition removed, retained kinds delegated. |
| DeliveryService.checkRecordDispatch | 198 | Record/agenda eligibility; source-reader rename only. |
| DeliveryService.drain | 434 | Durable claim, transport and outcome handling; report branches removed. |
| RecordRuleService.readiness | 97 | Monitoring readiness; canonical source adapter retained. |
| RecordRuleService.detect | 89 | Monitoring matches/cursor advancement; transaction boundary preserved. |
| RecordRuleService.enqueue | 139 | Monitoring intent creation/deduplication; application-origin rename only. |
| assertEditorialAccess | 149 | Canonical access/freshness checks; validates current scheduling policy. |
| runEditorialWork | 288 | Scheduled briefing orchestration; delegates generation/approval/delivery, removes retired evidence work. |
| EditorialService.save | 126 | Exact-source validation and immutable selection; monitor/tracking duties removed. |
| EditorialService.preview | 86 | Current edited-output review; saved-report dependency removed. |
| EvidenceService.exact | 83 | Typed exact-source reads for active consumers; no intake/monitoring behavior. |
| InternalWorkflowService.preview | 139 | Workflow validation/context; report-review branch removed. |
| InternalWorkflowService.execute | 141 | Durable workflow execution; report generation removed. |
| KeywordDeliveryService.enqueue | 155 | Keyword delivery intents; application-origin rename only. |
| KeywordMeriController.route | 126 | Internal tool routing; retained reads delegate to the explicit reader service. |
| WorkflowTriggerService.detect | 109 | Trigger detection; retired templates excluded before processing. |
