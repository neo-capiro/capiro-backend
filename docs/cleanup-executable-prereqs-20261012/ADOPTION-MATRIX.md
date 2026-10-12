# CleanUp4 and CleanUp2 adoption matrix

Independent read-only audit of the prerequisite worktree at source head
`f1e83a3f194a8ebd972e370ff6e5b5f559888b29`, tree
`60033662b40ba380dae4a032fca7b02251479cba`, plus observed uncommitted executable
prerequisite edits. Actual `docs/plans/CleanUp4.md`, `CleanUp2.md` and
`architecture_review.md` were available; no fallback plan was needed. This matrix
is included in the executable prerequisite handoff, not a separate documentation
PR. The excluded scoped EngagementService reporting owner is **unassessed**;
its source, owned branches and unpublished review were not inspected.

CleanUp4:120 requires every listed callsite to adopt a seam. CleanUp4:255–267
requires a data-driven ratchet and CI wiring in the same change. CleanUp2:227
requires the duplicate-helper guard with the first canonical module. Package
existence and green builds are not adoption evidence. The later Cleanup CLI,
carrier and formatter commits do not close the production adoption gaps below.
Core formatter changes are semantic-proved only, not shared-seam adoption.

Paths are repository-relative. Source/symbol identity is authoritative; line
numbers are locating hints from the observed source, especially after formatting
(CleanUp4 R10). This audit ran no tests, native database/migration, provider,
cloud or security operations and made no production edits.

## Requirement to actual adoption

Categories: **fully implemented/adopted** applies only to the bounded item named;
**partial/duplicated**, **missing**, and **intentionally separate by plan** must
not be counted as complete Wave 1 seams. No entire Wave 1 seam was demonstrated
complete across all named callsites.

| Requirement | Category | Actual source evidence and remaining contract |
| --- | --- | --- |
| Canonical verifier node type | Fully implemented/adopted for this leaf | `packages/strategy-verifier/src/types.ts:34` defines `VerifierNode`; `apps/api-strategy/eval/run-l2.ts` imports it (observed line 45). This does not close violation vocabulary or response DTO adoption. |
| Shared typed flag registry and generic guard | Partial/duplicated; shared seam missing | The six Core guards below remain local `CanActivate` implementations; Funding's local subclass pattern does not serve them. Workspace has two private `readClioFlag` functions and separate release/env controls. Web shells retain raw keys. No single typed registry/guard adopted by API, Web, Workspace, Intel and Defense was found. |
| Violation vocabulary and DTOs | Partial/duplicated | `strategy-verifier/src/types.ts:21` still has `code: string`; `apps/api-strategy/src/agents/watcher-checks.ts:184` has `VERIFIER_TITLES: Record<string,string>`; `meri/meri.service.ts:1462` branches on raw codes. Eval's `DraftResponse` remains local. Web tracker/directory DTOs explicitly mirror server types. Sandbox's local API result omits `warnings` from its owner contract. |
| Entity-resolution and bill keys | Partial/duplicated | Canonical helpers exist in `packages/shared/src/index.ts` (`parseBillId:1055`, `formatBillId:1063`, `parseBillDesignation:1078`, `humanizeBillId:1223`). All five listed Intel callers still define local normalization/display semantics. Core still has `kindToUiType`'s alias switch. State, congress, session and display differences require explicit profiles and characterization, not blind substitution. |
| Injectable clock and RNG | Missing at named boundaries | `apps/api-strategy/src/meri/meri.service.ts:182` uses `new Date()`; `meri/context-load.ts:42` defines `jitteredDelay` with `Math.random()` at 43. Fiscal functions already accept `now` (`fiscal/fiscal.ts:17,26,35`), but grounding does not thread injected values. No adopted shared clock/RNG seam was found. |
| Shared internal HTTP client | Partial/local abstractions; cross-app adoption missing | All named families below retain direct transport/default logic. `packages/defense-client/src/index.ts:155` is a domain client, not demonstrated adoption of the cross-app transport contract. Per-call auth, failure policy and security-owned deadline/credential decisions must remain explicit. |
| Scoped persistence and read repositories | Partial; intentionally per app | Workspace `prisma/prisma.service.ts:33` explicitly documents `ws_*` without RLS; `withSystem` serves shared identity tables. Core users/memory/health controllers still inject Prisma (`users/users.controller.ts:95`, `memory/internal-memory.controller.ts:31`, `health/health.controller.ts:8`). Defense PE reads inject it at `apps/defense-api/src/program-elements/program-element-read.service.ts:197`. These examples do not prove confinement of all SQL. Workspace RLS adjudication remains security-owned under CleanUp4 §5.1. |
| Explicit required context | Partial/ambient | Workspace uses ALS in `generation/context-persistence-hold.ts:15` and `generation/generation-assurance.ts:32`; `document-agent/document-agent.service.ts:992` invokes generation without an explicit boundary argument. Strategy retains ALS in `apps/api-strategy/src/meri/strategy-governed-context.runtime.ts:4`. Existing governed wrappers do not close the required-parameter seam. |
| One validated config surface per app | Partial/bypassed | Core validates in `apps/api/src/app.module.ts:81`, but service env reads remain (inventory below). Defense has `loadDefenseConfig`, yet the live-discovery switch/model defaults bypass it. Intel, Workspace, Strategy, Meri and Onboard API use `ConfigModule.forRoot` without validation at their `app.module.ts:25,29,26,16,31`. Web checks a Clerk key then returns runtime input (`apps/web/src/env.ts:48`); Onboard Web casts fetched JSON (`apps/onboard-web/src/config.ts:21`). Neither demonstrates complete validated configuration. |
| Same-change anti-duplication and bypass guards | Missing | The six named guard scripts, helper-name data file and `gate:cleanup4` listed below were absent; no wiring references them. `docs/plans/cleanup4-progress.md` was absent. Existing context/learning/quality gates do not replace these ratchets. |

## Named Wave 1 callsite families

**Flags.** Under `apps/api/src`: `district-nexus/district-nexus-flag.guard.ts`
(`DistrictNexusFlagGuard:41`, `assertEnabledForTenant:60`),
`district-nexus-economic-flag.guard.ts:36,65`,
`district-nexus-strategic-flag.guard.ts:31,50`,
`district-nexus/priority-intelligence/priority-intelligence-flag.guard.ts:48,67`,
`business-development/business-development-flag.guard.ts:33,45`, and
`district-nexus/r5-action-layer/r5-flag.guard.ts:83,110`. The Funding local base
has subclasses at `funding-opportunities/funding-opportunities-flag.guard.ts:210`.
Workspace private readers are `apps/workspace/src/meriv2/meriv2-flags.service.ts:55`
and `quick-draft/two-step-draft-flags.service.ts:52`; release/env flags remain in
`generation/generation-assurance.ts:46` and `meriv2-flags.service.ts:29`.
Web raw keys remain in `apps/web/src/components/AppShell.tsx:213`,
`AppShellV2.tsx:71`, `vnext/adapters/routes/routeManifest.ts:190` alongside
`lib/intel-feature-flags.ts:33`. Intel's unvalidated config and Defense's direct
live switch below leave their listed flag/config findings open too.

**Contracts.** Strategy's canonical `Violation` and caller maps are listed above;
its eval still declares `DraftResponse` and string violations in
`apps/api-strategy/eval/run-l2.ts` (observed lines 82–86). Web copies remain at
`apps/web/src/pages/clients/tracker/tracker-api.ts:3` and
`pages/directory/directory-api.ts:4`. Sandbox owner `SandboxRunResult` is at
`apps/clio-sandbox/src/run.ts:37` with `warnings:46`; API's separate
`SandboxOutcome` is at `apps/api/src/meri/meri-tools.service.ts:2377` without it.

**Entity/bill helpers.** Under `apps/intel-api/src`:
`linking/bill-hearing-linker.service.ts:37` (`canonicalizeBillRef`),
`hearing/intelligence/deterministic-public-hearing-extractor.ts:81`
(`normalizeBillReference`), `sourcedata/folder-source-data.repository.ts:16`
(`normalizeBillNumber`), `watchlist/watchlist-matcher.service.ts:94`
(`normalizeBill`), and `tracker/relevance.util.ts:278,290`
(`BILL_TYPE_LABEL`, `humanizeBillId`). Core alias mapping remains
`apps/api/src/intelligence/intelligence.service.ts:5853` (`kindToUiType`).

**Intel HTTP.** Under `apps/intel-api/src`, direct calls remain at
`hearing/orchestrator.client.ts:55,79,148,294`,
`intel-alert/alert-summary.client.ts:117`,
`hearing/hearing-record-workflow.service.ts:363`, and
`tracker/reports/report-delivery.service.ts:248,828,905,977`.

**Workspace HTTP.** Under `apps/workspace/src`, calls remain at
`collaborators/collaborators.service.ts:101`,
`workspace-reasoning/workspace-reasoning.gateway.ts:202`,
`generation/context-compiler.service.ts:125`, `generation/generation.service.ts:1778`,
`drafts/research-source.controller.ts:80`, `editorial-source.controller.ts:129`,
`preparation-source.controller.ts:31`, `hillday/directory-bridge.client.ts:245`,
`meriv2/meriv2-orchestrator.client.ts:36`, `generation/memory-promotion.client.ts:40`,
`hillday/hillday-export.service.ts:173`, and `hillday-generation.service.ts:584`.
Provider/export calls need explicit policy classification, not an indiscriminate
internal-client rewrite. CleanUp4 owns transport consolidation; security owns
credential scoping and deadline policy (CleanUp4:198,204).

**Core Tango HTTP.** Under `apps/api/src/external/tango`, rate-limit/retry header
logic remains independent at `tango-dibbs.client.ts:164`,
`tango-sbir.client.ts:197`, and `tango-subaward.client.ts:70`.

**Meri HTTP/config.** Nine URL defaults remain under
`apps/meriv2-orchestrator/src/meri`: `api-action-proposal.repo.ts:107`,
`chat/chat-assistant.service.ts:109`, `meriv3/api-managed-mcp.repo.ts:31`,
`in-editor/in-editor-assistant.service.ts:106`,
`meriv3/meriv3-assistant.service.ts:996`, `meriv3/api-visual-analysis.repo.ts:17`,
`api-compliance-audit.repo.ts:32`, `workspace-gen/workspace-gen.client.ts:26`, and
`api-tool-executor.repo.ts:108`. Four repos separately parse tool timeouts.

**Config bypasses.** Core service reads remain at
`apps/api/src/memory/governed-memory-store.service.ts:34`,
`lobby-intel/lobby-intel.service.ts:101`, and
`clients/client-profile-fill-workflow.service.ts:278`. Defense's typed loader is
`apps/defense-api/src/config/defense-config.ts:47`, but
`budget-lifecycle/budget-lifecycle.module.ts:101` still passes `process.env` to
`liveDiscoveryEnabled`; model defaults remain at
`program-elements/budget-lines-read.service.ts:50`,
`program-element-read.service.ts:2290`, and `program-elements/cross-domain/ports.ts:52`.
All three repeated model defaults remain outside the typed loader.

## Registries and facade decomposition

Existing data maps alone do not close these Wave 2 conversions. The required
pre-conversion characterization receipts and progress ledger were not found.

| Plan domain or split | Category | Confirmed remaining source/symbol |
| --- | --- | --- |
| Defense semantics | Partial/duplicated | `apps/api/src/defense-budget/document-classifier.ts:40,49` keeps ordered classifier branches; `non-rdte/p1/p1-extractor-v1.ts:112,151` keeps local regex/kernel behavior. Python chamber `_COMPONENTS`, `_header_semantic` and `_row_semantic` remain separate in `apps/defense-budget-parser/src/capiro_defense_budget_parser/extractors/stages/{hasc,sasc,hacd,sacd}/semantics.py`. Requires CleanUp2 §10 cross-language ADR and mirror obligations. |
| Intel provider registry | Partial/duplicated | Provider/host decisions remain split across `apps/intel-api/src/hearing/net-guard.ts`, `stream-resolver.service.ts:193`, `capture/automatic-stream-resolver.ts`, `capture/stream-resolution-policy.ts`, `state-capture-policy.ts`. Host membership is security-owned. |
| Onboard tasks/cadence | Partial/duplicated | Keys at `apps/onboard-api/src/setup/setup.controller.ts:14` and `apps/onboard-web/src/lib/setup.ts:12`; cadence branches at `lifecycle/lifecycle.service.ts:171,383`; repeated trial duration at `setup/setup.service.ts:339`. Security owns legal transitions, cleanup owns table/owner consolidation. |
| Workspace products | Partial/duplicated | Metadata/section/page maps and `sectionSpecFor` ladder remain at `apps/workspace/src/cascade/cascade.config.ts:148,251,337,374`. |
| Web navigation/Explorer | Partial/duplicated | Three navigation/route owners remain; `apps/web/src/pages/explorer/DataExplorerPage.tsx:101,206` combines source metadata with eighteen manual render branches. |
| Strategy templates | Partial/duplicated | `apps/api-strategy/src/context/frontmatter.ts:37,59` coexists with skip/title/routing decisions in `reports/report-context.ts:36,55,394,422`. |
| Defense source catalogue | Partial | `apps/defense-api/src/budget-lifecycle/source-adapter.registry.ts:76` retains the frozen catalogue with host/cadence literals. |
| Meri recipes | Partial/duplicated | `meri/retrieval/meri-data-catalog.ts:393` coexists with runtime lists (`meri-retrieval-plan.ts:28`), query classes (`:110`) and dispatch (`meriv3/meriv3-retrieval-recipes.ts:165`) under `apps/meriv2-orchestrator/src`. |
| Dispatch/scoring | Partial/duplicated | Core `apps/api/src/meri/meri-tools.service.ts:2584` switch; Intel weights/version at `apps/intel-api/src/intel-alert/alert-scorer.ts:41,79,89`. |
| Existing facades | Partial; excluded owner unassessed | Workspace generation/document/Hill Day services still mix responsibilities; Onboard `funnel/funnel.service.ts:76` keeps broad collaborators; Meri's large `runTurn` remains at `meriv3/meriv3-assistant.service.ts:1419`. Helper imports and file size alone neither prove nor disprove a completed split. EngagementService reporting is excluded and no conclusion is made about its owner's reviewed work. |

## Missing same-change controls and preserved boundaries

At the audited snapshot, these were absent: `scripts/check-http-client-bypasses.mjs`,
`check-config-env-bypasses.mjs`, `check-flag-registry-bypasses.mjs`,
`check-tenant-scope-bypasses.mjs`, `check-registry-ownership.mjs`,
`check-duplicate-helpers.mjs`, `duplicate-helper-names.txt`, and root
`gate:cleanup4`. No workflow wiring references them. A future seam conversion
must include its data-driven additions ratchet, CI wiring, explicit callsite
closure and behavior characterization in the same independently reviewable slice.
Cleanup prerequisite carrier/coverage/CLI checks are a separate deliverable.

| Boundary | Category | Preserve |
| --- | --- | --- |
| Context Plane type contract | Intentionally separate by plan | `apps/api/src/context/context-plane.contract.ts:15` exports only the packet type. Helpers belong beside it, never inside (CleanUp2:290). Existing implementation-import bypass guard is wired at `.github/workflows/context-plane-architecture-guard.yml:38`. |
| Eight thin product adapters | Intentionally separate by plan | Meri, meetings runtime, Workspace, Outreach, LegiWatch, Strategy, clients and engagement-meeting retain separate product reasoning seams (CleanUp2:484). Merge common helpers, not adapter ownership. |
| Persistence/feature modules | Intentionally separate by plan | Per-app repositories and bounded capability modules remain separate; no universal folder or shared persistence replacement is proposed. Workspace RLS/security disputes stay with their existing owner (CleanUp4 §5.1). |
| Isolated defense runtime mirror | Intentionally separate by plan | CleanUp2:489/CleanUp4:228 require isolation and same-change mirrored edits. `scripts/verify-phase8-session4.mjs`'s `treePairs` compares source/mirror tree identities. Do not replace the mirror with imports from Core or decommission it without its own acceptance. |
| Offline orchestrator/shadow packaging | Intentionally separate by plan | `apps/defense-parser-orchestrator/README.md:5,15` documents its separate offline plane; `apps/engagement-api/README.md:7` documents shadow source reuse. Packaging or CLI qualification does not settle new runtime ownership. |

The finite remaining work is the named seam/adoption/guard set, nine registry
domains with their characterization and ownership gates, and bounded facade/config
conversions. This matrix does not expand the executable prerequisite PR into
those production refactors, authorize security-owned changes, or assert native
acceptance or whole-system completion.
