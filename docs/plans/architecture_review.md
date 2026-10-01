# Architecture Review — `apps/*`

**Scope:** all 13 application folders under `apps/` (api, api-strategy, clio-sandbox, defense-api,
defense-budget-parser, defense-parser-orchestrator, engagement-api, intel-api, meriv2-orchestrator,
onboard-api, onboard-web, web, workspace).
**Focus:** (A) what can be **data-driven**, (B) what can be **abstracted / de-duplicated** to make the
code cleaner, and (C) other **poor architecture** items.
**Status:** review only. No code was changed, no service was contacted, no command was run against the
apps. This document is the detailed evidence ledger.

**Evidence commits:** findings were captured at `67bab09`; they were **re-verified against `c816b240c`**
(984 commits later). Every finding is still live — none was resolved or removed — but counts, file sizes
and several paths were refreshed and a few claims corrected. See “Re-validation” at the end.

**Merged into the CleanUp series as `docs/plans/CleanUp4.md`.** That plan is the executable merge: it
turns these findings into waves, gates and ratchet guards. This document stays the ledger it reads from,
exactly as `cleanup2-dup-inventory.generated.md` feeds CleanUp2.

**Disposition.** Not every finding is CleanUp4's to fix:

* Items already mentioned in `docs/security/SECURITY_REVIEW.md` are **owned by that document** and are
  noted inline as *Covered by `SECURITY_REVIEW.md`* — do not re-plan them in CleanUp4.
* Items already owned by CleanUp2 / CleanUp3 (exact-duplicate and duplicate-test removal) are owned by
  those plans. See “Disposition — what is already owned elsewhere” below.

## How this review was produced

- **One read-only exploration pass per app folder**, 13 in parallel, all against a shared taxonomy
  (A data-driven · B abstraction / de-duplication · C other architectural concerns).
- Findings were required to cite real `file:line` evidence and to distinguish **confirmed** (directly
  read) from **suspected**.
- **Line numbers will drift.** Treat every `path:line` as a locating hint and re-grep by symbol before
  acting.

### Relationship to existing work (deliberately not repeated here)

- `docs/plans/CleanUp1.md`, `CleanUp2.md`, `CleanUp3.md` and
  `docs/plans/cleanup2-dup-inventory.generated.md` already own the **duplicated-code inventory**
  (1,559 groups / 20,856 wasted lines). This review does **not** restate that inventory; where a
  finding overlaps it, the finding is about *structure* (why the duplication exists, what abstraction
  removes the class of it), not the line-level ledger.
- `docs/security/SECURITY_REVIEW.md` owns vulnerabilities. This review is structural; security is out
  of scope except where an architectural defect (e.g. ambient context, unenforced tenancy) is the
  enabling mechanism.

### Disposition — what is already owned elsewhere

A finding that is already mentioned in the security document is **not** remediated here; it is noted
inline in the app section as *Covered by `SECURITY_REVIEW.md`* and left to that document's R1–R20
trail. Likewise, exact-duplicate work already listed in CleanUp2/CleanUp3 is owned there.

**Owned by `docs/security/SECURITY_REVIEW.md`** (do not re-plan in CleanUp4):

| finding here | SECURITY_REVIEW.md reference |
|---|---|
| `clio-sandbox O1` — no CDK service definition | §8, ADR claim 1 (Fargate/SG/task role unverifiable) |
| `clio-sandbox O2` — in-memory admission / no per-tenant limit | §3 (cost/DoS controls per-process) |
| `workspace A2` — shared `INTERNAL_SERVICE_SECRET` / no deadlines | Top-5 #1; §8 (deadline-less internal calls) |
| `onboard-api O1` — setup-task transitions bypass CAS | #26 (any `from → to`) |
| `onboard-api D1` — setup-task machine defined in six places | #26 (partial — legal transition graph) |
| `intel-api D1` — host allowlist duplicated (security-sensitive) | §6 (`net-guard.ts` is the SSRF choke point) |
| `defense-api O4` — unvalidated network-enabling env switch | cross-cutting theme 4 (`NODE_ENV=development`) |
| `workspace O2` — `ws_*` tenancy by convention | **conflicts** with §“What is in good shape” (tenancy) — escalate |

**Owned by CleanUp2 / CleanUp3:** `api A1` (CleanUp2 Wave 1e), `api D1` / `defense-api A2` (CleanUp2
Wave 1b), `defense-budget-parser A1/A2/D1/D2` (CleanUp2 Wave 3, CleanUp3 §5), `api O2` (CleanUp2 §9),
`web A1/A2/A4` (CleanUp2 Wave 1g), chamber composer specs (CleanUp3 §5).

## Executive summary

The monorepo is not one architecture problem — it is a small number of patterns repeated across
thirteen apps. Ranked by how much surface they touch:

1. **Business rules live in code, not data.** Domain vocabularies (agencies, exhibits, committees,
   jurisdictions, providers, budget semantics), label maps, scoring weights, thresholds and cadences
   are literals inside branch chains in *every* app. Each new source/exhibit/agency/tenant/vertical
   is a code edit plus a deploy. This is the single largest source of both duplication and fragility.
2. **"Twin" implementations.** Whole verticals are copy-adapted rather than parameterised:
   HAC-D vs SAC-D stages, Hill-Day vs draft-engine in `workspace`, legacy vs vNext in `web`,
   rail-twin repositories in `intel-api`, batch vs async coordinators in
   `defense-parser-orchestrator`, three Tango clients, five bill-identifier resolvers.
3. **God modules.** `apps/api` (12.2k-line `EngagementService`, 10.3k `meri-tools`, 8k
   `intelligence`), `apps/web` (5.2k `EngagementPage`, 3.9k chat controller), `apps/workspace`
   (1.8k `generation.service`), `intel-api` (1.8k tracker board), `defense-parser-orchestrator`
   (`session5.mjs`), plus a ~1,750-line `runTurn`. These destroy test seams and force `as never` casts.
4. **No persistence seam / raw SQL in the wrong layer.** `apps/api` has ~397 services vs 25
   repositories and 179 files using `$queryRawUnsafe`; nine controllers inject `PrismaService`
   directly; `defense-api` PE reads bypass the port pattern its sibling modules use.
5. **Config and flags are read inconsistently.** Direct `process.env` reads bypass validated config
   modules (`apps/api` 59 services, `intel-api` ~200 sites, `workspace` two ALS stores, `defense-api`
   an unvalidated network-enabling switch); feature flags exist in up to four parallel mechanisms.
6. **No shared outbound HTTP client.** `intel-api` (22 `fetch` sites), `workspace` (12), `meriv2`
   (9 copies of the same base-URL default) each re-derive timeout, auth header and error mapping.
7. **Contracts are re-declared, not shared.** TS DTOs are hand-mirrored in ~65 web `*-api.ts`
   modules; the eval harness re-declares the strategy-type union; Python and TS each own budget-line semantics
   with no parity gate; the sandbox wire contract is duplicated.
8. **Code that is built but never executed (and never gated).** `defense-api`'s `runtime-source/`
   (~206k lines) is outside its build; `defense-budget-parser`'s semantic extractors are reachable
   only from tests; `defense-parser-orchestrator` has no in-repo consumer and is not a workspace
   package; `api-strategy`'s L2 eval bypasses the app it grades; `engagement-api` is packaging-only.
9. **Cross-app vocabulary divergence.** Five bill-identifier normalizers in `intel-api`; a 26-case
   entity-kind alias ladder shared in spirit with `intel-api`; three role vocabularies across
   `onboard-web`/`shared`; money helpers duplicated in `shared` and `defense-domain`.
10. **Missing determinism/test seams.** `new Date()`/`Math.random()` in grounding paths, ambient
    `AsyncLocalStorage` that enforcement depends on but no type enforces, and several apps with zero
    tests behind their largest modules.

Almost every finding is a **seam** problem: the code works, but the place where policy is allowed to
vary is not a data structure, not an injected dependency, and not a shared contract — it is a
branch chain in a 2,000-line file.

## Finding counts by app

| app | data-driven (A) | abstraction (B) | other (C) | total |
|---|---:|---:|---:|---:|
| api | 5 | 4 | 4 | 13 |
| api-strategy | 5 | 4 | 4 | 13 |
| meriv2-orchestrator | 5 | 4 | 4 | 13 |
| web | 4 | 4 | 4 | 12 |
| intel-api | 3 | 4 | 5 | 12 |
| defense-api | 3 | 4 | 4 | 11 |
| defense-budget-parser | 3 | 3 | 4 | 10 |
| workspace | 3 | 2 | 3 | 8 |
| onboard-api | 3 | 2 | 3 | 8 |
| onboard-web | 2 | 3 | 3 | 8 |
| defense-parser-orchestrator | 3 | 2 | 3 | 8 |
| clio-sandbox | 2 | 1 | 2 | 5 |
| engagement-api | 1 | 2 | 1 | 4 |
| **total** | **42** | **39** | **44** | **125** |

---

# Cross-cutting themes

These are the issues that recur in 3+ apps. They are the highest-leverage refactors because a single
decision (a shared registry shape, a shared client, a shared contract package) removes the same defect
from many places at once.

## T1 — Domain knowledge encoded as branch chains instead of tables

The same shape appears in at least 9 apps: an ordered `if`/`switch`/regex ladder that classifies
inputs by keyword, where the *ordering* is load-bearing and undocumented.

- `apps/defense-api` `runtime-source/defense-budget/document-classifier.ts:40,48,76` — component and
  exhibit assignment by ~15 filename regexes; a comment admits R-1 must precede R-2.
- `apps/defense-budget-parser` `extractors/stages/{hasc,hacd,sasc,sacd}/semantics.py` — the same
  service→code regex bank copied 6× with **divergent membership**.
- `apps/api` `src/defense-budget/non-rdte/*` — nine extractors each with their own
  `groupCellsByRow`/`findHeaderRow`/`isTotalRow` and literal-identical regexes.
- `apps/api` `src/meri/meri-tools.service.ts:2528-2841` — a 132-case tool dispatch switch over
  schemas that already live in `@capiro/shared`.
- `apps/api` `src/intelligence/intelligence.service.ts:5837` — 26-case entity-kind alias ladder.
- `apps/onboard-api` `lifecycle.service.ts:170-182` — cadence buckets as inline literals.
- `apps/workspace` `cascade/cascade.config.ts:374-431` — 7-branch regex ladder as the drafting contract.
- `apps/meriv2-orchestrator` `meri/retrieval/meri-retrieval-plan.ts:322-357` — 5-arm planning tertiaries
  that shadow the catalog.
- `apps/intel-api` `alert-scorer.ts:41,89` — scoring weights and bands as frozen constants.

**Direction:** a per-domain rule/descriptor table (data or a typed registry) evaluated by one generic
loop, with priority made explicit. `apps/defense-api`'s `verification/rules/rule-registry.ts` and
`apps/api-strategy`'s typed template tables are the in-repo precedent to copy.

## T2 — Twin verticals that should be one parameterised path

- `apps/defense-api` HAC-D vs SAC-D `stages/appropriations/{hacd,sacd}/*` — files differ by 12–34
  lines across 255–422-line modules; only a committee token differs.
- `apps/workspace` draft-engine (`WsDraft`) vs Hill Day (`WsHillDayDocument`) — separate generation
  loop, SSE job state, export signing and ACL for a second table family.
- `apps/web` legacy `pages/*` vs `vnext/pages/*` — the same screens and the same endpoints twice, with
  ≥134 "re-skin" marker occurrences in 118 files; the dashboard is implemented three times.
- `apps/intel-api` `source-data.repository.ts` vs `state-source-data.repository.ts` ("state-rail twin").
- `apps/defense-parser-orchestrator` `real-async.mjs` vs `real-batch-coordinator.mjs` (the latter
  disabled) — two full submit/reconcile/retry/drain/DLQ/cost implementations.
- `apps/api` three Tango clients (`tango-dibbs`, `tango-sbir`, `tango-subaward`) each re-implementing
  rate-limit parsing and pagination.

**Direction:** one parameterised core plus per-variant descriptors/adapters, rather than a copied tree.

## T3 — God modules and megamethods

| location | size |
|---|---|
| `apps/api/src/engagement/engagement.service.ts:1042` | 12,229 lines, ~245 members, 18 collaborators |
| `apps/api/src/meri/meri-tools.service.ts` | 10,252 lines |
| `apps/api/src/intelligence/intelligence.service.ts` | 8,013 lines |
| `apps/web/src/pages/engagement/EngagementPage.tsx` | 5,195 lines, 25 subcomponents |
| `apps/web/src/components/chat/useMeriChatController.ts` | 3,906 lines, 41 `useState` |
| `apps/web/src/pages/explorer/DataExplorerPage.tsx` | 3,015 lines, 139 `useState` |
| `apps/workspace/src/generation/generation.service.ts` | 1,813 lines |
| `apps/intel-api/src/tracker/tracker-board.service.ts` | 1,810 lines |
| `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts:907-2657` | ~1,751-line `runTurn` |
| `apps/onboard-api/src/funnel/funnel.service.ts` | 886 lines |

**Direction:** split by capability behind the existing facade; the consequence being fixed is
**testability** — several of these have no seam to inject a fake model client, clock or DB.

## T4 — Persistence has no enforced seam

- `apps/api`: 397 `*.service.ts` vs 25 `*.repository.ts`; 179 files call
  `$queryRawUnsafe`/`$executeRawUnsafe`; 9 controllers inject `PrismaService` directly
  (`users/users.controller.ts:94`, `memory/internal-memory.controller.ts:31`, …).
- `apps/defense-api`: PE reads make 66 direct `this.prisma.` calls
  (`program-element-read.service.ts:196-197`) while sibling lifecycle modules use port + store with
  in-memory doubles.
- `apps/workspace`: tenancy is convention-only — `ws_*` tables have no RLS and every query must
  hand-carry `tenantId`; background paths drop it (`hillday-generation.service.ts:272,275,439`).
- `apps/intel-api`: `source-data.repository.ts` carries 39 raw-SQL calls in one 1,609-line class.

**Direction:** confine SQL to repository/persistence adapters; where tenancy is a backstop concern,
enforce it with a scoped client extension or RLS so an unscoped query is the exception.

## T5 — Config and flags: many mechanisms, none authoritative

- Direct `process.env` reads bypass validated config: `apps/api` 59 services vs a 1,276-line
  `config.schema.ts`; `apps/intel-api` ~200 sites vs ~20 `ConfigService.get()` calls, with the *same* flags read
  both ways (`net-guard.ts:119,130` vs `stream-resolver.service.ts:128-129`); `apps/defense-api`
  `budget-lifecycle.module.ts:37-38` reads a network-enabling switch outside `loadDefenseConfig()`.
- Feature flags exist in four parallel mechanisms: `apps/workspace` has two copy-pasted flag services
  (`meriv2-flags.service.ts`, `two-step-draft-flags.service.ts`), plus a release-gate config and
  `MERIV2_ENABLED`; `apps/web` has stringly-typed keys split across two systems; `apps/api` has six
  near-identical flag guards.
- Repeated defaults: `?? 'http://localhost:3000'` in 9 files (`apps/meriv2-orchestrator`),
  `EMBEDDINGS_MODEL` defaulted in 3 places (`apps/defense-api`).

**Direction:** one validated config surface per app; one typed flag registry; base-class a generic
`FeatureFlagGuard`.

## T6 — No shared outbound HTTP client

- `apps/intel-api`: 22 direct `fetch()` sites, each with hand-rolled `AbortController`/timeout/headers
  and internal-secret semantics (`orchestrator.client.ts:55,79,148,294`, …).
- `apps/workspace`: 12 sites with four incompatible timeout idioms and timeouts from 10s to 60s.
- `apps/meriv2-orchestrator`: three copies of the Clio tool-schema fetch and three divergent
  sleep/retry curves.
- `apps/api`: Tango rate-limit/pagination re-implemented per client.

**Direction:** one internal-API client (base URL, secret, timeout, JSON/error mapping, policy hooks)
injected everywhere; keep per-call-site auth explicit for secrets that differ.

## T7 — Contracts re-declared instead of shared

- `apps/web`: ~65 per-feature `*-api.ts` modules hand-mirror server types and re-declare paths/keys
  (`tracker-api.ts:149-177` literally comments "Types mirror apps/api/…").
- `apps/api-strategy`: the eval harness re-declares the verifier types and conversion
  (`eval/run-l2.ts:123-137`, "mirroring production"); `packages/strategy-verifier` exports a
  stringly-typed `code: string` contract that consumers re-widen.
- Python ↔ TS: `defense-budget-parser`'s semantic extractors and `apps/api`'s TS extractors both own
  budget-line semantics with **no parity test**; the existing tree-SHA mirror gate does not cover them.
- `apps/clio-sandbox`: the sandbox wire contract is hand-mirrored in TS and re-declared by the API.
- Cross-app roles/entities: three role vocabularies (`onboard-web`, `@capiro/shared`, `apps/api`),
  five bill-identifier normalizers (`intel-api`), duplicated money helpers
  (`@capiro/shared/money.ts:26` vs `@capiro/defense-domain`).

**Direction:** promote the true contracts into `packages/shared` (or a domain package) and generate or
import them; add a parity gate where two languages must agree.

## T8 — Unbuilt / ungated seams (code that exists but nothing enforces or runs)

- `apps/defense-api/runtime-source/` (~206k lines) is outside the app's `tsconfig` and the
  `Phase17RuntimePorts` adapter reads+hashes JSON fixtures instead of invoking it.
- `apps/defense-budget-parser/extractors/` (~2.9k lines, 6 stages) is reachable only from tests.
- `apps/defense-parser-orchestrator` is not a workspace package (`pnpm-workspace.yaml:2` claims
  `apps/*`, but no `package.json`), so `@capiro/defense-contracts` is unreachable and CI uses a
  hardcoded `node --check` file list.
- `apps/api-strategy/eval` never executes `MeriService.draft()`, so a regression in the app cannot
  fail L2.
- `apps/engagement-api` is packaging-only; ownership is explicitly unresolved.

**Direction:** for each, pick a posture — compile it, wire it, gate it, or move it out and delete the
illusion. An ungated seam is worse than no seam because it reads as covered.

## T9 — Determinism and ambient state over injection

- `apps/api-strategy` threads governed context through ambient `AsyncLocalStorage` **and** runtime
  method monkey-patching on the service instance, so the orchestrator client's correctness depends on
  an out-of-band wrapper having run (`governed-strategy-meri.factory.ts:44-52`, `:313-327`).
- `apps/workspace` enforcement depends on two ALS stores plus Prisma middleware that are only
  populated when a caller wraps deliberately — and one vNext path does not wrap
  (`document-agent.service.ts:992`), silently skipping the persistence hold and release gate.
- `apps/api-strategy` grounds on `new Date()`/`Math.random()` in paths that are otherwise injectable
  (`meri.service.ts:181-187`, `context-load.ts:43`).

**Direction:** make required context a parameter or request-scoped provider so an unwrapped call is a
**compile error**, not a silent downgrade; inject clocks and RNG.

---

# Per-app findings

Legend: **A** = data-driven opportunity · **B** = abstraction / de-duplication · **C** = other
architectural concern. "Confirmed" = verified by direct read; "Suspected" = inferred.

---

## `apps/api`

**Scope:** TypeScript NestJS + Prisma monolith, `src/` ~3,451 `.ts` files across ~85 modules and 146
controllers, plus 628 `scripts/*.ts`; entry points `src/main.ts`, `src/engagement-main.ts`.
**Summary:** Well-documented but heavily accreted monolith. Weaknesses are per-variant code that should
be data-driven (defense-budget exhibits, Florida-only jurisdiction logic, tool dispatch), several God
modules, and a layer discipline where raw SQL and Prisma calls spread across services and controllers.

### A. Data-driven opportunities
- **[D1] Per-exhibit extractor/builder pairs copy-pasted per form** — `src/defense-budget/non-rdte/{p1,p5,o1,c1,p21,p40,p3a,op5,dd1391}/*-extractor-v1.ts` + `*-artifact-builder-v1.ts` (also `rdte/{r1,r2,r2a,r3,r4}`). Nine folders hand-roll the same header-binding → unit → evidence pipeline. Adding an exhibit means a new module, not a new table row. *Confirmed.* → one exhibit spec (column bindings, identity key, section map) consumed by a generic extractor/builder.
- **[D2] Florida is the only jurisdiction but modules claim to be generic** — `src/hearing-discovery/florida-*.ts` (now 29 files); the old `FLORIDA_FIRST_PARTY_HOSTS` constant was removed and the first-party gate is now a generic regex at `stream-candidate.repository.ts:45`, while `src/live-hearings/legiwatch-state-capture-policy.ts` still keys behaviour by policy literal. A second state means forking `legiwatch-*`. *Confirmed.* → jurisdiction descriptor registry (state → sources, hosts, adapter, calendar policy).
- **[D3] 132-case tool dispatch switch** — `src/meri/meri-tools.service.ts:2528-2841`; schemas already live in `@capiro/shared` (`TOOL_DEFINITIONS`, line 2). *Confirmed.* → `Map<toolName, handler>` validated for exhaustiveness against the shared definition list.
- **[D4] Entity-kind alias ladder** — `src/intelligence/intelligence.service.ts:5837` (26 literal cases: `client`/`lda_client`, `bill`/`congress_bill`). *Confirmed.* → one alias→canonical table shared with entity resolution.
- **[D5] Config read from `process.env` inside services** — 59 `*.service.ts` bypass `src/config/config.schema.ts` (1,276 lines): `memory/governed-memory-store.service.ts:34`, `lobby-intel/lobby-intel.service.ts:101`, `clients/client-profile-fill-workflow.service.ts:260`. *Confirmed.* → route all runtime knobs through `ConfigService`.

### B. Abstraction / de-duplication opportunities
- **[A1] Six near-identical feature-flag guards** — `district-nexus/district-nexus-flag.guard.ts:41`, `district-nexus-economic-flag.guard.ts:36`, `district-nexus-strategic-flag.guard.ts:31`, `priority-intelligence/priority-intelligence-flag.guard.ts:48`, plus `business-development/business-development-flag.guard.ts:33` and `district-nexus/r5-action-layer/r5-flag.guard.ts:83`. `funding-opportunities-flag.guard.ts:166` already solved this with a base class. *Confirmed.* → extract `FeatureFlagGuard` parameterised by flag name. *(CleanUp2 Wave 1e merges the shared helper; CleanUp4 adds the base class.)*
- **[A2] Tango client family re-implements rate-limit/pagination** — `external/tango/tango-dibbs.client.ts:167`, `tango-sbir.client.ts:200`, `tango-subaward.client.ts:73` parse `retry-after`/`ratelimit-*` identically. *Confirmed.* → one shared Tango HTTP adapter with per-endpoint mappers. *(Transport is CleanUp4's; credential scoping for these clients is owned by `SECURITY_REVIEW.md` top-5 #1.)*
- **[A3] Governed-deliverable pipeline duplicated across briefs** — `intelligence/alert-memo/alert-memo.service.ts` and `district-brief.service.ts` share the same flow (`runAuditor`, `applySkepticEscalation`, `applyEntailmentGate`, `ContextCompilerService`, `ReviewsService`, `AiCredentialResolverService`). `hearing-recap.service.ts` no longer shares that flow (the third-variant claim is resolved). *Confirmed.* → shared governed-generation service; brief types become templates.
- **[A4] No repository layer — SQL lives in services** — 397 `*.service.ts` vs 25 `*.repository.ts`; 179 files use `$queryRawUnsafe`/`$executeRawUnsafe` (`clients/client-profile-fill-completion.service.ts:473`; `intelligence.service.ts` alone 74 raw queries). *Confirmed.* → confine SQL to persistence adapters.

### C. Other architectural concerns
- **[O1] God service `EngagementService`** — `src/engagement/engagement.service.ts:1042`, 12,229 lines / ~245 members / 18 collaborators. Also `meri-tools.service.ts` (10,252) and `intelligence.service.ts` (8,013). *Confirmed.* → split by capability behind the facade.
- **[O2] Circular DI cluster in memory** — `memory/memory-cleanup-outbox.service.ts:103`, `governed-memory-store.service.ts:26`, `governed-memory-ingest.service.ts:35` wired with `forwardRef`. *Confirmed.* → invert one edge (event/outbox). *(Already listed in CleanUp2 §9 — owned there.)*
- **[O3] Controllers doing data access** — 9 controllers inject `PrismaService` directly (`users/users.controller.ts:94`, `memory/internal-memory.controller.ts:31`, `health/health.controller.ts`, …). *Confirmed.* → move reads into services.
- **[O4] Inconsistent ingestion tooling adoption** — 105 `scripts/sync-*.ts`, only 33 use `src/ingestion/sync-run.helper.ts` (68 scripts import it overall); the rest hand-roll watermark/lock/metrics. *Confirmed.* → require the shared runner.

**Cross-app:** feature-flag guard base and the entity-kind/alias table are `packages/shared` candidates.
`src/defense-budget/**` is tree-SHA-mirrored into `apps/defense-api/runtime-source/**` — D1 must land on
both sides in one commit or CI fails.

---

## `apps/web`

**Scope:** React 18 SPA on Vite (not Next.js) — ~1,204 non-test source files / ~403k LOC across
`pages/` (~24 modules), `components/`, `vnext/`, `lib/`, `state/`; antd + custom `--capiro-*` tokens;
React Router v6 + TanStack Query; 648 test files. Serves two surfaces (classic and vNext) from one
bundle, selected at runtime.
**Summary:** The dominant cost is a duplicated presentation/data layer: legacy `pages/*` and
`vnext/pages/*` reimplement the same screens against the same endpoints, compounded by three parallel
navigation/route models and several God components.

### A. Data-driven opportunities
- **[D1] Data Explorer is an 18-branch render ladder over an existing registry** — `pages/explorer/DataExplorerPage.tsx:101-123` (SOURCES) and `:206-223`. `SOURCES` already declares key/label/description, but the tab body is a hand-written ternary chain mapping each key to a bespoke `*Explorer`. *Confirmed.* → a source-definition table driving one generic explorer.
- **[D2] Navigation/route metadata exists in three divergent models** — `components/AppShell.tsx:133`, `components/AppShellV2.tsx:51/58/84`, `vnext/adapters/routes/routeManifest.ts:31`, plus the if-ladder in `vnext/app/VNextRouter.tsx:126-268`. Same items, different membership (`federal-spending` only in AppShellV2). *Confirmed.* → one route/nav manifest.
- **[D3] Same per-tenant/gate logic reimplemented per shell** — `AppShell.tsx:425` vs `AppShellV2.tsx:186` vs `routeManifest.ts:206-207`; tenant label at `AppShell.tsx:267`, hardcoded `'Defense Budget'` at `AppShellV2.tsx:81`, `tenantLabels` at `routeManifest.ts:16,213`, `capiro-internal` slug checks at `App.tsx:535,541`. *Confirmed.* → one gating/labelling function + tenant-config map.
- **[D4] Feature-flag keys are stringly typed and split across two systems** — `lib/intel-feature-flags.ts:20-31` vs raw literals `'district_nexus_v2'`/`'funding_opportunities'` at `AppShell.tsx:213,223`, `AppShellV2.tsx:71,78`, `routeManifest.ts:181,188`. *Confirmed.* → single typed flag registry.

### B. Abstraction / de-duplication opportunities
- **[A1] ~65 per-feature `*-api.ts` modules hand-mirror server types** — e.g. `pages/clients/tracker/tracker-api.ts:3` ("Types mirror apps/api/…"), `pages/directory/directory-api.ts:1-5`. *Confirmed.* → shared/generated DTOs + one typed endpoint/path builder.
- **[A2] vNext re-skins duplicate the legacy layer 1:1** — `vnext/pages/bills/dossier-primitives.tsx:15` (explicit "re-skin of `components/dossier/*`"), 7 duplicated `vnext/pages/bills/Bill*Tab.tsx`, `pages/strategy/api.ts` vs `vnext/pages/strategies/strategies-api.ts` (both define `useStewardInvalidate`/`useAgentsInvalidate`/`useExecutionInvalidate`/`useWatchInvalidate`); ≥134 "re-skin" markers across 118 files. *Confirmed.* → share behaviour/hooks; isolate only the presentation layer.
- **[A3] Dashboard implemented three times** — `pages/HomePage.tsx:388` (`useDashboardVisibility`), `vnext/adapters/legacy/useDashboardVNextModel.ts` (2,016-line adapter), `vnext/pages/dashboard/DashboardVNext.tsx`. *Confirmed.* → one model hook, presentation-only swap.
- **[A4] Local reimplementations of shipped primitives** — `pages/workspace/SetupPage.tsx:25` duplicates `lib/use-debounced-value.ts:4`; in-file search/filter scaffolds repeated in every explorer. *Confirmed.* → import the shared hook and field primitives.

### C. Other architectural concerns
- **[O1] God components with business logic in render files** — `DataExplorerPage.tsx` 3,015 LOC / 139 `useState`; `EngagementPage.tsx` 5,195 LOC; `useMeriChatController.ts` 3,906 LOC / 41 `useState`; `OutreachView.tsx` 3,537. Explorer/dashboard/onboarding/help dirs have **0 tests**. *Confirmed.* → extract controllers/domain modules; add test seams.
- **[O2] Client/server boundary bypass** — `useMeriChatController.ts:697,755,1296` builds its own `fetch` + Bearer headers against `config.apiBaseUrl` instead of `useApi()`, bypassing timeout escalation, impersonation header and engagement-preview interception in `lib/api-client.ts`. *Confirmed.* → route through the shared client.
- **[O3] Query-key scoping is inconsistent** — 382 files call `useQuery`, only 88 use `useApiScope` (48 non-test); `['me']` (`lib/me.ts:86`) and `['clients']` (`AppShell.tsx:293`) are unscoped, with correctness resting on a blanket `qc.invalidateQueries()` (`CapiroAdminPage.tsx:121`). *Suspected.* → fold scope into shared key factories.
- **[O4] Styling sprawl / dual token systems** — `theme.css` is 24,421 lines (518 KB), can never coexist with 184 CSS files (`vnext-meri.css` 168 KB, `legiwatch.css` 126 KB); surface selection is a top-level dynamic import (`main.tsx:18-26`). *Confirmed.* → split legacy CSS; vNext to tokenised primitives only.

**Cross-app:** bill/dossier DTOs and the nav/route manifest are strong `packages/shared` candidates.

---

## `apps/defense-api`

**Scope:** `src/**` (114 `.ts` files, 85 non-spec: app/lifecycle/PE-read/ingest) plus `runtime-source/defense-budget/**`.
**Summary:** The Nest layer is disciplined (ports+stores for lifecycle, injected cross-domain provider
factory, a real verification rule-registry). Problems cluster where budget knowledge is encoded —
organised per publisher, per exhibit and per committee, each copy carrying its own regexes and label
tables. Separately, the "trusted runtime" is a hash simulation over an unbuilt mirror tree.

### A. Data-driven opportunities
- **[D1] Publisher/component recognition is an ordered regex ladder in code** — `runtime-source/defense-budget/document-classifier.ts:40` (`detectComponent`), `:49` (`classifyDocument`); comment at `:78` admits R-1 must precede R-2. Ordering is load-bearing and a reorder silently reclassifies documents. *Confirmed.* → per-family rule table (patterns + priority + component/authority/family) evaluated by one loop.
- **[D2] Official-source catalogue hardcoded in a frozen array** — `src/budget-lifecycle/source-adapter.registry.ts:76-252`; every publisher, host list, cadence and the one-off `comptroller.defense.gov → comptroller.war.gov` migration (`:94`, `:233`) are literals. Shipping a new publisher or rate change is a deploy. *Confirmed.* → keep the registry API/fail-closed check, load rows from data seeded at boot.
- **[D3] Per-agency/per-FY ingestion onboarding is a bespoke module** — `runtime-source/defense-budget/governed-import/army-r2-seed-plan.ts:9` (`ARMY_FY24_R2_EXPECTED_IDENTITY`), consumed at `:37`. *Suspected (may be a one-off backfill).* → express the seed plan as a catalogue-driven function parameterised by `{fiscalYear, component, family}`.

### B. Abstraction / de-duplication opportunities
- **[A1] HAC-D and SAC-D stage modules are near-byte-identical** — `stages/appropriations/hacd/*` vs `.../sacd/*`: `composer` 261 vs 261, `reports` 255 vs 255, `emission` 397 vs 422, `source-profile` 54 vs 54; after normalising committee/prefix renames the bodies differ by only **14 / 14 / 53 / 8** lines (emission has drifted furthest). *Confirmed.* → one parameterised appropriations stage; committee is a value.
- **[A2] Nine per-exhibit extractors each redefine the same table kernel and regexes** — `groupCellsByRow` in 9 files (`c1:597`, `o1:553`, `p1:369`, `p21:446`, `p3a:443`, `p40:509`, `p5:628`, `op5:590`, `dd1391:507`); `findHeaderRow` ×8; `isTotalRow` ×7; literal-identical `LONG_BLIN_RE`/`SHORT_LI_RE`/`ADVANCE_PROC_RE` ×5 (`p1:112-116`, `p21:99-101`, `p3a:116-118`, `p40:119-121`, `p5:139-141`). *Confirmed.* → one shared page-table kernel + per-exhibit descriptor.
- **[A3] Two label→unit detectors with opposite unknown handling** — `extractors/types.ts:169` (`detectUnit`, defaults `'thousands'`) vs `non-rdte/unit-semantics-v1.ts:39` (`detectPrintedUnit`, returns `undefined`). Money magnitude can be silently inferred by default. *Confirmed.* → single detector; callers choose default-or-refuse.
- **[A4] `normalizeMoneyToMillions` exists twice; ingestion uses the float copy** — `packages/shared/src/money.ts:26` duplicated at `packages/defense-domain/src/money/index.ts:15`; the exact-decimal `normalizeExactMoneyToMillions` (`:105`) is unused by the app (`verification/budget-verification.ts:20`, `assertion-mapper.ts:16` import `@capiro/shared/money`). *Confirmed.* → delete the shared copy; route parsers to the exact-decimal helper.

### C. Other architectural concerns
- **[O1] `runtime-source` is neither compiled nor executed — the "runtime" seam is a fixture hash** — `tsconfig.json:7,20-27` (rootDir `src`), `src/runtime/phase1-7-runtime.adapters.ts:43-53,86-92,138-146`. ~206k lines sit outside the build and the port reads+hashes JSON fixtures. *Confirmed.* → decide one posture (compile the mirror or move it out) and derive the manifest provenance.
- **[O2] N+1 on a read path** — `src/budget-lifecycle-product/prisma-budget-lifecycle-read.store.ts` `listReviewQueue` (`:258-273`, loop at `:270`): one `$queryRawUnsafe` per review-required source inside a loop, on a user-facing query. *Confirmed.* → single lateral/`IN` query.
- **[O3] Two persistence styles; PE reads have no seam** — `src/program-elements/program-element-read.service.ts:196-197` (66 direct `this.prisma.` calls; `budget-lines-read.service.ts` 30, `programs.service.ts` 26) vs `src/budget-lifecycle/budget-lifecycle.module.ts:65-70` (port + store with in-memory doubles). *Confirmed.* → extract PE repos behind the port pattern.
- **[O4] Unvalidated env read bypasses the validated config module** — `src/budget-lifecycle/budget-lifecycle.module.ts:37-38,101` (`PHASE8_SESSION8_LIVE_DISCOVERY`, a network-enabling switch); `EMBEDDINGS_MODEL` defaulted in three places (`budget-lines-read.service.ts:50`, `cross-domain/ports.ts:52`, `program-element-read.service.ts:2290`). *Confirmed.* → fold into `DefenseRuntimeConfig`. *(Config consolidation is CleanUp4's; the guard-disabling env mismatch is owned by `SECURITY_REVIEW.md` cross-cutting theme 4.)*

**Cross-app:** most parser findings live in `runtime-source/**`, a mirror owned upstream by
`apps/api/src/defense-budget/**` (parity gate `scripts/verify-phase8-session4.mjs`; **730** mirror `.ts`
files byte-identical at re-verification, up from 378). A4 spans `packages/shared` + `packages/defense-domain`.

---

## `apps/intel-api`

**Scope:** 313 non-test TS files, ~74k LOC. Hearing stream/capture adapters, tracked-bill change
detection, alert evidence, source repositories, scheduling/runtime wiring.
**Summary:** Well-commented NestJS service, but composition and "source knowledge" are diffuse:
provider/host classification is copied across five modules, bill-entity normalization exists in five
divergent forms, and a second hand-rolled composition root duplicates the Nest DI graph.

### A. Data-driven opportunities
- **[D1] Host/provider classification hardcoded in 5 places** — `src/hearing/net-guard.ts:79` (`ALLOWED_HOST_SUFFIXES`), `stream-resolver.service.ts:176-237`, `capture/automatic-stream-resolver.ts:266-289`, `capture/stream-resolution-policy.ts:317-374`, `state-capture-policy.ts:24-41` (`isFloridaStatePublisherUrl`; the old `FLORIDA_FIRST_PARTY_HOSTS` constant was removed). C-SPAN gating already had to be re-added at the allowlist (`net-guard.ts:115`). *Confirmed.* → one provider-registry module consumed by all five. *(Registry is CleanUp4's; the host allowlist is a security control per `SECURITY_REVIEW.md` §6 — do not change its membership without a security review of the diff.)*
- **[D2] Senate ISVP per-committee table in source** — `src/hearing/stream-extractors.ts:64-98` (30 rows of transcribed upstream coordinates; file documents prior rot). *Confirmed.* → load from a data/config table with a refreshed-at revision marker.
- **[D3] Scoring weights/thresholds as frozen literals** — `src/intel-alert/alert-scorer.ts:41` (`PRIORITY_FACTOR`), `:56` (`computeScore`), `:89` (`SCORE_WEIGHTS_V2`); versioning is manual (`SCORE_MODEL_VERSION = 2`). *Confirmed.* → weights as a versioned data object selected by config.

### B. Abstraction / de-duplication opportunities
- **[A1] Five divergent bill-identifier resolvers** — `src/linking/bill-hearing-linker.service.ts:37`, `hearing/intelligence/deterministic-public-hearing-extractor.ts:81`, `sourcedata/folder-source-data.repository.ts:16`, `watchlist/watchlist-matcher.service.ts:94`, `tracker/relevance.util.ts:282`. Semantics differ per caller (state `H→HB`, congress prefixing, display formatting). *Confirmed.* → one entity-resolution module over canonical keys, shared with `@capiro/shared`.
- **[A2] Duplicated runner entrypoints for one worker** — `hearing/intelligence/run-hearing-intelligence.ts` vs `run-phase9-hearing-intelligence.ts` (same worker boot; phase9 additionally adds heartbeat/`--manual`/`--max-passes`). *Confirmed.* → single runner with mode flags.
- **[A3] No shared outbound HTTP client** — 22 direct `fetch()` sites each with hand-rolled `AbortController`/timeout/headers (`orchestrator.client.ts:55,79,148,294`, `alert-summary.client.ts:117`, `hearing-record-workflow.service.ts:363`, `report-delivery.service.ts:248,828,905,977`). *Confirmed.* → one internal-API client with policy hooks.
- **[A4] Rail-twin repositories duplicate shape; detectors branch inline** — `source-data.repository.ts` vs `state-source-data.repository.ts:6-16` ("state-rail twin"); `tracker/bill-change-detector.service.ts:177-178,425` partitions on `source !== 'state'` inside one 1,299-line service. *Confirmed.* → rail-typed repository interface + shared detection pipeline.

### C. Other architectural concerns
- **[O1] Providers registered in multiple modules → duplicate instances** — `HearingCryptoService` in `feed.module.ts:35`, `hearing.module.ts:39`, `tracker.module.ts:135`; `StreamResolverService` in `hearing.module.ts:45` and `capture.module.ts:30`; likewise `HearingSessionService`, `OrchestratorClient`, `ClientBriefContextClient`, `HearingAiCredentialResolver`, `TrackerOwnerGuard`. Stateful services exist as 2–3 singletons. *Confirmed.* → one owning module + exports.
- **[O2] Two parallel composition roots** — Nest DI vs manual `new` graph (`tasks/task-runner.ts:850,803,821`, `capture.module.ts:62`, `run-phase9-public-capture.ts:34`, `recording/run-hearing-media.ts:23-26`, `run-hearing-delivery.ts:19`). *Confirmed.* → one factory/bootstrap reused by both.
- **[O3] God modules** — `tracker-board.service.ts` 1,810 LOC; `source-data.repository.ts` 1,609 LOC / 36 public methods / 39 raw-SQL calls; `bill-change-detector.service.ts` 1,299; `task-runner.ts` 866 with a 36-verb `switch` at `:250`. *Confirmed.* → split by aggregate; verbs into per-verb modules.
- **[O4] Feature-layer inversion / cross-feature wiring** — `tracker/tracker.module.ts:29-32,45,66-73` registers 11 hearing classes; `hearing-publication.service.ts:20-35` and `hearing-record-delivery.service.ts:10-24` import tracker reports/SMS internals. Boundaries are porous; a shared "report domain" util lives under `tracker/reports`. *Confirmed.* → extract reports/SMS to a shared layer.
- **[O5] Inconsistent config access; same flag read two ways** — ~200 direct `process.env` reads vs ~20 `ConfigService.get()` calls; `net-guard.ts:119,130` re-reads `RESOLVER_ENABLE_CSPAN`/`RESOLVER_ENABLE_YOUTUBE_LIVE` from env while `stream-resolver.service.ts:128-129` reads the same flags via `ConfigService`. *Confirmed.* → single validated config accessor.

**Cross-app:** bill-key helpers already live in `packages/shared`; host-allowlist/provider policy and the
internal-API client are shared candidates; `feed/normalize-evidence.ts:1-15` is a cross-app contract
point read by `apps/web`.

---

## `apps/api-strategy`

**Scope:** `src/context/**` (templates, frontmatter, steward, import), `src/meri/**` (governed factory,
orchestrator/context-plane clients, draft-job), `src/reports/report-context.ts`,
`src/agents/{risk-router,watcher-checks,approval-binding}`, `src/strategy/**`, `eval/**`,
`packages/strategy-verifier`.
**Summary:** Disciplined about pure modules and typed tables, but the context-pack + prompt/config
surface is hardcoded twice-over (markdown templates vs TS registries, per-vertical label maps, section
routers by filename prefix); the deterministic verifier contract is stringly-typed; and the governed
compiler is wired through ambient `AsyncLocalStorage` + runtime method monkey-patching.

### A. Data-driven opportunities
- **[D1] Context-pack → narrative-section routing is a hardcoded prefix chain** — `reports/report-context.ts:394-439` (`categoryFor`/`sectionTitleForTemplate` branch on `templateKey.startsWith('01_')`…), plus `SKIPPED_TEMPLATE_KEYS` (`:36-42`), `SECTION_TITLES` (`:55-66`), second key order at `:167-178`. The 17-document registry already exists at `context/frontmatter.ts:37-77`. *Confirmed.* → put section/order/client-safe flags as fields on one registry and derive routing.
- **[D2] Seven strategy-type labels duplicated as literal maps** — `meri/meri.service.ts:112-120` (`TYPE_LABEL`), `strategy/strategy.service.ts:275-286` (`labelForType`), `reports/report-content.ts:397-406` (`strategyTypeLabel`), plus a fourth copy of the type union at `eval/goldens/golden.types.ts:16-23`. *Confirmed.* → one exported `STRATEGY_TYPE_META`.
- **[D3] Health-score cutoffs (80/60) re-hardcoded in three renderers** — `reports/pdf-report.document.ts:282`, `reports/pptx-report.renderer.ts:3571`, `reports/docx-report.renderer.ts:177-181`; authoritative score+label live in `packages/strategy-verifier/src/plan-health.ts:79,84`. A threshold change silently disagrees with output. *Confirmed.* → render from the verifier's label/tone.
- **[D4] Verifier violation vocabulary is loose string + copy-pasted title maps** — `packages/strategy-verifier/src/types.ts:21` (`code: string`), consumed by `agents/watcher-checks.ts:184-196` (`VERIFIER_TITLES` covers 11 of 16 codes) and `meri/meri.service.ts:1461`. *Confirmed.* → export a `ViolationCode` union; type both maps as `Partial<Record<…>>`.
- **[D5] Template contract is vendored markdown but runtime uses a hand-synced TS array** — `src/context/templates/*.md` (read only by specs, e.g. `frontmatter.spec.ts:29`) vs `frontmatter.ts:37-77`; `CONTEXT_GAP_LABELS` (`meri.service.ts:104`) vs `REQUIRED_TEMPLATE_KEYS` (`steward.service.ts:47`). *Confirmed.* → one registry keyed by `DocumentTypeValue`.

### B. Abstraction / de-duplication opportunities
- **[A1] Clerk-sub extraction implemented twice, logically identical** — `meri/meri.service.ts:129-141` (`clerkSubjectFromBearer`) vs `meri/governed-strategy-meri.factory.ts:157-169` (`clerkUserIdFromBearer`). *Confirmed.* → one helper.
- **[A2] Title derivation duplicated** — `strategy/strategy.service.ts:267-273` vs `meri/meri.service.ts:1518-1522` (same truncation + `TYPE_LABEL` suffix). *Confirmed.* → one helper.
- **[A3] Draft→`VerifierNode` conversion duplicated; eval re-declares the type union** — `meri.service.ts:1484-1495` vs `eval/run-l2.ts:123-137` ("mirroring production"). The verifier *shapes* are now imported by `eval/goldens/golden.types.ts:14` from `@capiro/strategy-verifier`; only the 7-member strategy-type union is re-declared locally (`:16-23`). *Confirmed.* → export the conversion; reuse package types.
- **[A4] Governed-operation vocabulary spread across two clients** — `meri/strategy-context-plane.client.ts:129-143` (`operationFor`/`surfaceFor`) vs inline `['strategies.generate']`/expected-op arrays at `meri/strategy-orchestrator.client.ts:69,104,212,243`. *Confirmed.* → one operation registry.

### C. Other architectural concerns
- **[O1] Governed context is an ambient ALS + runtime monkey-patch with no explicit seam** — `meri/governed-strategy-meri.factory.ts:44-52,75,105,133` reassigns methods on the service instance; `meri/strategy-orchestrator.client.ts:313-327` silently reads `currentStrategyGovernedContext()` and fails closed. Direct injection or a missing wrap is a runtime-only failure; unit tests must hand-build ALS contexts. *Confirmed.* → pass governed context explicitly or make it a required collaborator.
- **[O2] Module cycle avoided by double-instantiating providers (documented)** — `context/context.module.ts:20-25` states MeriModule↔ContextModule would cycle, so `StrategyOrchestratorClient`/`StrategyAiCredentialResolver` are provided locally; `meri/meri.module.ts:7` imports ContextModule. *Confirmed.* → extract a shared reasoning-client module.
- **[O3] Non-deterministic grounding with no injected clock** — `meri.service.ts:182-188` `fiscalWindow()` calls `new Date()` directly though `fiscal/fiscal.ts:17,26,35` take `now`; `meri/context-load.ts:43` uses `Math.random()` jitter. *Confirmed.* → thread an injectable clock.
- **[O4] Eval harness never executes this app's path; templates are runtime-invisible** — `eval/run-l2.ts:11-21` calls the orchestrator directly; no non-spec code reads `src/context/templates/`. A regression in this app cannot fail L2. *Confirmed.* → make the app path injectable/overridable for L2, or load templates at runtime.

**Cross-app:** `packages/strategy-verifier` should own the typed violation vocabulary; the governed-context
ALS pattern couples to `meriv2-orchestrator`'s compiler, whose response is validated by hand
(`strategy-context-plane.client.ts:110-124`) rather than a shared contract type.

---

## `apps/meriv2-orchestrator`

**Scope:** ~106 non-test sources — MeriV2/MeriV3 chat/in-editor/strategy/steward surfaces, retrieval/
coverage engine, tool registry, delegated API clients; judged against `packages/meriv2-core`.
**Summary:** Layering over `meriv2-core` is correct at the tool/LLM boundary. The orchestration itself
is not layered: no stage/recipe registry, recipe vocabulary restated in four files, retry/HTTP/config
plumbing copy-pasted per job, and the pipeline is one ~1,750-line method over a constructor-patched
inheritance chain. There is no job queue or scheduler — this app is a synchronous HTTP host.

### A. Data-driven opportunities
- **[D1] Recipe set restated across four files** — `meri/retrieval/meri-retrieval-plan.ts:11-33`, `meri/meriv3/meriv3-retrieval-recipes.ts:34,152-176`, `meri/retrieval/meri-data-catalog.ts:393`. One recipe = name tuple + schema + switch + catalog entry; the runtime recipe lives in a hand-maintained superset, `MERI_RUNTIME_RETRIEVAL_RECIPE_TOOLS` (`meri-retrieval-plan.ts:28-32`), while the typed catalog is an 11-entry `Record` (`meri-data-catalog.ts:393`). Schema, plan, catalog and switch still restate the set. *Confirmed.* → one registry entry `{name, schema, executor, domains}`.
- **[D2] Per-recipe planning ternaries shadow the catalog** — `meri-retrieval-plan.ts:322-357`: `requiredDomains`/`optionalDomains`/`recommendedTools` are 5-arm chains re-deciding what `MERI_RECIPE_CATALOG` stores. *Confirmed.* → push overrides into catalog entries.
- **[D3] Query-class set declared twice** — `meri-retrieval-plan.ts:110-115` vs `meriv3-retrieval-recipes.ts:143-147`; retrieval depth chosen in two files, divergence silent. *Confirmed.* → one exported constant.
- **[D4] Tool→domain knowledge split across literal maps** — `meri-tool-catalog.ts:8` (`TOOL_DOMAIN_OVERRIDES`) and `meriv3-retrieval-company-profile.ts:120-124` remain literal; `meriv3-turn-coverage.ts:68-76` is now an alias layer that derives from `meriToolCoverageCatalogEntry(...).domains` (`:79-93`). *Confirmed.* → one exported `toolDomains(name)`.
- **[D5] Backend URL/timeout re-parsed per repo; ad-hoc magic timeouts** — `meriv3/api-tool-executor.repo.ts:106`, `api-compliance-audit.repo.ts:32`, `meriv3/api-managed-mcp.repo.ts:27`, `meriv3/api-visual-analysis.repo.ts:16`, `meriv3/meriv3-assistant.service.ts:715`, `meri/chat/chat-assistant.service.ts:113` — 9 copies of `?? 'http://localhost:3000'` and unguarded `parseInt(... ?? '60000')` in 4 files. *Confirmed.* → one typed config accessor.

### B. Abstraction / de-duplication opportunities
- **[A1] Three copies of the tool-schema fetch** — `meri/chat/chat-assistant.service.ts:921-937`, `meri/in-editor/in-editor-assistant.service.ts:408-424`, `meri/meriv3/meriv3-assistant.service.ts:4226-4254` (same URL, headers, fail-open `[]`). *Confirmed.* → one `ClioToolSchemaClient`.
- **[A2] Three abortable-sleep/retry implementations with divergent curves** — `meri/meriv3/openai-responses.client.ts:32` (`300·2ⁿ`), `request-scoped-llm.client.ts:128` (`min(2000,250·2ⁿ)`), `meri/meriv3/api-tool-executor.repo.ts:60-77`. *Confirmed.* → shared `sleepWithSignal` + one classifier.
- **[A3] "Completeness" predicate duplicated across the two coverage engines** — `meri-retrieval-coordinator.ts:74-79` vs `meriv3-retrieval-recipe-utils.ts:261-265`. *Confirmed.* → single helper over core's coverage contract.
- **[A4] Pipeline implemented as constructor monkey-patching** — `meri.module.ts:70` → `meriv3-clean-assistant.service.ts:371-372`, `meriv3-retrieval-assistant.service.ts:180+`, `meriv3-managed-mcp-assistant.service.ts:156-161,195,206`; each layer redeclares `ToolSchema`/`InvokeArgs`. Stage order is implicit in `super()` sequencing. *Confirmed.* → explicit `protected` stage hooks.

### C. Other architectural concerns
- **[O1] `runTurn` is the entire pipeline in one ~1,751-line method** — `meri/meriv3/meriv3-assistant.service.ts:907-2657` (~20 mutable locals, 4 nested closures; gather/repair/forced-synthesis/finalize/audit exist only as comments). Grew ~3× since the original review. *Confirmed.* → named stage functions over one state object.
- **[O2] Boundary: ~5.3k lines of pure retrieval logic inside a "thin HTTP host"** — `app.module.ts:9-12` vs `meri/retrieval/meri-retrieval-coverage.ts:1-50`, which re-declares a vocabulary `packages/meriv2-core/src/context/coverage-aware-packet.ts:1-45` already defines, bridged by `meriv3-turn-coverage.ts:68-93`. `apps/api` cannot reuse it. *Confirmed.* → leaf-first extraction of the Nest-free modules.
- **[O3] Inconsistent failure policy, no shared seam** — fail-open `meri/meriv3/meriv3-assistant.service.ts:4252-4254`, fail-closed `meri/meriv3/api-visual-analysis.repo.ts:45-53`, fire-and-forget `api-compliance-audit.repo.ts:38-43` (`void this.post(...)` loses audit rows on shutdown). *Confirmed.* → state policy per boundary in one place.
- **[O4] Load-bearing turn math outside config** — `meri/meriv3/meriv3-assistant.service.ts:382-387` (`synthesisReserveMs`: 15%/90k/180k/half-budget) while sibling budgets are env-driven (`meri/meriv3/meriv3-reasoning.ts:63-104`). *Confirmed.* → fold reserves into the reasoning profile.

**Cross-app:** `meriv2-core` is consumed well at the tool/LLM boundary, poorly at the retrieval/coverage
boundary. `MERIV2_API_BASE_URL`/`MERIV2_TOOL_TIMEOUT_MS` defaults restated in 9 files here. Despite the
name, this app owns no queue/scheduler; if scheduling is expected here it is an unbuilt seam.

---

## `apps/workspace`

**Scope:** NestJS backend for `workspace-api` (182 `src/*.ts`, 24 modules, ~33.3k LOC). No UI in this app
(the workspace front end lives in `apps/web`). Tenancy = shared `tenants`/`tenant_memberships` (raw SQL
via `PrismaService.withSystem`) + `ws_*` tables owned here.
**Summary:** Newer vNext surfaces model the domain well (pure `role-policy`, pure `resolution.rules`,
exhaustive state machine). Architecturally this is **two products in one process** — the draft engine and
the Hill Day pipeline, each with its own documents, generation loop, export and authorization rule — and
cross-cutting concerns are implemented per-call-site rather than shared.

### A. Data-driven opportunities
- **[D1] Work-product metadata scattered across four string-keyed literal maps + a regex ladder** — `cascade/cascade.config.ts:148,251,337,352`, `templates/templates.data.ts:32-71`, `hillday/hillday-blueprints.catalog.ts:25`; worst is `sectionSpecFor` (`cascade.config.ts:374-431`), a 7-branch ordered regex ladder classifying sections by keyword as the drafting contract. Adding a product means editing 4+ files with no compile error. *Confirmed.* → one `PRODUCTS` registry keyed by a `Product` union; per-section format as a table lookup.
- **[D2] Two authorization models coexist for the same resource kind** — `collaborators/role-policy.ts:28-50` (predicate matrix) vs Hill Day hardcoding `doc.ownerId !== actorId` in six services / seven sites (`hillday-document.service.ts:940`, `hillday-generation.service.ts:121,203,231`, `hillday-resolution.service.ts:213`, `hillday-context.service.ts:208`, `hillday-export.service.ts:66`). *Confirmed.* → resource-parameterised policy table / one `assertOwner`; derive messages from the predicate.
- **[D3] Three independent feature-flag mechanisms, two of them copy-pasted services** — `meriv2/meriv2-flags.service.ts:55` and `quick-draft/two-step-draft-flags.service.ts:52` are the same `readClioFlag` + 60s cache + `settings_jsonb` query; `generation/generation-assurance.ts:46-82` adds `MERI_RELEASE_GATE*`; `MERIV2_ENABLED` (`meriv2-flags.service.ts:29`) a fourth. *Confirmed.* → one injected `TenantFlagService` + typed release-gate config.

### B. Abstraction / de-duplication opportunities
- **[A1] Two parallel document/generation/export verticals** — `prisma/schema.prisma:54` (`WsDraft`) and `:704` (`WsHillDayDocument`); `generation/generation.service.ts:786` vs `hillday/hillday-generation.service.ts` (own Anthropic call at `:584`); `export/export.service.ts` vs `hillday/hillday-export.service.ts`. *Confirmed.* → extract the reusable "assemble → model → persist sections → job events" seam.
- **[A2] No shared outbound HTTP client** — 12 inline `fetch` sites (`collaborators/collaborators.service.ts:94`, `workspace-reasoning/workspace-reasoning.gateway.ts:202`, `generation/context-compiler.service.ts:125`, `generation/generation.service.ts:1773`, `drafts/{research,editorial,preparation}-source.controller.ts`, `hillday/directory-bridge.client.ts:245`, `meriv2/meriv2-orchestrator.client.ts:36`, `generation/memory-promotion.client.ts:40`, `hillday/hillday-export.service.ts:173`, `hillday/hillday-generation.service.ts:584`). Four incompatible timeout idioms, 10s–60s; three intel controllers bypass the existing client classes. *Confirmed.* → one `InternalHttpClient`. *(Transport is CleanUp4's; the shared `INTERNAL_SERVICE_SECRET` is owned by `SECURITY_REVIEW.md` top-5 #1, and the two deadline-less calls by §8.)*

### C. Other architectural concerns
- **[O1] Ambient request context that enforcement depends on but no type enforces** — `generation/context-persistence-hold.ts:15,24`, `generation/generation-assurance.ts:32,67-82`, `prisma/prisma.service.ts:16-20`. Two ALS stores + a Prisma middleware are only populated when a caller wraps deliberately; `document-agent.service.ts:992` calls `generateAllSections` **without** either wrapper, silently skipping the persistence hold and falling back to the synthetic tenant. *Confirmed (grep: only `generation.controller.ts` and `quick-draft/generation-run-worker.service.ts` wrap).* → make the boundary a required parameter / request-scoped provider.
- **[O2] Tenancy enforced purely by convention; `ws_*` has no RLS** — `prisma/prisma.service.ts:31-35` states `ws_*` tables are unprotected; background paths drop the filter (`hillday/hillday-generation.service.ts:272,275` `findUnique({where:{id}})`, `:439` nested unscoped lookup). A single omitted filter is a cross-tenant read/write with no DB backstop. *Confirmed.* → tenant-scoped data-access layer (client extension injecting `tenantId`, or RLS). *(**Covered by `SECURITY_REVIEW.md`** — its tenancy “good shape” claim conflicts with this finding; escalate for security adjudication before building.)*
- **[O3] God services mixing transport, prompt, persistence and policy** — `generation/generation.service.ts` (1,813 lines), `document-agent/document-agent.service.ts` (1,270), `hillday/hillday-document.service.ts` (1,076). Tests reach for `as never`/`as` casts. *Confirmed.* → split by responsibility; inject model client, clock, persistence adapter.

**Cross-app:** `tenants`/`tenant_memberships` are owned by `apps/api` and read here via raw SQL with a 30s
membership cache (deliberate 30s revocation window); `INTERNAL_SERVICE_SECRET` is the shared credential
for intel-api, memory-promotion, context-compiler and the Hill Day export-signing fallback
(`hillday-export.service.ts:51`) — see `docs/security/SECURITY_REVIEW.md:27-43`.

---

## `apps/onboard-api`

**Scope:** 51 TS files under `src/` (`funnel/`, `setup/`, `it-admin/`, `legal/`, `lifecycle/`, `billing/`, `email/`,
`auth/`, `public/`), `prisma/schema.prisma`, plus cross-tier consumers in `apps/onboard-web/src`.
**Summary:** Security-critical seams (CAS task transitions, idempotent webhooks, RLS script) are sound,
but the two "machines" that define the product — the funnel/setup step ladder and the trial/lifecycle
cadence — exist mostly as literals spread across modules, and the IT-admin surface mutates the setup-task
machine without going through its owner.

### A. Data-driven opportunities
- **[D1] Setup task machine defined ad hoc in six places** — `src/setup/setup.controller.ts:14-15`, `src/setup/setup.service.ts:21-26,144-150,315-323`, `src/funnel/provisioning.service.ts:282-290`, `prisma/schema.prisma:72-92`; the client re-declares keys and its own gate (`apps/onboard-web/src/lib/setup.ts:12`, `SetupDashboardPage.tsx:225-227`). *Confirmed.* → one `TASK_DEFINITIONS` table (key, seedStatus, gatesInvites, skippable). *(Cross-referenced by `SECURITY_REVIEW.md` #26 — the legal transition graph is owned there; the table is CleanUp4's and should carry both.)*
- **[D2] Lifecycle cadence and windows are inline literals** — `src/lifecycle/lifecycle.service.ts:170-182` (29/25/15/1 buckets over a hardcoded 30), `:242,:265` (60/30-day backstop), `:383,:391` (90/83 retention), `:56-59` (lockout); trial length restated at `src/setup/setup.service.ts:339`. `elapsed = 30 - daysLeft` assumes the stamp length. *Confirmed.* → pure `cadence.ts` with data-driven buckets/windows.
- **[D3] Email-validity rule duplicated and inconsistent** — `src/funnel/funnel.service.ts:32` (`EMAIL_RE`, mirrored in four onboard-web files, e.g. `OrgPage.tsx:26-27`, `AdminsPage.tsx:30-32`) vs the weaker `includes('@')` gate applied to the same IT-invite concept at `src/setup/setup.service.ts:214` and `lifecycle.service.ts:216`. *Confirmed.* → one normalizer/validator in `@capiro/shared` (still absent there at re-verification).

### B. Abstraction / de-duplication opportunities
- **[A1] IT-invite issuance written three times** — `setup.service.ts:231-256` and `:273-293`, `funnel/provisioning.service.ts:251-275`: token mint, invite row, `renderItAdminInviteEmail`, dedupe-key format; `IT_INVITE_TTL_MS` declared twice (`setup.service.ts:19`, `provisioning.service.ts:19`). *Confirmed.* → one `ItInviteIssuer`.
- **[A2] Both OAuth callbacks repeat the same prelude** — `it-admin.service.ts:263-285` vs `:328-349` (verifyState → invite lookup → `doneIfAlreadyGranted` → `staleInviteRedirect`), plus the grant→`it_email` write at `:310-313` vs `:420-423`. *Confirmed.* → one `loadInviteForCallback(state)` + one task-resolution helper.

### C. Other architectural concerns
- **[O1] IT-admin bypasses the setup-task machine's owner** — `it-admin.service.ts:227-230,310-313,420-423` writes `onboard_setup_task` directly, skipping `SetupService`'s `requireV1Tenant`/CAS semantics (`setup.service.ts:181-206`); `ItAdminModule` never imports `SetupModule` while `SetupModule` exports `SetupService` that no one imports (`setup.module.ts:16`). *Confirmed.* → route all transitions through one CAS service; delete the dead export. *(**Covered by `SECURITY_REVIEW.md`** #26 — land the transition-graph enforcement there first; the ownership refactor is CleanUp4's.)*
- **[O2] `FunnelService` is a God service with a leaking seam** — `src/funnel/funnel.service.ts` (885 lines, ~30 methods) spans session machine, e-signature/PDF, Stripe payment and roles/org; internals are public solely for `ProvisioningService` (`:687-711`), which imports `RoleDesignation` from it (`provisioning.service.ts:17`); `FunnelController` also injects `ProvisioningService` (`funnel.controller.ts:238`). *Confirmed.* → split along the existing banners.
- **[O3] No test seam under the highest-risk logic** — six specs only; none for `funnel.service`, `provisioning.service`, `lifecycle.service`, `setup.service`, `billing.service`. Cadence/lockout decisions sit inline in private methods with hard-wired Prisma/ConfigService (`lifecycle.service.ts:158-201,287-365`), unlike the pure, unit-tested `src/funnel/funnel-state.ts`. *Confirmed.* → extract pure decision functions.

**Cross-app:** the "which tasks unlock invites" rule and the email regex are each encoded in both tiers.

---

## `apps/defense-budget-parser`

**Scope:** all of `src/capiro_defense_budget_parser` (50 files, ~8.3k lines): CLI/contracts layer, 4
engines + profiler, and `extractors/stages/**`.
**Summary:** The runtime boundary (one JSON job in, strict Pydantic result out) is sound and enforced by
an external gate (`apps/api/scripts/verify-defense-budget-parser-architecture.ts`). Weaknesses are in the
semantic layer: domain rules are code, the shared `common/` module holds only models, and a large semantic
subsystem has no production entry point while TS re-implements the same semantics.

### A. Data-driven opportunities
- **[D1] Component/agency vocabulary is a hardcoded regex bank copied 6×** — `extractors/stages/hasc/semantics.py:36`, `hacd/semantics.py:41`, `sasc/semantics.py:41`, `sacd/semantics.py:51`, `ndaa_conference/semantics.py:41`, `provisions/semantics.py:61`. Membership diverges (HASC/SASC lack DARPA/MDA/SOCOM that HAC-D/SAC-D have), so agency recognition silently differs by chamber. *Confirmed.* → one data table keyed by component.
- **[D2] Chamber money-semantics is an if/elif keyword ladder** — `_header_semantic` at `hasc:61`, `hacd:58`, `sasc:55`, `sacd:68`; `_row_semantic` at `hasc:87`, `hacd:152`, `sasc:152`, `sacd:165` (~20–25 ordered phrase tests per stage). *Confirmed.* → per-stage phrase→`MoneySemanticV1`/`RowSemanticKindV1` tables loaded as data.
- **[D3] Provision action/scope/caveat/recipient taxonomy is embedded** — `provisions/semantics.py:55` (`_RECIPIENT_PATTERNS`), `:151` (`_scope` phrases), `:186` (`_caveat` copy), `:204-217` (`_classify_action`). Reviewer-facing caveat text requires code edits + redeploy. *Confirmed.* → externalize as a rulepack; keep only the matcher generic.

### B. Abstraction / de-duplication opportunities
- **[A1] The designated shared module contains zero behavior** — `extractors/stages/common/congressional_table.py:1-197` is models-only; every stage re-implements `_table_matrix` (`hasc/extractor.py:196`, `sacd/extractor.py:317`, `ndaa_conference/extractor.py:209`) and the gap/omitted-page prologue. *Confirmed.* → move shared mechanics into `common/`.
- **[A2] Two copies of the draft→finalize evidence pipeline** — `provisions/extractor.py:37-52,170-218,228-229` vs `ndaa_conference/language.py:28-40,129-171,180-181` (near-identical `_Draft`, `_finalize` hashing, evidence-id construction). *Confirmed.* → one shared block-draft→provision helper.
- **[A3] Budget-line identity and component vocabularies diverge** — `common/congressional_table.py:151-158` vs `provisions/contracts.py:183-191`; `BudgetComponentV1` (`provisions/contracts.py:36-49`) is never used by the money stages, whose `_component()` returns bare `str` (`hasc/semantics.py:247`). *Confirmed.* → one reference union.

### C. Other architectural concerns
- **[O1] The semantic layer has no production entry point** — `extractors/` (~2.9k lines, 6 stages) is reachable only from tests; `cli.py:101-117` exposes validate/profile/run/version and a repo-wide grep for `extract_*_tables`/`extract_authorization_provisions` finds only tests. *Confirmed.* → add the dispatch command or relocate.
- **[O2] Semantic authority is duplicated Python↔TS** — `pdfplumber_engine.py:122-128` states PE/appropriation interpretation is "the downstream TS segmenter/extractors' job", yet `extractors/stages/**` does exactly that while TS carries its own extractors/composers (`apps/api/src/defense-budget/non-rdte/**`). Two unsynchronized owners in two languages, no parity test. *Confirmed.* → declare one owner and add a contract parity gate.
- **[O3] Unparseable money is silently dropped** — `hasc/semantics.py:206-228` (`_canonical_decimal`) returns `None` for both blank/em-dash and `Decimal` failure; consumers only flag missing *unit* (`hasc/extractor.py:159-163`). *Confirmed.* → distinguish "absent" from "unparseable"; emit a finding.
- **[O4] Source-integrity IO lives in the profiler** — `pdf_profile.py:41-57` is imported by all four engines (`pdfplumber_engine.py:38`, `camelot_engine.py:42`, `docling_engine.py:47`, `paddleocr_engine.py:60`) just to hash a file; `verify_source_sha256`'s `ValueError` is classified by substring in the CLI (`cli.py:176-181`). *Confirmed.* → extract a small `source_integrity` module with a dedicated exception type.

**Cross-app:** `apps/api/src/defense-budget/` is tree-SHA-mirrored into `apps/defense-api/runtime-source/`;
TS-side extractor edits are not part of that mirror pair, so the O2 drift is invisible to existing gates.

---

## `apps/onboard-web`

**Scope:** `apps/onboard-web/src` — 23 `.tsx` + 8 `.ts` (~7.8k LOC).
**Summary:** Structure is clean and comments strong; the debt is architectural. Every funnel screen
re-implements the same page/session/submit scaffolding, option and milestone catalogs live as JSX
literals, and server-owned rules (task gates, pricing) are mirrored into components with no seam to test.

### A. Data-driven opportunities
- **[D1] Select catalogs and label↔code maps are inline JSX literals** — `pages/funnel/OrgPage.tsx:119-161`, `pages/funnel/AdminsPage.tsx:24-32,220-224`, `pages/setup/InvitesOverlay.tsx:10-17,112-115`, `pages/setup/AiSettingsOverlay.tsx:17-21`. Industry/timezone/locale/team-size options, role lists, and `'Super Admin'→'super'` mappings are typed into components (three role vocabularies across two files). *Confirmed.* → one declarative option/catalog module.
- **[D2] Milestone/task catalogs duplicated from the server contract** — `pages/setup/SetupDashboardPage.tsx:213-227,344,359,372-617`; `pages/funnel/ConfirmPage.tsx:113-117`. Four `TaskCard`s, a literal `/4` denominator, the gate, and the Confirm provisioning lines are hand-written while `TASK_KEYS`/`TASK_STATUSES` live server-side (`setup.controller.ts:15-16`) and are re-declared at `lib/setup.ts:12-14`. *Confirmed.* → drive counts/labels from a shared task descriptor.

### B. Abstraction / de-duplication opportunities
- **[A1] Funnel page session-loader boilerplate repeated 6×** — `AdminsPage.tsx:34-38`, `OrgPage.tsx:29-33`, `PlanPage.tsx:17-21`, `ClientsPage.tsx:15-19`, `BillingPage.tsx:161-169`, `ConfirmPage.tsx:16-20` (same `useFunnelSession() → if (!data) return null → <Inner/>`). *Confirmed.* → a `withFunnelSession` wrapper.
- **[A2] Submit/`busy`/`error`/`advanceSession` try-catch repeated ~6×** — `PlanPage.tsx:40-58`, `ClientsPage.tsx:29-41`, `AdminsPage.tsx:74-95`, `OrgPage.tsx:69-104`, `LegalPage.tsx:161-180`; loading/error behaviour drifts per page. *Confirmed.* → one `useFunnelStep` hook.
- **[A3] Modal footers and invite-row editors hand-rolled** — `ui/primitives.tsx:731-801` (no footer slot); `AiSettingsOverlay.tsx:196-215`, `InvitesOverlay.tsx:162-179`, `ImportOverlay.tsx:237-267,611-643`; editor duplicated at `AdminsPage.tsx:210-242` vs `InvitesOverlay.tsx:105-129`. *Confirmed.* → `Modal` footer/action slot + one `InviteRowsEditor`.

### C. Other architectural concerns
- **[O1] Server business rules mirrored inside components** — `SetupDashboardPage.tsx:213-227` (comment admits mirroring `setup.service.completeSetup`), `BillingPage.tsx:435-436`, `ConfirmPage.tsx:126-148`; gating and money math live in render code and will drift silently. *Confirmed.* → derive from server state; keep only presentation.
- **[O2] No test seams for the logic above** — only `lib/funnel.draft.test.ts` exists; task gates, price math, provisioning machine and the three API clients are untested and entangled with JSX. *Confirmed.* → extract rules into pure functions/hooks.
- **[O3] Client modules mix concerns; state sprawl in one component** — `lib/funnel.ts:12-421` holds contract types, fetch wrapper, hooks, localStorage draft store and formatting; `lib/capiro-api.ts:11` imports `ApiError` from `setup.ts`; `SetupDashboardPage.tsx:59-64` keeps five unrelated IT-invite state atoms. *Confirmed.* → split by concern; reducer or `useItInvite` hook.

**Cross-app:** `TeamInviteRole` re-declared at `lib/capiro-api.ts:92` though `@capiro/shared/src/index.ts:17-18`
owns the values; funnel `'super'|'admin'` (`lib/funnel.ts:30-33`) is a third vocabulary. Form primitives are
app-local with inline styles — decide whether to consume a shared form kit. `apps/onboard-web/prototype/*.jsx`
is unimported scaffolding kept as a port reference.

---

## `apps/defense-parser-orchestrator`

**Scope:** 14 `.mjs`, ~6.1k LOC, plus `test/`, `Dockerfile`.
**Summary:** A deliberately isolated, CI-gated operator CLI, structurally walled off from the monorepo.
Main debt: its governance surface (status vocabularies, config knobs, retry budgets) is hand-mirrored in
several files and in a shared contract package it cannot import — so two parallel coordinator
implementations drift, and the live path is less configurable than the dead one.

### A. Data-driven opportunities
- **[D1] Live async path's governance knobs are literals, not config** — `src/real-async.mjs:26` (`MAX_COMPLETION_PUBLISH_ATTEMPTS = 3`), `:752` (`pages.length !== 10`); `loadRealAsyncConfig` (`:106-190`) exposes no `maxPaidAttempts`/`maxJobSeconds`/`maxPagesPerJob`/`completionPublishMaxAttempts` — those are configurable only in `src/real-batch-config.mjs:99-118`, which feeds the disabled Batch path. *Confirmed.* → one env schema; both loaders derived from it.
- **[D2] Status lattice duplicated three times and diverged from the shared contract** — `src/real-async.mjs:703-731`, `src/real-batch-coordinator.mjs:36-64`, `src/session5.mjs:446-456` vs `packages/defense-contracts/src/parser/nvidia-async.ts:44-57` and `nvidia-real-batch.ts:68-80`; none is derived from the contract. *Confirmed.* → one transition table owned by the contract package.
- **[D3] Operator-facing CLI facts hardcoded; dispatch is a duplicated switch** — `src/cli.mjs:101-102` (`endpointScaleToZeroConfigured: true`, `endpointLifecycle: 'orchestrator_owned_create_and_delete'`) always reported regardless of state; command names appear in `usage()` (`:15-31`), the dispatch chain (`:63-150`) and the disabled-command string (`:80`). *Confirmed.* → derive the report from live state; a command registry.

### B. Abstraction / de-duplication opportunities
- **[A1] App is outside the workspace, so shared contracts are unreachable** — `pnpm-workspace.yaml:2` claims `apps/*` but no `apps/defense-parser-orchestrator/package.json` exists; `NvidiaAsyncJobStatusV1`/`NvidiaRealBatchJobStatusV2` are referenced nowhere outside the contract package. CI works around membership with a hardcoded `node --check` file list (`…nvidia-benchmark.yml:73-83`). *Confirmed.* → add a package manifest with `@capiro/defense-contracts`; glob the CI check.
- **[A2] Two full coordinator implementations, one dead, sharing no core** — `src/real-async.mjs` vs `src/real-batch-coordinator.mjs` (barrel `real-batch.mjs:1-4`; disabled at `aws-real-runtime.mjs:13-18`), including duplicated rate math (`real-batch-cost.mjs:11-26,34-59` vs `real-async.mjs:243,388,1309-1311`). *Confirmed.* → one lifecycle core + per-execution-model adapter.

### C. Other architectural concerns
- **[O1] Layering violation via a god module** — `src/session5.mjs` holds error type, hashing, config, page routing, benchmark scoring *and* AWS-CLI adapters (`:805-1010`); every module imports it, including pure ones (`real-batch-config.mjs:1-5`, `real-batch-cost.mjs:1-5`, `provider-decision.mjs:15`). *Confirmed.* → extract primitives; move adapters to `aws-*`.
- **[O2] Inconsistent error contract at the CLI boundary** — `src/cli.mjs:81,122,130-131,142,150` throw bare `Error` while internals use coded `Session5RefusalError`; the catch (`:153-160`) collapses everything to `SESSION5_CLI_FAILURE`. *Confirmed.* → one coded error type at the boundary.
- **[O3] No in-repo consumer; lifecycle coupling** — nothing under `apps/`/`packages/` imports it (only `scripts/verify-phase8-session5.mjs` text greps and the Docker build); `aws-real-runtime.mjs:23-26` binds the same object as `artifactStore` and `jobStore`. *Confirmed.* → declare an explicit integration contract; split store interfaces.

**Cross-app:** shared NVIDIA parser contracts are defined but consumed by nobody; `apps/defense-api` and
`apps/meriv2-orchestrator` have no code path into this app; `apps/api` scripts invoke the deterministic
parser directly — this orchestrator is currently an offline evidence tool, not a runtime stage.

---

## `apps/clio-sandbox`

**Scope:** 5 source files (`src/server.ts`, `src/run.ts`, `src/harness.py`, `scripts/pentest.ts`,
`scripts/visual-smoke.ts`) + Dockerfile/package.json.
**Summary:** Not dead. It is the F4 `run_analysis` executor — a real, live feature wired end-to-end: API
`run_analysis` tool → `CLIO_SANDBOX_URL` (`apps/api/src/meri/meri-tools.service.ts:2279`,
`apps/api/src/config/config.schema.ts:676`), MeriV3 bridge, CI (`meriv3-visual-analysis-ci.yml`,
`clio-evals.yml`), ECR push (`sandbox-image.yml:55`). It does not duplicate `apps/api` Clio logic; it is the
isolation boundary (ADR 0001). Main concern: deployment is unmanaged.

### A. Data-driven opportunities
- **[D1] Limits triplicated as literals** — `src/run.ts:175-176` (env-injected `'30'` / `1024*1024*1024`) vs `src/harness.py:48-49,53-54` (defaults + FSIZE/NOFILE literals): 30s CPU, 1 GB, 20 MB, 256 fds declared across TS and Python; drift is silent. *Confirmed.* → single `limits.json`/generated constants.
- **[D2] Hard-coded brand theme in harness** — `src/harness.py:205-240`: Capiro hex palette + rcParams baked into Python, likely duplicating chart tokens used by API/MeriV3 renderers. *Confirmed.* → emit theme from one shared token source.

### B. Abstraction / de-duplication opportunities
- **[A1] Sandbox wire contract is hand-mirrored** — `src/run.ts:24-44` vs `apps/api/src/meri/meri-tools.service.ts:1034` (tool schema) and `:2321-2329` (`SandboxOutcome`); API re-declares the JSON schema/response shape, so interface changes are not compiler-checked across the boundary — the API interface already omits the `warnings: string[]` that `run.ts` declares. *Confirmed.* → a shared sandbox contract.

### C. Other architectural concerns
- **[O1] No CDK service definition** — `infra/cdk/lib/compute-stack.ts:2006` mentions `clio-sandbox` only in a comment; `:701` notes `CLIO_SANDBOX_URL` is applied out-of-band. Image pushes to ECR but the Fargate service/SG (ADR §Decision items 1–4) is unmanaged IaC; a redeploy can drop the wiring. *Confirmed.* → codify service + no-egress SG in compute-stack. *(**Covered by `SECURITY_REVIEW.md`** §8 — the ADR's Fargate/SG claims are unverifiable because no CDK exists. Do not re-plan IaC here.)*
- **[O2] In-memory admission only** — `src/server.ts:20-47`: process-local queue/concurrency, no per-tenant fairness or rate limit — noisy-neighbour risk on a shared task. *Confirmed.* → per-tenant quota at the API gateway. *(**Covered by `SECURITY_REVIEW.md`** §3 — the per-process control gap is owned there; only gateway-level fairness is CleanUp4's.)*

**Cross-app:** CDK drift matches `infra/cdk/DRIFT-FINDINGS.md`; sandbox lifecycle depends on manual env edits.

---

## `apps/engagement-api`

**Scope:** 4 files only — `Dockerfile`, `README.md`, `scripts/entrypoint.sh`, `scripts/entrypoint.spec.ts`.
**Summary:** Confirmed **packaging-only app folder**, not a stub and not a service source tree. The real
service code lives in `apps/api/src/engagement-main.ts`, `engagement-api.app.module.ts` and
`apps/api/src/engagement/**`; the image runs `dist/engagement-main.js` from the shared `apps/api` build
(shadow mode, port 4500, serve-only).

### A. Data-driven opportunities
- **[D1] Orphaned + path-broken entrypoint spec** — `apps/engagement-api/scripts/entrypoint.spec.ts:20`: Jest `rootDir: '.'` with `testMatch` covering only `src/**` and `scripts/**` (`apps/api/jest.config.cjs:67-72`) means the spec is never collected; its fixture path uses five `..` segments where three reach repo root, resolving to `E:/apps/...`. *Confirmed via grep.* → relocate under `apps/api` test roots; fix the join depth.

### B. Abstraction / de-duplication opportunities
- **[A1] Near-duplicate Dockerfile with proven drift** — `apps/engagement-api/Dockerfile:1-126` vs `apps/api/Dockerfile`: both build the same `@capiro/api` image with the same 5 workspace deps; fixes must be mirrored (see commit `f96c214d5` "give nest build the same heap ceiling as apps/api"). *Confirmed.* → parameterize a shared build stage / common `Dockerfile.api` base.
- **[A2] Image contract asserted in three places** — `scripts/engagement-api-image.sh:110`, `scripts/run-engagement-phase1-local.mjs:588`, `scripts/engagement-api-image.spec.mjs:33` duplicate ARM64/nonroot/entrypoint/EXPOSE assertions and hardcode the Dockerfile path. *Confirmed.* → single manifest consumed by all three.

### C. Other architectural concerns
- **[O1] Ownership transfer is explicitly unresolved** — `docs/plans/engagement-program/source/phase-4-engagement-api-decouple-ownership-executable-plan-gpt-5.6.md:1-8`: the folder name implies a standalone service while workers/callbacks/Recall remain in `apps/api`; the doc warns "do not infer ownership moved." *Confirmed.* → state shadow-only status in the folder README/ownership registry.

**Cross-app:** engagement logic is centralized in `apps/api`, so there is no cross-app duplication of domain
logic — the risk is duplicated *build/packaging* config.

---

# Recommended sequencing

This is an orchestration-level roll-up (my synthesis, not a per-app finding). It orders the work by
leverage — how many findings one decision retires — and by risk. Nothing here is a commitment; it is a
proposed reading order for the findings above.

## Wave 0 — Decide postures for ungated seams (T8)

Cheapest high-value work, and it must come first because these seams read as "covered" today:

1. `apps/defense-api/runtime-source/` — compile the mirror or move it out; make the manifest provenance derived.
2. `apps/defense-budget-parser/extractors/` — add the dispatch command or relocate to tests.
3. `apps/defense-parser-orchestrator` — add a `package.json` and depend on `@capiro/defense-contracts`; glob the CI check.
4. `apps/api-strategy` eval — make the app path injectable so L2 grades the app.
5. `apps/engagement-api` — record shadow-only ownership so the folder name stops implying a service.

## Wave 1 — Shared seams that retire findings across many apps

Each of these is a single artifact that removes a whole class of finding:

| decision | retires |
|---|---|
| One **internal HTTP client** in a shared package (base URL, secret, timeout, JSON/error mapping) | T6 findings in intel-api (A3), workspace (A2), meriv2 (A1/A2/D5), api (A2) |
| One **typed feature-flag registry** + a generic `FeatureFlagGuard` base | api (A1/D5), web (D4), workspace (D3), intel-api (O5), defense-api (O4) |
| One **typed violation/contract vocabulary** in `packages/strategy-verifier` (+ shared DTOs) | api-strategy (D4/A3), web (A1), clio-sandbox (A1) |
| One **tenant-scoped data-access layer** (client extension or RLS on `ws_*`) | workspace (O2), and hardens api's controller-Prusma access (O3) |
| One **entity-resolution / bill-key module** in `packages/shared` | intel-api (A1), api (D4) |
| One **repository/port convention** for reads | api (A4/O3), defense-api (O3), intel-api (O3) |

## Wave 2 — Data-driven registries per domain

Convert the branch chains in T1 into tables/registries, domain by domain, starting where correctness is
most at stake (money and legal semantics):

1. **Defense budget semantics** — the exhibit/agency/committee/jurisdiction tables (api D1/D2, defense-api
   D1/A1/A2/A3, defense-budget-parser D1/D2/D3/A1/A2/A3). Note the tree-SHA mirror obligation: `apps/api`
   and `apps/defense-api/runtime-source/` must change in one commit.
2. **Intel/hearing provider registry** (intel-api D1/D2).
3. **Onboarding task + cadence tables** (onboard-api D1/D2, onboard-web D2).
4. **Workspace product registry** (workspace D1/D2).
5. **Web nav/route + explorer source definitions** (web D1/D2/D3).
6. **Strategy context-template registry** (api-strategy D1/D5).

## Wave 3 — Break the twins and the Gods

Highest effort, largest payoff, and the point at which test seams appear:

- Parameterise the twin verticals (T2) — appropriations committee stages, workspace draft vs Hill Day,
  web legacy vs vNext, intel rail-twin repos, the dead batch coordinator.
- Split the God modules (T3) behind their existing facades, injecting model clients/clocks/persistence —
  this is also how T9 (ambient state, non-determinism) gets fixed, because injection is the replacement
  for ALS and monkey-patching.
- Replace `process.env` sprawl with the validated config surfaces (T5).

## Guardrails for whoever executes this

- **Do not delete tests.** CleanUp1–3 already govern test-duplication removal and pixel baselines; this
  review's refactors must keep the CleanUp1 gate semantics (behaviour provably unchanged, no silent test
  disappearance).
- **The mirror pairs are load-bearing.** `apps/api/src/defense-budget/**` ↔
  `apps/defense-api/runtime-source/**` is gate-checked; land both sides in one commit.
- **Line numbers drift.** Re-grep by symbol before editing; every citation here is a locating hint.
- **Confirmed vs suspected.** Findings marked *suspected* (defense-api D3, web O3) need a first-hand
  check before being scheduled.
- **Some "problems" are deliberate.** The clio-sandbox Windows passthrough, the workspace 30s membership
  cache, and `defense-parser-orchestrator`'s isolation are documented decisions, not defects. Change them
  only with the owning ADR in hand.

# Method notes / limitations

- Each app was reviewed by **one** read-only pass. Cross-app findings (T1–T9) were assembled by the
  orchestrator from those passes and are as reliable as the underlying evidence, which is `file:line`
  citations rather than exhaustive tracing.
- Security defects are intentionally out of scope; `docs/security/SECURITY_REVIEW.md` remains
  authoritative for those.
- Duplicated-code *inventory* is intentionally out of scope; `docs/plans/cleanup2-dup-inventory.generated.md`
  and CleanUp1–3 remain authoritative.
- No app's runtime behaviour was executed, so findings about unreachable code (T8) rest on static
  reachability (imports/entry points), not on observed runtime.

# Appendix A — Why the raw SQL is safe (and where it is only convention)

This appendix exists because `SECURITY_REVIEW.md` §2 makes a strong claim — *"every one that interpolates
a JS value into SQL text is safe"* — and this review's finding **T4 / `api A4` / `intel-api O3`** is about
the same SQL. The two are not in conflict, but they are about different things, and the difference is
easy to misread. This appendix records the verification behind that reconciliation.

**Method:** every `$queryRawUnsafe`/`$executeRawUnsafe` call in `apps/api/src`, `apps/api/scripts` and
`apps/defense-api/src` was parsed, its argument list split, and every `${…}` in the **first (SQL) argument**
extracted and read. Interpolations in later (parameter) arguments are not SQL text and were excluded.
Counts below were first taken at `67bab09` and **re-measured at `c816b240c`** (see the delta in the table).

## A.1 The API distinction is the whole story

| API | calls (measured) | injection surface |
|---|---:|---|
| `$queryRaw` / `$executeRaw` — **tagged template** | ~2,108 (was ~1,863 at `67bab09`) | none: Prisma rewrites `${x}` to `$n` and binds the value |
| `$queryRawUnsafe` / `$executeRawUnsafe` — **plain string** | ~2,004 (was ~1,715); 490 in `apps/api/src` (was 403) | the string *is* SQL; this is the only API where injection is possible |

The alarming-looking `${tenantId}`, `${ctx.userId}`, `${clientId}` interpolations are overwhelmingly in
the **tagged** templates, where they are inert. The security finding concerns the Unsafe API, where only
**61 interpolations exist in production code, across 22 files** (99 including test/seed files, across 34
files) at re-verification — and each was read.

## A.2 The mechanisms that make the 61 production interpolations safe

1. **The `bind()` indirection — values never enter the string.** Even inside `$queryRawUnsafe`, values go
   into a params array and only the *placeholder* is interpolated:
   ```ts
   // apps/api/src/live-hearings/legiwatch-wave1.service.ts:738
   const bind = (value: unknown): string => { params.push(value); return `$${params.length}`; };
   if (input.chamber)   filters.push(`AND lower(h.chamber) = lower(${bind(input.chamber)})`);
   ```
   Same shape via `placeholders = arr.map((_, i) => \`$${i + 2}\`)`. This is the single most important
   reason the claim holds.
2. **Escaped identifiers.** `const quote = (id) => \`"${id.replace(/"/g, '""')}"\``
   (`hearing-discovery/hearing-alias-reconciliation.ts:8`, duplicated in the two Florida siblings) —
   correct quote-doubling, used for table/column names.
3. **Module constants.** `SELECT_COLUMNS`, `EXPECTED_SOURCE_COLUMNS`, `OBSERVATION_SELECT`,
   `ACTIVE_FENCE`, `AUTOMATIC_DEMAND_SQL`, `synced`, the literal `guarded`/`readinessGuarded` `WHERE`
   strings, `from`/`baseWhere`, and `KB_SOURCE_TYPES` (an exported `as const` tuple).
4. **Closed enumerations.** `matterColumn = isPe ? 'primary_pe_code' : 'primary_bill_id'`;
   `clientPredicate` is one of two literal strings; `flag`/`committeeFlag` come from a closed
   `HEARING_FOLLOW_FLAG` map.
5. **Clamped numbers.** `limit = Math.min(Math.max(input.limit ?? 8, 1), 20)` (client-kb);
   `safe = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 10_000` (meri-hermes-db-governor) — the
   `SET LOCAL statement_timeout` case, where Postgres cannot accept a bind parameter, so inlining is
   unavoidable and the `Number.isFinite` guard is what makes it safe.
6. **Validated self-produced data.** `toUuidArrayLiteral` **throws unless every id matches a UUID regex**
   before inlining (`memory/memory-wall.helpers.ts:34`); the composed fragments `wallExclusionSql` /
   `governedClioSuppressionSql` only inline that validated array.
7. **Defence in depth.** The Prisma tenant-scope extension forces `where.tenantId`, RLS runs via
   `set_config`, and these queries run under `withTenant(...)` — so even a *missing* predicate has a
   database backstop.

## A.3 Where the claim is generous — the two caveats

1. **Value-bearing interpolation does exist outside the request path.** Operator scripts and dev seeds
   interpolate raw values: `apps/api/scripts/diag-memory-governance-v2.ts` (6×
   ``AND tenant_id = '${args.tenantId}'::uuid``) and
   `apps/api/scripts/seed-engagement-phase0-browser-fixtures.ts:95`
   (``VALUES ('${USER_ID}'::uuid, '${userEmail}', '${clerkUserId}', …)``). Not attacker-reachable, so the
   security verdict stands — but there the safety is *"the operator is trusted"*, leaning on the `::uuid`
   cast to fail loudly, not on escaping.
2. **`vectorLiteral` is safe by provenance, not by guard.** `return \`[${v.join(',')}]\`` asserts nothing at
   runtime; it is safe only because the vector comes from our own embedder. Contrast `toUuidArrayLiteral`,
   which actively validates. This is the one place matching the security review's own theme — *"the
   strongest controls are the ones with a guard behind them"*.

## A.4 Why this matters for CleanUp4

The two reviews do not disagree; they describe **different properties**:

* **Security (`SECURITY_REVIEW.md` §2):** the existing raw SQL has no injection defect today. Verified,
  and this appendix corroborates it.
* **Architecture (T4, `api A4`, `intel-api O3`):** that correctness is governed by **convention** — the
  `bind()`/`quote()`/registry-constant pattern must be remembered afresh at every one of 403 Unsafe call
  sites spread across 179 files, with no structural guarantee. This is the same failure mode the security
  review names for the marker neutraliser and the bounded inflate reader: safe until the next query.

So the repository/data-access refactor in **CleanUp4 Wave 1** (and the `check-tenant-scope-bypasses.mjs`
ratchet in CleanUp4 §8) is not a security fix — it is the mechanism that stops the safe-by-convention
pattern from being broken by a future author. Do not schedule it as remediation of `SECURITY_REVIEW.md`
§2; schedule it as structural hardening.

> **One-line summary:** the raw SQL is safe because, in production, values are bound (`bind()` → `$n`) and
> only *shape* is interpolated (escaped identifiers, module constants, closed enums, clamped numbers,
> regex-validated UUID arrays). It is a *robust convention*, not an *enforced invariant* — which is exactly
> the gap CleanUp4 Wave 1 closes.

# Re-validation (against `c816b240c`)

The findings above were captured at `67bab09`. After 984 commits landed (`67bab09..c816b240c`, 737 files
changed in `apps/api/src` alone), every finding was re-checked against the current tree.

**Method:** one read-only pass per changed app, each re-reading the cited files; plus a mechanical
citation check (235 cited paths, 200 resolved directly, the rest abbreviated or package specifiers) and a
re-measurement of every quantitative claim.

## Outcome

* **No finding was resolved, removed, or invalidated.** All 125 remain live.
* **Zero-churn apps are byte-identical** since `67bab09`, so their findings are unchanged and exact:
  `apps/engagement-api`, `apps/defense-parser-orchestrator`, `apps/defense-budget-parser`,
  `packages/defense-contracts`, `packages/defense-client`. `onboard-api` (2 files) and `onboard-web`
  (1 file) likewise changed immaterially — their findings hold.
* Where counts, sizes or paths **had** drifted they are corrected inline above. Line-number drifts of a
  few lines are left as-is under the standing rule: **re-grep by symbol, never trust a line number.**

## Corrections applied

| area | was (67bab09) | now (c816b240c) |
|---|---|---|
| `meri-tools.service.ts` / dispatch switch | 8,386 lines; 120 cases @ :1893-2131 | 10,252 lines; **132 cases** @ :2528-2841 |
| `engagement.service.ts` | 11,544 lines @ :1029 | 12,229 lines @ :1042 |
| `runTurn` (meriv2) | 545 lines @ :215-759 | **~1,751 lines** @ :907-2657; file moved to `meri/meriv3/` |
| `intelligence.service.ts` alias ladder | 30+ cases | 26 cases (line 5837 unchanged) |
| entity-kind ladder | 30-case | 26-case |
| `apps/api` services vs repositories | 365 / 25; 188 raw-SQL files | **397 / 25; 179** |
| `apps/api` `process.env` services | 47 | **59** |
| `config.schema.ts` | 1,139 lines | **1,276** |
| controllers injecting `PrismaService` | 11 | **9** |
| feature-flag guards (`apps/api`) | four | **six** |
| `intel-api` fetch sites / env reads | 21 / 138 | **22 / ~200** |
| `source-data.repository.ts` | 1,317 lines / 40 SQL | **1,609 / 39** |
| `task-runner.ts` verb switch | :130 | **:250** (36 verbs) |
| defense-api mirror | 378 `.ts` | **730 `.ts`** |
| `runtime-source` size | ~187k lines | **~206k lines** |
| web `*-api.ts` modules | ~60 | **~65** |
| web routes in `App.tsx` | 70 | **72** |
| web CSS files / test files | 171 / 598 | **184 / 648** |
| strategy-type label maps | three copies | **four** |
| verifier violation codes | 14 | **16** |

## Claim corrections (not just drift)

* `apps/api` **D2** — the `FLORIDA_FIRST_PARTY_HOSTS` constant was **removed**; the first-party gate is now
  a generic regex, and `florida-*.ts` grew from 14 to 29 files. Domain is still Florida-hardcoded.
* `apps/api` **A3** — `hearing-recap.service.ts` no longer shares the governed pipeline; the
  "third variant" claim is **resolved**.
* `apps/api` **O3** — `meri/hermes/meri-hermes.controller.ts` no longer exists (and no longer injects
  `PrismaService`).
* `api-strategy` **A3** — the eval harness now **imports** `VerifierNode`/`VerifierFiscal` from
  `@capiro/strategy-verifier`; only the strategy-type union is still re-declared. The old wording
  overstated the duplication.
* `meriv2` **D1** — the `research_federal_market_strategy` gap is now an explicit superset constant, not
  silent drift; the finding stands but the "unsynchronised" framing was softened.
* `meriv2` **D4** — one of the three literal tool→domain maps is now an alias layer over the catalog.
* `intel-api` **D1** — same as `apps/api` D2: `FLORIDA_FIRST_PARTY_HOSTS` removed, fifth site moved to
  `state-capture-policy.ts`.
* `defense-api` **A1** — HAC-D/SAC-D bodies still near-identical but emission drifted furthest
  (normalised diffs now 14/14/53/8 lines).

## Not re-derived (deliberately)

* **`cleanup2-dup-inventory.generated.md` / `.json` / `cleanup2-dup-status.md`** are stamped
  `generated_from_commit: 67bab09` and are **stale** relative to the current tree. They are machine-owned.
  Regeneration is **not** a single command: `graphify-out/*/graph.json` must be rebuilt first
  (`.graphify-venv/Scripts/python.exe .graphify_subjects.py --build all`), because `.graphify_ledger.py`
  slices symbol bodies from the *current* files using line numbers stored in the graph — against a stale
  graph it mis-slices every file that moved and produces incorrect groups. Until a rebuild is run, treat
  the ledger as historical and re-derive at execution time (CleanUp2 §4.1).
* **Test-case counts** in `CleanUp1.md` §3 (e.g. the 16,747 / 5,124 `it` counts) were not re-run; the file
  counts around them were refreshed. Re-derive with the §2 Step 0 commands.
* **`SECURITY_REVIEW.md`** was written at `67bab09` and is out of scope for this re-validation; its
  findings should be re-checked by its owner against the same 984-commit delta.
