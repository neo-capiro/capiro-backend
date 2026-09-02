# Hill Day Workspace v2 — implementation plan

Source of truth: `C:\Users\neoma\Downloads\Capiro Workspace V2 - Hill Day.html`
(dc-runtime bundle, extracted to `C:\dev\cap-hillday-proto\`):
- `hill-day.template.html` — full markup + CSS (3 style blocks) + dc app script
- `hill-day.dcscript.js` — state machine + renderVals (all copy/data)
- `hill-day.markup.html` — pure markup (78KB) — THE visual spec
- `engagement-icons.js` — 98 Untitled UI icons (source for new icon additions)
- `fig-tokens.css` — the Figma Variables export (the "Capiro tokens in figma")

## What we build

Three routes under `/workspace`, all inside the existing vNext app shell
(navy rail via AppShellUui, NOT a forked nav — the prototype's header/rail is
already the app shell; we keep the shell and build only the page content):

| Route | Screen |
|---|---|
| `/workspace/documents` | Library — blueprint cards, recent docs table |
| `/workspace/documents/new` | 6-step wizard (Template → Sponsor → Meetings → Resolution → Context → Generate) |
| `/workspace/documents/:id` | Editor — outline, paper canvas, quality+sources inspector |

All new code under `apps/web/src/vnext/pages/workspace/hillday/`.

## Binding rules (from the requirements)

- No raw hex/rgb/rgba in markup or style attributes — Tailwind classes backed
  by tokens. `foundation-contract.test.ts` scans component CSS for literals;
  keep palette values ONLY in the token file (`hillday-tokens.css` header block
  or extensions to workspace.css token layer).
- Tokens: the prototype's own values map to the existing `--ws-*` vNext
  workspace tokens (which already carry `#294e68` navy, `#101828` ink, gray
  ramp). We extend `hillday-tokens.css` with the few missing ones
  (`--ws-cal-*` etc.). NO new primitive library.
- Screens ≤ 1179px: step rail → numbered pips + compact chip; editor
  inspector drops. ≤ 779px: single column. Wizard carry-over panel stacks
  below 1320px container width (live measure, per prototype `w>=1320`).
- Library/wizard/editor get data from the hillday API client
  (`api.ts`) — same fixture-backed hydration pattern as the prototype's
  `meetings()/directory()/threadData()` but typed, with the real endpoints
  named in the requirements §6 as the integration target. The wizard surface
  is a new build; the prototype fixtures define the shape (see §6 endpoints).

## File map

```
hillday/
  api.ts                 # typed client: /workspace/documents… endpoints (real paths)
  fixtures.ts            # prototype data verbatim (meetings, directory, threads)
  ui.tsx                 # shared primitives: WsButton, WsPill, WsIcon wrapper, Card
  icons.tsx              # Untitled UI icons missing from dashboard-icons (CalendarCheck01…)
  HillDayLibrary.tsx     # /workspace/documents
  HillDayWizard.tsx      # /workspace/documents/new (6 steps in one file, subcomponents)
  HillDayEditor.tsx      # /workspace/documents/:id
  hillday.css            # all component styles, var(--*) only
  hillday.contract.test.ts  # pins: no hex in css, routes wired, copy anchors
```

## CSS architecture

`hillday-tokens.css` declares the hillday palette as `--hd-*` custom
properties on `.ws-vnext-library, .ws-vnext-creation, .ws-vnext` roots (same
scope pattern as workspace.css). Every rule is scoped under
`.capiro-vnext-root` per the foundation contract. Class namespace: `.hd-`.

## Verification

1. `pnpm run typecheck` — zero errors matching hillday files
2. `npx vitest run src/vnext/pages/workspace/hillday` — contract test
3. `pnpm run build` — must not regress main's status (pitfall #28)
4. Visual capture via `vite --config vite.harness.config.ts` at
   1440/1180/900/760 widths (skill: vnext-ui-visual-verification)

## Prototype → route/nav mapping notes

The prototype renders its own 64px header + 232px navy rail. The production
app ALREADY has AppShellUui (navy rail "surface chrome", 64px topbar) — the
shell is the governed surface. We build ONLY the `<main>` content of the
prototype (library/flow/editor sections), inside the existing shell, exactly
as the workspace module already does. The prototype's in-page "Workspace /
Documents / Template Studio / Client shares" sub-nav maps to the shell's
existing Workspace nav family.

## Backend (shipped 2026-09-01)

The engine half lives in `apps/workspace/src/hillday/` and is mounted at
`/workspace-api/hillday/*` (the requirements' `/api/v1/...` families map 1:1):

| Concern | Where |
|---|---|
| Source layers (clients, meetings + attendees, mail threads, strategies, users, tenants) | `hillday-source.service.ts` — raw SQL under the tenant GUC, no fabricated fallbacks |
| Directory bridge (address → staffer → office → member) | `directory-bridge.client.ts` → apps/api `/api/internal/directory/*` (InternalServiceGuard) |
| Resolution chain + user corrections (authoritative per document) | `resolution.rules.ts` (pure) + `hillday-resolution.service.ts` |
| Carry-over defaults (server-supplied `defaultSelected`) + notes + correspondence window | `hillday-context.service.ts` |
| Generation job, SSE event log, prompt assembly honouring the carry selection, logged source set | `hillday-generation.service.ts` + `generation-prompt.ts` |
| Assembled document model, library, quality checks | `hillday-document.service.ts` |
| Server-rendered PDF (Letter/A4, facts grid never split) behind an HMAC-signed URL | `hillday-export.service.ts` |

`api.ts` on this side is now the real client (`useHillDayApi()`); `fixtures.ts`
holds static UI copy only. SSE progress is consumed with `fetch` (EventSource
cannot carry the Clerk bearer) and falls back to polling the sibling route.
