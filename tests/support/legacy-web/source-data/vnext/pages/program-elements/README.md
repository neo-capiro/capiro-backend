# Program Elements vNext

Native module (Phase 3 of the os.capiro.ai old-UI purge — PE-CORE tranche).

## What is native here

- `VNextProgramElementsRoutes.tsx` — module router: path parsing (VNextRouter
  mounts above the canonical param routes, so params come from
  `location.pathname` via `pe-routes.ts`, never `useParams`) plus the
  `capiro-internal` tenant gate reproduced from App.tsx's
  `ProgramElementFinderGate`/`ProgramElementWatchGate` (including the
  no-loading-branch semantics).
- `PeWorkspacePage.tsx` + `PeExploreView/PeMovementView/PeCongressionalView/
  PeActionsView/PePortfolioView` — native ports of
  `pages/program-element/ProgramElementsV2Page.tsx` and
  `pages/program-element/v2/PeV2*.tsx`, over the same endpoints/query keys.
- `PeMarkupMonitorPage.tsx`, `PePersonCandidatesPage.tsx` — native rebuilds of
  the canonical antd static segments at `/program-elements/mark-up-monitor`
  and `/program-elements/contacts` (both now claimed by `pe-routes.ts`).
- `pe-primitives.tsx` — EvMark/Segmented/FilterControl (+ the CapiroSkeleton
  loading block). Phase 4: these are now thin adapters over
  `vnext/components/**` (CapiroBadge / CapiroSelect / CapiroSkeleton) with
  unchanged props, not hand-rolled widgets.
- `profile/` — the five-tab line profile (`PeProfileVNext`), native port of
  `pages/program-element/ProgramElementV2ProfilePage.tsx` + the
  `v2/PeV2*Tab` components (PE-PROFILE tranche): header/snapshot/trust
  bands, Overview · Funding & lifecycle · Legislative · Program structure ·
  Sources & proof tabs, source-inspector drawer (CapiroDrawer), data-issue
  modal (CapiroModal). The view-model is the UI-free extraction
  `pages/program-element/useProgramElementProfileFinalCore.ts` (the canonical
  `useProgramElementProfileFinal.ts` is a thin wrapper over it), so both
  surfaces share one implementation of every endpoint/query key/derivation.
  `profile/pe-profile.css` owns all profile-only styling.
- `pe-workspace.css` — structural layer for the workspace and the two static
  segments. **Phase 4 rebuilt it**: the DS-v2 widget vocabulary the Phase 3 port
  copied class-for-class from the canonical `pe-v2.css` (grid, row, cell, seg,
  filter popover, ev-chip, cls-chip, btn, selbar-btn) is gone — those are
  `vnext/components/**` primitives now. What is left is layout only, on
  `var(--capiro-*)` tokens (the `--pev2-*` names survive as ALIASES onto the
  canonical semantic tokens, the same pattern `profile/pe-profile.css` uses with
  `--pepf-*`). `pe-vnext.css` remains the token re-skin + responsive layer on
  top, minus the three workspace-only structural fixes Phase 4 made obsolete
  (see the REMOVED IN PHASE 4 notes in that file).

  Height contract: no `flex: 1` / `height: 100%` pane and no vertically
  scrolling table body anywhere in this module's workspace — the catalog scrolls
  HORIZONTALLY inside `CapiroTableWrap` and grows the page vertically, which is
  what Phase 3 lesson #1 requires of a shell that scrolls the page.
- UI-free logic is consumed directly from the legacy tree:
  `pages/program-element/{api,types,funding-model,pe-shared-model}.ts`,
  `pages/program-element/v2/pe-v2-model.ts`, `pages/actions/actions-api.ts`,
  `pages/clients/relevance-api.ts`. `pe-shared-model.ts` is the extraction
  from the antd-coupled `pe-shared.tsx` (which re-exports it unchanged).

## Still canonical (sibling swap contract)

- Non-internal tenants' `/program-elements` and `/program-elements/:peCode`
  lazy-mount `ProgramElementFinderPage`/`ProgramElementWatchPage` — the
  **PE-FALLBACK** agent replaces them and deletes both TEMP edges. These
  branches render WITHOUT the `.pe-vnext-root` wrapper so their layout matches
  the pre-Phase-3 `<Outlet/>` fallthrough exactly.
- `/program-elements/reconciliation` is reserved and NOT claimed.
