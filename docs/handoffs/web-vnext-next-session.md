# Web vNext / os.capiro.ai — handover for the next session

**Written:** 2026-08-11 (updated after §0) · **Branch:** `agent/web-vnext-figma-impl`
**Deployed:** `a3dbce1d` — task def `capiro-dev-web-vnext:7`, confirmed live by re-measuring
the DOM after deploy (shell height now matches viewport exactly, Meri radius 999px,
context grid row 0px). `docs/runbooks/web-vnext-release-dev.env` has the release history.

## The goal you were handed

Get **Meri (v3 undocked chat), LegiWatch, Dashboard, App Shell, Client Profiles, and
Program Elements** all merged into `main` and shipped, all rendering on **os.capiro.ai**
and **not** app.capiro.ai, all matching their mockups or better.

Two of those six are genuinely built. Read §3 before believing any status.

---

## 0. Three shell/dashboard fixes made after this doc was first written

Neo reviewed a live screenshot and flagged three defects. All three were confirmed by
measuring the actual rendered DOM (`getBoundingClientRect`/`getComputedStyle` via the
browser tool) before fixing — **don't trust CSS source-reading alone for layout bugs**;
two of these three gave misleading signals when reasoned about from the stylesheet text
alone. Fixed in commit `a3dbce1d`, building/deploying as this doc is written.

1. **Sidebar required scrolling the whole page to reach Settings/Collapse.**
   Root cause: `.capiro-vnext-shell` used `min-height: 100vh` instead of `height: 100vh` +
   `overflow: hidden`. Once dashboard content exceeded one screen (measured: 1050px page vs
   816px viewport), the *entire shell* — and the sidebar, which spans its grid rows — grew
   to the page's full height instead of staying capped at the viewport. The Collapse button
   measured at `top: 998px` against a `816px` viewport. Fixed: shell is now viewport-capped,
   only `.capiro-vnext-content` scrolls (it already had `overflow: auto`), and the sidebar
   got `overflow-y: auto` as a safety valve for its own content. **Generalizes:** any other
   full-height container in this codebase that uses `min-height: 100vh` on a grid/flex parent
   whose children are meant to stay pinned has the same latent bug — grep for it.
2. **Meri launcher didn't match the design system.** Confirmed live: `getComputedStyle`
   showed `border-radius: 10px` on a 30px-tall button — a rounded rectangle. The actual
   Figma reference screenshot for `Shell/MeriLauncher` (`722:2517`) is an unambiguous full
   pill. **The node's own Figma-bound variable (`--capiro-radius-shell-control` = 10) directly
   contradicts its own rendered screenshot** — a real trap: `get_variable_defs` and the visual
   reference disagreed, and the screenshot won per the design-to-code priority order. Fixed:
   `border-radius: 999px`. **Lesson: when a bound variable and the component's own reference
   screenshot disagree, download and actually look at the screenshot — don't resolve the
   conflict by trusting whichever data structure is more convenient to read.**
3. **Large empty gap above Dashboard content.** Confirmed live: `gridTemplateRows` computed
   to `"64px 44px …"` with `hasContextBarInDom: false` — the shell's grid unconditionally
   reserves a context-bar row even when `AppShell` renders no context bar (true on Dashboard,
   per the `DASHBOARD · OFF` rule at `729:2617`). Fixed: `AppShell` now sets
   `data-context="hidden"` on the shell root when `clientContext.enabled` is false, and
   `[data-context='hidden']` collapses that row's track to `0px`.

**Confirmed live** (task def `capiro-dev-web-vnext:7`, `releaseSha: a3dbce1d`): shell height
816px = viewport height exactly (was 1050 vs 816), Collapse Navigation's bottom edge at
804px is inside the viewport, Meri `border-radius: 999px`, Dashboard `gridTemplateRows`
`"64px 0px 752px"` with `data-context="hidden"` set. All measured via `getComputedStyle`/
`getBoundingClientRect`, not assumed.

## 1. The fact that makes this safe (verify it, then stop worrying)

**Merging every vNext file into `main` will NOT put vNext on app.capiro.ai.**
The surface is chosen per ECS task definition, not per branch:

| Service | `WEB_SURFACE` | Renders |
|---|---|---|
| `capiro-dev-web` → app.capiro.ai | *(unset)* | `<AppShell/>` — canonical/legacy |
| `capiro-dev-web-vnext` → os.capiro.ai | `vnext` | `<VNextApp/>` |

`App.tsx` picks the surface from `resolveWebPresentation(webSurface)`, which reads
`window.__CAPIRO_CONFIG__.webSurface`, which nginx's `entrypoint.sh` writes from the
`WEB_SURFACE` env var at container start.

So: **merge freely to `main`; ship os.capiro.ai by deploying the WebVNext stack.**
The one rule from the runbook — never add `WEB_SURFACE=vnext` to the canonical web task.

Re-verify in one command before you trust this:
```bash
aws ecs describe-task-definition --task-definition capiro-dev-web:72 \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`WEB_SURFACE`]'
```

## 2. Where things actually stand

- Branch `agent/web-vnext-figma-impl`, worktree `C:\dev\capiro-vnext-wt`, clean and pushed.
- os.capiro.ai serves `928970ce`, task def `capiro-dev-web-vnext:6`, 1/1 running.
- **Nothing vNext is in `main` yet.** MeriV3 *is* in main; app.capiro.ai runs `744c4b23`
  (2 behind main) which includes MeriV3's UI-parity commits.
- Rollback: `5422d719` / `sha256:9cf355e8…`. Full image history is in
  `docs/runbooks/web-vnext-release-dev.env`.

**Do not trust a handoff doc's claim about what is deployed.** It has been wrong twice.
Read the live task definition's image tag and resolve it to a git SHA yourself.
This session found os.capiro.ai running `d6644a89` from a *different branch*
(`chatgpt/os-vnext-strategies-legiwatch`) that no one had mentioned — deploying as
planned would have silently reverted Strategies and LegiWatch off the live domain.

## 3. What is real vs. what only looks done

The single fastest test — a real design-system implementation imports **no antd**:

```bash
grep -rln "from 'antd'\|@ant-design/icons" apps/web/src/vnext/
```

| Family | Status | Evidence |
|---|---|---|
| **App Shell** | ✅ real | zero antd; built from `722:2502` frames |
| **Dashboard** | ✅ real | zero antd; rebuilt this session against the `760:2641` contract |
| **LegiWatch** | ⚠️ **re-layout, not an implementation** — but antd is now gone | ~~imports antd~~ (removed, `f6576d16`); still embeds canonical `RadarPage`, which §11.2 says is *correct* — the remaining gap is layout, not the reuse |
| **Strategies** | ⚠️ **re-layout, not an implementation** — but antd is now gone | ~~3 files import antd~~ (removed, `f6576d16`); `/strategies/:id` still renders legacy `StrategyEditorPage`; steward/agent routes still wrap canonical components in a `GovernanceSurface` shim |
| **Program Elements** | ⚠️ **not started in vNext — but the feature is already fully built in production** | `vnext/pages/program-elements/` is a 381-byte README, *but* the real feature is 12 files under `apps/web/src/pages/program-element/`. Its Handoff frame mandates re-skinning those, **not** a greenfield build — see §11 |
| **Client Profiles** | ❌ not started, **and design source unknown** | see §6 |
| **Meri v3 undocked** | ✅ shipped & verified live | see §5 |

Strategies and LegiWatch came in via the merge from `chatgpt/os-vnext-strategies-legiwatch`.
They render and carry real data, but they are the old UI re-arranged. Neo flagged exactly
this. The merge commit `06a9d936` calls the result "one vNext surface from one Figma
source" — that is accurate for the shell and Dashboard only. Correct it if you touch it.

**Good news for Program Elements:** the seven intelligence visualisations it needs are
already built and design-system-clean in `apps/web/src/vnext/intelligence/`
(FundingTrajectory, FundingBridge, CongressionalPath, EvidenceCoverage, MovementRail,
MovementDistribution, ProgramRelationshipMap), and are already mapped in the manifest.

## 4. Figma: node IDs, and the frames that are actually normative

**`apps/web/src/vnext/figma/manifest.ts` is the node inventory. Use it.** It records
page + frame IDs for appShell, dashboard, programElements, strategies and legiWatch.

**The top-level page list from `get_metadata` with no nodeId is incomplete** — it returns
9 design-system pages and omits every "Canonical App" page (Strategies `842:2502` is real
but unlisted). Never conclude a design doesn't exist from that list.

### Read the family's Handoff frame FIRST — before any code

Each family ships a designer-authored engineering contract. The Dashboard's
(`760:2641`) went unread for two sessions and, when finally opened, **contradicted the
prose brief**: density is three modes not two, module *order* is a persisted preference
nobody had built, and the ship gate (acceptance A–F) lives there rather than in the brief.

| Family | Handoff frame |
|---|---|
| Dashboard | `760:2641` (read; drove this session's rebuild) |
| Program Elements | `788:2765` — **READ. Contents and consequences in §11.** |
| LegiWatch | `891:2593` — **READ. Contents and consequences in §11.** (+ system states `895:2593`, still unread) |
| Strategies | **There is no Handoff frame.** Page `842:2502` holds 14 frames, all screens and modals (`01 Library` → `14 Resolve Conflict`) — no engineering contract, no ship gate. Verified by enumerating the page's direct children. Strategies is the one family with no designer-authored acceptance criteria. |

Expect each to carry: a module/content matrix (allowed vs excluded content), a
customization contract, a density contract, a per-file code mapping, a migration
boundary, and acceptance criteria. Treat them as the ship gate.

### Non-negotiable process rule

**Always `get_design_context` on the actual node before writing a line of CSS.**
Never build from `get_metadata` + a screenshot. Phase 1 followed this and needed no
rework; Phase 2 didn't and needed three rounds of fixes plus a full rebuild this session.
Load the `figma-design-to-code` skill first — the tool requires it.

## 5. Meri v3 undocked chat

**This is the latest Meri and it is already done, in `main`, and verified live.**
Commits `c0f8646a` (workspace UI parity) and `13dec063` (pixel-match the mockup).

- Path: launcher → `openMeriWorkspaceWindow()` → `/?meriWindow=1` → `VNextApp` detects
  `isMeriWorkspaceWindow()` → `MeriOverlay` → `MeriWorkspaceWindow`.
- Verified on os.capiro.ai: thread rail, command header, composer with `SCOPE: THREAD`,
  governance line, prompt library, tenant `CAPIRO-INTERNAL`.
- Gate: `features.meriv3Chat` = `MERIV3_ENABLED` **and** tenant slug in
  `MERIV3_CANARY_TENANT_SLUGS` (currently six tenants) **and** per-tenant
  `meriv3.fullChat`. The live API has the first two open.

**The trap:** if any gate is closed, or the popup is blocked, `MeriOverlay` silently
falls back to the **MeriV2 drawer** — the old UI, with no error. If Meri "looks old",
check the gate before assuming the build is stale.

**MeriV2 itself is deliberately frozen.** The canary brief makes it a hard constraint
that `ChatDrawer`'s default path keep rendering exactly as today, because it serves every
non-canary tenant with no visual regression coverage. Do not restyle it without an
explicit decision. Structural v3 changes go behind `variant === 'v3'` or, better, in the
sibling `MeriWorkspaceConversation` component that already exists.

**Design source for the Meri workspace is NOT Figma** — it is
`C:\Users\neoma\Downloads\Meri Chat Workspace.html` (+ `meri-mockup-dom-styles.txt`).
Figma only carries Meri *tokens* (`color/action/meri/*`, `Elevation/Meri`, `shadow/meri`).

## 6. Client Profiles — scope change, and an open question for Neo

Client Profiles was **explicitly out of scope** for this program until Neo put it in scope
in this session's final instruction. Before building:

- **No Client Profiles page exists in `figma/manifest.ts`, and a design-system search
  finds no Client Profile frames.** ~~The design source is unknown — ask Neo where it is.~~
- **RESOLVED — Neo supplied it. The design source is page `906:2502`,
  "33 · Canonical App · Client CRM vNext".** The earlier search failed because the page is
  named **Client CRM**, not "Client Profile" — searching the design system for the latter
  returns nothing. All 18 frames are now inventoried as `clientProfiles` in
  `figma/manifest.ts`: Overview; Relationships × 3 (Organization / Government / History);
  Work; Intelligence × 6 (Overview / Legislative / Regulatory / Funding & Budget / Federal
  Footprint / District Nexus); Files; plus Person Profile, Current Target, Strategy Detail and
  Data Health drawers and the Configure Hierarchy and Move to Folder modals.
- **It has no Handoff frame either** — same as Strategies (§11.3). Two of the six families
  therefore have no designer-authored acceptance criteria at all.
- Prior art lives on other branches: `agent/capiro-design-system-v3-react`,
  `agent/client-profile-crm-cleanup`, `dev/outreach-client-profile`.
- A recorded lesson applies: *client-profile forked whole-file against main's #892 — v3
  must be re-applied onto the modular components, not merged.* Expect the same
  whole-file-fork problem the shell had this session.

## 7. Code Connect — live, and you must use it

Code Connect is **published and working** (Neo upgraded the Figma plan; it is
Org/Enterprise-gated). Verified this session against `722:2502`.

**What it does for you:** `get_design_context` on a mapped node returns *your real
component* wrapped in `<CodeConnectSnippet>` instead of generic markup. Use the named
component and drop the wrapper. The import path in the snippet may be non-relative or a
URL — search the codebase for the component and use the real one.

Confirmed live mappings (Figma → `apps/web/src/vnext/…`):

| Figma | React |
|---|---|
| Button/Main | `CapiroButton` — components/actions |
| Status/Badge | `CapiroBadge` — components/badges |
| Field/Input | `CapiroInput` — components/fields |
| Choice/Control | `CapiroSelect` — components/fields |
| Table/Row | `CapiroTableRow` — components/tables |
| Shell/Search | `GlobalSearch` — shell/GlobalSearch |
| Shell/MeriLauncher | `MeriLauncher` — shell/MeriLauncher |
| Shell/ContextChip | `CapiroContextBar` — shell/ContextBar |
| Navigation/Item + Navigation/TopItem | `CapiroNavItem` — shell/Sidebar |
| Mailbox Sync | `MailboxSyncStatus` — shell/MailboxSyncStatus |

Also useful:
- `get_code_connect_map` on a screen node lists every mapped child at once — cheap way to
  see what you can reuse before implementing.
- `get_code_connect_suggestions` / `add_code_connect_map` / `send_code_connect_mappings`
  to **add** mappings. As you build Program Elements and Client Profiles, publish
  mappings for the new components so the next session inherits them.
- Re-map with `send_code_connect_mappings` if components move.
- `FIGMA_REACT_MAPPING_INVENTORY` at the bottom of `figma/manifest.ts` is the
  human-readable companion — keep it in sync.

Known gap: Button/Main is a 30-variant matrix (Standard|Compact × Primary|Secondary|Quiet
× Default|Hover|Focused|Pressed|Disabled) and needs a Focus/Ring effect `CapiroButton`
lacks.

## 8. Release mechanics (all verified this session)

```bash
# 1. build ARM64 (Fargate here is arm64; QEMU on this x86 box, ~20 min warm cache)
docker buildx build --builder pe-ship --platform linux/arm64 \
  -f apps/web/Dockerfile \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:$SHA --push .

# 2. deploy (context lives in docs/runbooks/web-vnext-release-dev.env)
cd infra/cdk && npx cdk deploy --app "ts-node --prefer-ts-exts bin/web-vnext.ts" \
  -c releaseSha=$SHA -c webVnextImageDigest=$DIGEST  # …plus the imported-infra context
```

- **Never `pnpm --filter … -- -c …`** — pnpm forwards `--` literally, cdk silently drops
  every context value and fails with `Missing required CDK context: releaseSha`.
- Run `cdk diff` first. os.capiro.ai and app.capiro.ai **share the `capiro-prod-alb`
  listener**; app.capiro.ai is the listener's *default* action and vNext is a host rule at
  priority 50. **Any diff touching the default action or a rule below 50 is a stop
  condition.** A clean diff touches only WebVNext-owned resources plus a TaskDef replace.
- Pipe the build through `tee`, not `tail` — `| tail` buffers and you get no progress.
- Rollback = redeploy the prior SHA + digest. CloudFormation deregisters the old task-def
  revision, so the retained SHA-tagged ECR image is what makes rollback possible.

## 9. Known gaps and risks

1. **Tablet stage (1024) has never been seen rendering.** The CSS is written from
   `757:2618`/`758:2622` and unit-tested, but the browser window would not resize below
   the desktop breakpoint in this environment. Mobile *was* verified live.
2. `/strategies/:id` and the steward/agent routes are the legacy UI behind a shim.
3. `pnpm --filter @capiro/web visual:vnext:capture` has never produced artifacts
   ("No Lighthouse screenshot data was available"). Screenshot review is manual.
4. Repo-wide GitHub Actions have been `startup_failure` since 2026-07-31 — there is no CI
   signal on any branch. Verify locally; don't blame your branch.
5. `main` carries unapplied Prisma migrations from PE Phase 7. **A web-only WebVNext
   deploy does not run migrations**, so shipping os.capiro.ai is unaffected — but anyone
   deploying the API from main must apply them first.
6. **Fixture-green is not done.** Deploying has three times now revealed defects fixtures
   hid (ingestion telemetry in Needs Attention; recurring meetings collapsing by rendered
   time string; `/strategies` rendering a detail error). QA on os.capiro.ai against
   exported Figma nodes before calling anything finished.

## 10. Suggested order

1. **Merge to `main` first.** It is safe (§1), it unblocks everything, and it stops the
   parallel-branch problem that cost this session hours. Open one PR from
   `agent/web-vnext-figma-impl`. Before merging, re-check for *other* unmerged vNext
   branches: `git ls-remote --heads origin | grep -iE "vnext|os-"`.
2. ~~Read the three unread Handoff frames~~ — **done, and they did contradict the scope.
   Read §11 before planning steps 3 and 4; both are re-scoped by it.**
3. **Re-skin Strategies and LegiWatch — do not rebuild their data layers.**
   **PART DONE (`f6576d16`): antd is gone from `src/vnext` and the §3 grep is clean.** The
   coupling was never layout components — only `message`/`modal` in 3 Strategies files and 19
   icon glyphs in 4. Replacing it needed two primitives the design system lacked:
   `components/icons` (19 inline-SVG glyphs, `em`-sized, `currentColor`) and
   `components/feedback/toast` (`CapiroToastProvider`/`useCapiroToast`, mounted in `VNextApp`).
   `StrategyContextDocumentVNext`'s archive confirm moved from antd's imperative
   `modal.confirm` to declarative `CapiroModal` + page state. Verified: `tsc` exit 0,
   36 vitest tests pass, `vite build` succeeds.
   **STILL TO DO: the actual layout re-skin** against
   `843:2502…` and `869:2502…`, removing antd from the *presentation*. LegiWatch's contract
   is explicit: *"Do not copy these hooks into src/vnext. Build adapters around existing
   query/mutation ownership."* So §3's "embeds canonical `RadarPage`" is only half a defect —
   reusing RadarPage's logic is **required**; it is the antd presentation that must go.
   Note 3 of LegiWatch's 9 tabs are additive and need endpoints that may not exist (§11).
4. **Re-skin Program Elements — it is NOT a greenfield build.** All 12 files named in its
   Handoff frame exist in production under `apps/web/src/pages/program-element/` (verified).
   The frame's own words: *"One feature contract. Existing backend. New presentation."*
   Building fresh in `vnext/pages/program-elements/` would violate its explicit
   **DO NOT INTRODUCE** list (duplicate backend, new PE-specific action system) and lose the
   route contract. The seven visualisations in `vnext/intelligence/` are still useful, but as
   replacement presentation inside the existing pages — not as the skeleton of a new feature.
5. **Client Profiles** — resolve the design source with Neo first (§6).
6. One build, one deploy, then QA on os.capiro.ai against exported Figma nodes.

Publish Code Connect mappings for every new component as you go.

## 11. The Handoff frames, now read — and what they change

Read via `get_design_context` on the real nodes (per §4's rule), not from screenshots.
**Both frames re-scope the work from "build" to "re-skin".** This is the same failure the
Dashboard's frame exposed, and it would have cost far more here: building either family
greenfield would have violated an explicit prohibition in its own contract.

### 11.1 Program Elements — `788:2765` · "CANONICAL · READY TO IMPLEMENT"

Headline: **"One feature contract. Existing backend. New presentation."** The frame says
outright that no new backend service, duplicate data model, or second action system is
required. Status badge: ready to implement.

**Route contract — preserve URLs and deep links:**

| Route / query | Owner / result |
|---|---|
| `/program-elements` | Explore · default (dest omitted) |
| `?dest=movement\|congressional\|actions\|portfolio` | Same workspace shell; destination changes only |
| `/program-elements/:peCode` | Line profile |
| `?tab=funding\|legislative\|structure\|sources` | Profile tab; Overview omits tab |
| `/actions?peCode=:peCode` | Governed Action Board create/open path |

**Current production ownership — all 12 verified present in the repo:**

| File | Owns |
|---|---|
| `ProgramElementsV2Page.tsx` | Destination URL + bar; summary counts |
| `PeV2Explore.tsx` | Search, filters, density, expand, select, paging, watch, CSV |
| `PeV2Movement` / `Congressional` / `Actions` / `Portfolio` | Destination-specific queries and controls |
| `ProgramElementV2ProfilePage.tsx` | Shared profile header, snapshot, trust strip, 5 visible tabs |
| `useProgramElementProfileFinal.ts` | Queries, lazy tab loading, actions, clients, watch, export |
| `PeV2*Tab.tsx` | Overview / Funding / Legislative / Structure / Sources bodies |
| `PeV2SourceInspector.tsx` + `DataIssueModal` + `PeLoadState` | Trust layers, feedback, explicit failure states |
| `v2/pe-v2.css` | **The file to replace** — swap for canonical vNext tokens/responsive rules |

They live at `apps/web/src/pages/program-element/` and `.../v2/` (not `vnext/`).

**Migration boundary.** PRESERVE: API endpoints, TanStack query ownership and query keys,
V2 route/feature gating and deep links, watch mutation + monitoring persistence,
CSV/profile export, Action Board links and governed status, source/reconciliation/data-issue
workflows. CHANGE: shell/page geometry and typography, dense Explore grid → responsive
records, filters/badges/cards/drawers/tables, profile information hierarchy and trust
treatment, mobile/tablet reflow and More ownership, visual regression targets.
**DO NOT INTRODUCE:** duplicate backend or database tables · a new PE-specific task/action
system · a combined authorization + appropriations number · silent request carry-forward for
a missing stage · candidate relationships presented as verified · "empty" UI when the
API/source actually failed.

**Data & state invariants — stated as acceptance rules, not preferences:**
`MISSING ≠ ZERO` (null/absent stays absent; no carry-forward) · `PARALLEL TRACKS`
(authorization and appropriations are **never summed**) · `CURRENT` (latest asserted
appropriations position; NO POSITION is valid) · `EVIDENCE` (conflict/pending/absent are
distinct from workflow status) · `MONITORING` (watch state only) · `ACTIONS` (existing Action
Board owns status/assignee/due date/review) · `DATA ISSUE` (feedback only; canonical change
needs the reconciliation path) · `RELATIONSHIPS` (candidate links stay labeled; graphs
require a verified set).

**Sequence:** 01 tokens + shared PE chrome → 02 workspace destinations (Explore → Movement →
Congressional → Actions → Portfolio) → 03 shared profile → 04 tab bodies → 05 trust layers →
06 responsive → 07 visual QA.

**Ship gate A–F:** A FUNCTION · B TRUST · C OWNERSHIP · D RESPONSIVE (232/72 rail) ·
E ACCESSIBILITY (keyboard focus, escape/return focus, labels, ≥44px mobile targets, AA
contrast) · F PARITY (visual regression across desktop expanded/collapsed, tablet, mobile,
filters, inspector, modal, failure states).

### 11.2 LegiWatch — `891:2593` · "READY TO IMPLEMENT"

Headline: **"Figma defines presentation and responsive behavior. Existing hooks, API
contracts, permissions, and governed actions remain canonical."**

**Routes.** EXISTING (preserve): `/legiwatch?tab=feed`, `?tab=bills`, `?tab=hearings`,
`?tab=watchlist`, `/bills/:billId`, `/intelligence/hearing-watch/:sessionId`.
ADDITIVE: `?tab=overview`, `?tab=digest`, `?tab=analytics`. Tabs must stay URL-addressable;
alert detail and Bill 360 may be route-backed drawers, but browser back/forward must restore
the prior worklist state.

**React source map — and the hard rule.** `RadarPage.tsx` (tab + scope orchestration),
`TrackerFeedPanel.tsx` (unified feed + work states), `TrackerTab.tsx` (packet actions + bill
routing), `TrackerConfigPanel.tsx` (watchlist targeting + alerts), `HearingWatchPage.tsx`
(schedule, sessions, live route), `BillDrawer.tsx` (in-place Bill 360 shell),
`BillDossierBody.tsx` (dossier tabs + evidence). Verbatim: **"Do not copy these hooks into
src/vnext. Build adapters around existing query/mutation ownership."** Badge: REUSE BUSINESS
LOGIC.

**Screen → component map** (badge: ONE PACKET MODEL — feed, drawer, digest and hearing
moments must share one evidence/confidence/unknown/client-impact/work-state vocabulary):
OVERVIEW `OperationalPulse · DecisionQueue · ClientExposure · PolicyWindows` ·
FEED `SavedViewStrip · BulkTriageBar · AlertPacketCard · ViewControlRail` ·
ALERT DETAIL `AlertDecisionDrawer · EvidenceBlock · MatchExplanation · Unknowns` ·
BILLS `BillRecommendationCard · BillStageBoard · Bill360Drawer` ·
HEARINGS `HearingSchedule · SessionRail · LiveTranscript · MomentCard` ·
WATCHLISTS `CoverageScore · TargetingEditor · DeliveryPreferences` ·
DIGEST `DigestBrief · DecisionList · DeliveryRail` ·
ANALYTICS `SignalVolume · IssueMomentum · ExposureMatrix · SourceCoverage`.

**Product boundary.** EXISTING · PRESERVE: all-client/client scope and server work states;
unified federal/state/hearing/regulation/PE packets; bulk triage and packet actions; bill
recommendations, board and Bill 360; hearing schedule, sessions, transcript moments; client
watchlist targeting and alert preferences. ADDITIVE · **IMPLEMENT BEHIND FLAGS**: Overview
aggregate from existing packet queries; Morning Digest generation/persistence/delivery;
Analytics aggregates / time-series endpoints; per-user Saved Views persistence; Fast Create
Watch preset supplementing canonical client watchlists.

> **"Do not silently substitute mock data when an additive endpoint is absent. Render the
> explicit unavailable or partial state."** Three of the nine tabs are in this additive set.
> Audit those endpoints against the live API *before* building them — this is the same rule
> that has already bitten this program on fixture-green work (§9.6).

**Responsive contract:** ≥1280 → 232px sidebar · desktop tabs · feed + context rail ·
768–1279 → **72px rail · two-column worklist · compact controls** · <768 → 56px top bar ·
64px bottom nav · one-column feed · DETAIL → desktop right drawer, mobile bottom/full-height
sheet. All mobile and tablet targets ≥44px. Dense tables become record cards; desktop columns
are **not** merely scaled down. Note this collides with §9.1 — the tablet stage has never been
seen rendering, and this is a distinct layout, not a squeeze.

**System-state matrix:** `LOADING` skeleton preserves module geometry · `PARTIAL` available
packets + source warning · `STALE` retain data + timestamp + refresh · `UNAVAILABLE` name the
failed source, **never show zero** · `EMPTY` all-clear vs filtered-empty vs true no-results ·
`COLD START` guided watchlist setup, no meaningless feed.

**Non-negotiable invariants:** missing data never equals zero · evidence quality and workflow
state are separate fields · authorization/appropriations/regulation/hearing posture keep
source-specific semantics · bill clicks open Bill 360, not a Data Explorer route · hearing
stream capability resolved honestly (direct / browser capture / pending / unavailable) · no
alert action autonomously sends outreach or publishes externally · "Why am I seeing this?"
cites actual matching inputs and the priority band · browser back/forward, permissions,
feature flags and tenant scope stay intact. Gate: typecheck, build, route tests, work-state
mutations, packet actions, responsive screenshots and Figma parity all pass before cutover.

### 11.3 Strategies — no Handoff frame exists

Page `842:2502` ("30 · Canonical App · Strategies vNext") has 14 top-level frames, all
screens and modals: `01 Library`, `02 Editor`, `03 Editor — Meri & Step Rail`,
`04 Context Library`, `05 Context Document`, `06 Steward Review`, `07 Agent Review Queue`,
`08 Execution Review`, `09 New Strategy Modal`, `10 Firm Phases Modal`, `11 Export`,
`12 History`, `13 Upload Context`, `14 Resolve Conflict`. No handoff, no implementation
contract, no acceptance criteria — searched the whole page's node tree for them.

They match `figma/manifest.ts` exactly, so the manifest is trustworthy here.

**Consequence:** Strategies is the only family with no designer-authored ship gate. Do not
invent one silently. Either ask Neo for the acceptance criteria, or derive them from the two
frames above (their invariants are largely product-wide) and **write down that you derived
them** so the next session knows they are not the designer's.

### 11.4 Also learned

- **Code Connect returns real props, not just names.** `891:2593` came back with
  `<CapiroBadge showDot label tone="Review" emphasis="Subtle" />` and per-variant component
  docs ("Tone communicates intent; emphasis communicates prominence. Do not use it as a
  substitute for evidence classification"). §7 is live and worth leaning on harder.
- **`get_metadata` on a whole page can exceed the tool's token cap** — `842:2502` returned
  462,693 characters and was spilled to a file. Query a specific frame, or enumerate the
  page's direct children from the spill file, rather than re-running it.
- Both frames independently forbid the same class of error: **showing zero or empty where the
  truth is "missing" or "failed."** Treat that as a product-wide invariant, not per-family.
