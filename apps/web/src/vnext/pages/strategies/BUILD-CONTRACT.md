# Strategies vNext — shared build contract (read before writing any component)

This file is the single source every Strategies subagent builds against. It fixes the
conventions so independently-built screens compose without rework. Authoritative product
rules: `STRATEGIES-HANDOFF.md` (§5 foundations, §6 routes, §7 screen contracts, §8 domain,
§9 cross-cutting, §11 governance). Where this file and the handoff disagree, the handoff wins.

## Hard rules (governance — §1, §11; violations are release blockers)
1. NO AUTO-APPLY. No code path applies an agent operation without an explicit human click.
2. Approve ≠ apply — two distinct mutations (`…/approve` with `opIndexes`, then `…/apply`).
3. Apply operates on the SELECTED operation subset only; it yields exactly one revision.
4. Apply sends the change-set id; a 409 means the base revision moved → surface the
   "this plan changed elsewhere / regenerate" state, never overwrite.
5. Every applied set is undoable via `…/undo` (creates a NEW revision, never rewinds).
6. No UI edits source documents, fact values, steward decisions, or revisions. No deletes.
7. Execution STAGES only. Render NO send control. The Stage-H security card is not decorative.
8. Never render missing/failed/stale data as `0` or hide the panel — render an explicit state.

## Imports allowed (and ONLY these for data/contract)
- HTTP client: `useApi` from `../../../../../../lib/use-api.js` (note: 6 levels up from a
  file at `vnext/pages/strategies/<sub>/<file>.tsx`; from a file directly in
  `vnext/pages/strategies/` it is `../../../../../lib/use-api.js`). VERIFY depth with `ls`.
- Domain types: `import type { … } from '<depth>/pages/strategy/types.js'` (5 levels from a
  subdir file → `../../../pages/strategy/types.js`; 4 levels from a top-level module file).
- Normalizers: `pages/strategy/agents/agent-utils.js`, `pages/strategy/context/context-utils.js`.
- Data hooks: reuse `../strategies-api.js` (already written) before writing a new fetcher.
  Add new hooks there following the same pattern. Query keys ALWAYS in `['strategy', …]`.
- UI primitives: `../../components/{actions,badges,fields,menus,overlays,tables,feedback,icons}/index.js`
  (CapiroButton, CapiroBadge, CapiroInput, CapiroSelect, CapiroTabs, CapiroModal, CapiroDrawer,
  CapiroTable*, CapiroEmptyState, CapiroSkeleton, CapiroErrorState, Capiro*Icon).
- `useMe` from `<depth>/lib/me.js` for feature flags (`strategyPlanner`, `agenticMeri`).

## FORBIDDEN imports
- NO old strategy components: never `pages/strategy/StrategyEditorPage`, `ReviewQueue`,
  `ExecutionReview`, `StewardReview`, `ContextLibrary`, `ContextDocumentView`, `StrategyTimeline`,
  `StrategyLibraryPage`, or any old `.tsx` component. (Types and normalizers are fine.)
- NO `pages/strategy/strategy-ds.css` (the old prototype stylesheet). All styling is new CSS
  under `vnext/pages/strategies/` using the token layer.
- NO Tailwind, NO hex literals in component files — reference `var(--st-*)` / `var(--capiro-*)`.

## Styling
- Import `../strategies-tokens.css` once at the module root (already imported by the router).
- Write component CSS in a sibling `.css` file scoped under `.capiro-strategies`.
- Accent is Capiro navy: `var(--st-accent)` `#294E68`. Buttons use CapiroButton.
- Monospace ONLY via the `.st-mono` class and ONLY for §5.1 identifiers (template keys,
  filenames, line refs like `L41–42`, hashes, op/run state tokens, confidence `0.98`, `v3`).
  Page titles, labels, buttons, badges are the sans family. If a copywriter could reword it,
  it is not monospace.
- Every status pill carries a dot AND a text label (never colour-only).

## Routes (§6) — every tab/filter/overlay is a URL; back/forward must work
```
/strategies                                  library
/strategies/new                              New-strategy overlay over library
/strategies/phases                           Firm-phases overlay
/strategies/:strategyId                      timeline editor
/strategies/:strategyId?step=:stepId         editor + step inspector open
/strategies/:strategyId?step=:stepId&tab=meri  inspector on Meri tab
/strategies/:strategyId/history              History overlay over editor
/strategies/:strategyId/export               Export overlay over editor
/strategies/context                          context library
/strategies/context/upload                   Upload overlay over context library
/strategies/context/:documentId              context document viewer
/strategies/context/steward                  steward review
/strategies/context/steward/:conflictId      Resolve-conflict overlay
/strategies/agents/proposals                 agent review queue
/strategies/agents/runs                      execution runs
```
Closing an overlay returns to its caller route. Overlays render their caller beneath.

## Async states (§9.1) — required on EVERY query surface
Loading (skeleton in the panel's shape) · Empty (meaning + next action) · Error (what failed,
last-success, Retry) · Stale (last-successful ts + marker, keep data visible) · Forbidden
(explicit no-access state). A panel NEVER disappears because a source failed. Use
CapiroSkeleton / CapiroEmptyState / CapiroErrorState primitives.

## Plan health (§8.7) — NO server scalar exists (GAP).
Use the adapter `../lib/plan-health.js` `computePlanHealth(detail)` which implements
coverage/grounding/timeliness and returns null while the plan is partially loaded.
Never show a number from a partial plan — show the loading state.

## Save stamp (§7.2)
Reflect real persistence: `Saved just now` / `Saving…` / `Unsaved changes` / `Save failed — retry`.
Never show "Saved" optimistically.

## Copy is product policy — do not reword
- Agent queue dark banner: "Human approval is the control plane." + `NO AUTO-APPLY`.
- Execution dark banner: "External send is disabled until security review (Stage H)." + `STAGE ONLY`.
- Run-state list: queued · planning · waiting · ready · approved · executing · completed ·
  recoverable · failed · canceled · superseded · staged_not_sent.
