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
- `pe-primitives.tsx` — native EvMark/Segmented/FilterControl (+ the
  CapiroSkeleton loading block).
- `pe-workspace.css` — structural layer (workspace subset of the canonical
  `pe-v2.css`, class contract identical). `pe-vnext.css` remains the token
  re-skin + responsive layer on top and also serves the canonical profile
  mount.
- UI-free logic is consumed directly from the legacy tree:
  `pages/program-element/{api,types,funding-model,pe-shared-model}.ts`,
  `pages/program-element/v2/pe-v2-model.ts`, `pages/actions/actions-api.ts`,
  `pages/clients/relevance-api.ts`. `pe-shared-model.ts` is the extraction
  from the antd-coupled `pe-shared.tsx` (which re-exports it unchanged).

## Still canonical (sibling swap contract)

- `/program-elements/:peCode` for capiro-internal lazy-mounts
  `ProgramElementV2ProfilePage` — the **PE-PROFILE** agent replaces it and
  deletes its edge in `no-legacy-ui.contract.test.ts`.
- Non-internal tenants' `/program-elements` and `/program-elements/:peCode`
  lazy-mount `ProgramElementFinderPage`/`ProgramElementWatchPage` — the
  **PE-FALLBACK** agent replaces them and deletes both TEMP edges. These
  branches render WITHOUT the `.pe-vnext-root` wrapper so their layout matches
  the pre-Phase-3 `<Outlet/>` fallthrough exactly.
- `/program-elements/reconciliation` is reserved and NOT claimed.
