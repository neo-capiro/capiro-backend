# Defense Budget vNext — implementation map

**Starting main:** `6afbd908c63d172d6d8df4774c063515cb078154`
**Branch:** `agent/defense-budget-vnext-ship`
**Prototype archive:** `program elements.zip` (486 entries, full listing inventoried; recursively extracted for reference)
**Authoritative visual source:** `Capiro Defense Budget - Untitled UI.dc.html` (4,011 lines: ~2,083 lines markup, ~1,930 lines fixture/state script)
**Design intent record:** `docs/prototypes/defense-budget-vnext-design.md` (shipped inside the archive itself — treated as authoritative alongside the prototype)
**Historical reference only:** `Capiro Program Elements - Untitled UI.dc.html`, `PROGRAM-ELEMENTS-HANDOFF.md`, `FOUNDATION-HANDOFF.md` (domain rules/invariants in PROGRAM-ELEMENTS-HANDOFF §1/§5/§10/§11 remain authoritative; its service-topology sections — a separate `apps/web-next` ECS service — are superseded by current reality: vNext lives inside `apps/web/src/vnext/**` on the single `os.capiro.ai`/`app.capiro.ai` shared bundle)

Files read in full or in targeted depth from the archive: `Capiro Defense Budget - Untitled UI.dc.html`, `docs/prototypes/defense-budget-vnext-design.md`, `PROGRAM-ELEMENTS-HANDOFF.md`, `FOUNDATION-HANDOFF.md`, `WARM-SURFACE-PALETTE.md` (already shipped, see `project_warm_surface_palette` memory), `UI-PARITY-HANDOFF.md` (metallic-black tokens already shipped). Remaining archive entries (Directory/LegiWatch/Meri/Strategies/Portfolio/Workspace/marketing assets/deck shots) are unrelated products, inventoried by filename only.

---

## 1. Prototype → production mapping

| Prototype element | Existing production component | Existing API | Required change | Verification |
|---|---|---|---|---|
| Global shell (top bar, rail, Meri launcher) | `apps/web/src/vnext/shell/AppShellUui/**` | `/api/me` | None — unchanged per spec | Visual QA screenshot |
| "Intelligence → Program Elements" nav item | `routeManifest.ts` line 127-131 (`VNEXT_ROUTE_MANIFEST`) | `/api/me` (tenant slug) | Add per-tenant label override (`tenantLabels`), applied in `visibleVNextRoutes` + `useShellNavigation` | New test in `routeManifest.test.ts` |
| Route gate (capiro-internal vs. fallback) | `VNextProgramElementsRoutes.tsx` (`isInternal ? <PeWorkspacePage/> : <PeFinderFallbackVNext/>`) | — | Swap the **internal** branch only to new `DefenseBudgetWorkspacePage` / `DefenseBudgetProfilePage`; non-internal branch (`PeFinderFallbackVNext`/`PeWatchFallbackVNext`) untouched | `VNextProgramElementsRoutes.test.tsx` extended |
| Explore | `PeExploreView.tsx` | `getProgramElementsList`, `getProgramElementSummary` (`pages/program-element/api.ts`) | New `DefenseBudgetExploreView.tsx`: family-adaptive columns, lifecycle miniature, context-bar-scoped | Vitest + visual QA |
| Movement | `PeMovementView.tsx` | `getMovement` (`/api/budget-lines/movement`) | New `DefenseBudgetMovementView.tsx`: intelligence rail, feed/table toggle, waterfall card | Vitest + visual QA |
| Congressional | `PeCongressionalView.tsx` | `getMarkupMonitor`, `getProgramElementDetail`, `buildFundingSeries` | New `DefenseBudgetCongressionalView.tsx`: House/Senate/Gap matrix + dual-track diagram, shared stage-card contract | Vitest + visual QA |
| Actions | `PeActionsView.tsx` | `useActionsList` (`pages/actions/actions-api.ts`) | New `DefenseBudgetActionsView.tsx`: needs-attention cards + Action Board table, unchanged ownership | Vitest + visual QA |
| Portfolio | `PePortfolioView.tsx` | `getProgramElementsList`, `getRelevantClientsForPe`, `useActionsList` | New `DefenseBudgetPortfolioView.tsx`: client-first cards, no dollar summing | Vitest + visual QA |
| Line profile (5 tabs) | `profile/PeProfileVNext.tsx` + `usePeProfileVNextVm.ts` | `useProgramElementProfileFinalCore` (shared with canonical antd profile) | New `defense-budget/profile/**`: Overview / Funding & lifecycle / Congressional / Program structure / Sources & proof | Vitest + visual QA |
| Source/evidence inspector | `PeV2SourceInspector` equivalent inside PE profile | same as profile | New shared drawer, content-switched, adds lifecycle observation fields | Vitest |
| Sources & proof coverage meter | *(none — new)* | **new**: `apps/api` lifecycle read routes (ported from Session 11) | New `DefenseBudgetCoverageMeter` component + backend port (§2 below) | Live endpoint smoke + vitest |
| `/defense-budget-lifecycle` health + review-queue pages | `DefenseBudgetLifecycleHealthPage.tsx`, `DefenseBudgetLifecycleReviewQueuePage.tsx` | `defense-budget-lifecycle-api.ts` (already calls `/api/budget-lifecycle/*`) | Kept as internal deep-link/debug routes; their coverage data is surfaced inline in the new Sources & proof tab instead of being a second competing product surface | Manual nav check |
| Global context bar (FY/family/service/search/watched/filters) | *(none — new, prototype-only today)* | derived from existing filter params + new FY dimension | New `defense-budget-context.ts` (URL state hook), shared by all 5 destinations | Vitest |

---

## 2. Critical finding: lifecycle data-wiring reality (Task §6/§7)

Verified directly (backend code + infra) — **not assumed**:

- `apps/api` already serves `GET /api/program-elements*` and `GET /api/budget-lines/*` live, behind `RolesGuard`/`standard_user`, on `capiro-dev-api` (the same service behind the generic `/api/*` ALB rule). No routing trap — unlike `/api/engagement/*`, these are not preview-header-gated.
- `apps/defense-api` (Phase 8 Session 11's `budget-lifecycle-product` module, `GET /api/budget-lifecycle/*`) is **not reachable in production**: no ECS service, no ALB target group, no listener rule, no task-def anywhere in `infra/cdk` or `infra/deploy`. The service's own README calls itself "intentionally dark." The frontend already has a typed client (`defense-budget-lifecycle-api.ts`) pointed at these paths, but it 404s/fails today because nothing serves them.
- **Resolution (per task §7, option 1):** port the six Session 11 read routes into `apps/api` as a new module, reusing:
  - `@capiro/defense-contracts` DTOs verbatim (`DefenseCycleHealthDto`, `DefenseExpectedSourceListItemDto`, `DefenseExpectedSourceDetailDto`, `DefenseReviewQueueItemDto`, `DefenseLifecycleSignalDto`, `DefenseScheduleTickHealthDto`) — new workspace dependency, not yet in `apps/api/package.json`.
  - `@capiro/defense-domain` pure functions verbatim (`buildCycleHealth`, `deriveLifecycleSignals`, `buildScheduleTickHealth` — zero side effects, confirmed by reading them) — new workspace dependency.
  - `apps/api/prisma/schema.prisma` **already has fully-typed Prisma models** for every lifecycle table (`DefenseBudgetCycle`, `DefenseBudgetExpectedSource`, `DefenseBudgetSourceObservation`, `DefenseBudgetWatcherAdapter/Run`, `DefenseBudgetIngestionOutbox`, `DefenseBudgetScheduleTick`) — so the port uses typed Prisma calls, not `defense-api`'s raw-SQL-with-casts convention (that convention exists only because `defense-api`'s own curated Prisma subset excludes these models; `apps/api`'s client has no such exclusion). Requires `prisma generate` once per fresh checkout (schema already has the models; client just needs regenerating).
  - These tables carry **no `tenant_id`** (global reference data, same posture as `Program`/`ProgramAlias`), so the read service needs no RLS bypass — only the new guard's own internal `tenants` lookup does (`withSystem`, mirroring `DistrictNexusFlagGuard`).
- **New guard**, modeled on `apps/api/src/district-nexus/district-nexus-flag.guard.ts` but simplified (no `intel_feature_flag` fallback — strictly capiro-internal, per task §7): fast path on `CAPIRO_INTERNAL_TENANT_ID` config match, else `withSystem` DB check of `tenants.slug = 'capiro-internal'`, else 404 (never 403, fail-closed on any error, no tenant context → 404).
- Guard chain: `@UseGuards(RolesGuard, DefenseBudgetLifecycleInternalGuard)`, `@Roles('standard_user')` — same order as `DistrictNexusController`.
- Route table is GET-only by construction (only `@Get` handlers registered); no watcher/lease/scheduler/provider/promotion call anywhere in the new service (verified against the Session 11 original, which has the same property).

---

## 3. What is explicitly NOT in scope (confirmed against task §0)

- No change to `apps/defense-api`'s deployment status (stays dark/one-shot).
- No EventBridge/Cron/scheduler activation (Session 10's own open item, explicitly deferred by Session 12 and by this task).
- No Bedrock/NVIDIA/provider activation.
- No change to backfill/ingestion behavior or production budget facts.
- No GA rollout beyond `capiro-internal` — the existing tenant-slug gate in `VNextProgramElementsRoutes.tsx` is reused, not replaced with a second flag.

---

## 4. Family coverage honesty (Task §9)

Confirmed against `apps/api/src/program-element/program-element.controller.ts` + the prototype's `FAM_COLS` fixture map: today's canonical line-level product data (`program-element` table) covers **RDT&E and Procurement** primarily (PE codes, P-1 lines) with partial O&M coverage. **MILCON / MILPERS / WCF / Health have no canonical line-level projection in `apps/api` yet.** The Explore/Portfolio family filters will render these families with an honest sparse/coverage state (using the new lifecycle `expected-sources`/`health` reads for source coverage context) rather than fabricating project/account rows. This is disclosed in the UI copy, not hidden.
