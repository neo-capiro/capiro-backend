# Portfolio UI handoff — 2026-08-15

## Status

Portfolio index implementation is present in the local worktree on branch `agent/portfolio-ui-exact`.

No commit was created and no deployment was performed.

Worktree status at handoff:

- Modified `GAPS.md`
- Modified `apps/web/src/vnext/pages/portfolio/PortfolioIndexPage.test.tsx`
- Modified `apps/web/src/vnext/pages/portfolio/PortfolioIndexPage.tsx`
- Modified `apps/web/src/vnext/pages/portfolio/PortfolioProgramElements.tsx`
- Modified `apps/web/src/vnext/pages/portfolio/portfolio.css`
- Modified `apps/web/src/vnext/pages/portfolio/usePortfolioIndexModel.ts`

## Objective

Implement the supplied offline Portfolio prototype in the vNext UI served by `os.capiro.ai`, while reusing existing Capiro routes, API contracts, design tokens, client CRM behavior, and backend mutation flows.

Primary visual source:

- `C:\Users\neoma\Downloads\Capiro Portfolio (offline).html`

Primary build specification:

- `C:\Users\neoma\Downloads\PORTFOLIO-UI-BUILD-SPEC.md`

Prior handoff reference:

- `C:\Users\neoma\Downloads\PORTFOLIO-HANDOFF.md`

## Architecture and route seam

The vNext surface is not a separate `apps/web-next` package. It lives inside `apps/web/src/vnext/` and is selected by the `webSurface === 'vnext'` runtime setting.

The Portfolio route is:

- `/clients` with no `clientId` → `PortfolioIndexPage`
- `/clients?clientId=<id>` → existing `ClientCrmPage`

Relevant route files:

- `apps/web/src/vnext/app/VNextRouter.tsx`
- `apps/web/src/vnext/pages/client-crm/VNextClientCrmRoute.tsx`
- `apps/web/src/vnext/pages/portfolio/portfolio-routing.ts`

The deploy target for this surface is the existing `capiro-dev-web-vnext` service serving `os.capiro.ai`. This handoff intentionally does not deploy it.

## Files changed

### `PortfolioIndexPage.tsx`

- Preserves the Portfolio header, pulse band, client list, list/card toggle, filtering, sorting, empty/error/loading states, LDA import entry point, and client navigation.
- Preserves the prototype's seven-column client table geometry:
  Client, Focus, Owner, Work, Intelligence, Attention, Next touch.
- Missing portfolio rollup values remain `—` rather than fabricated zeros.
- Card layout now follows the prototype's richer structure: identity/status, focus chips, unavailable work/readiness slot, and footer owner/next-touch slot.
- Refresh invalidates clients, portfolio summary, strategies, meetings, and watched program-element queries.

### `usePortfolioIndexModel.ts`

- Uses existing client, intelligence summary, strategies, meetings, and program-element API/domain contracts.
- Active strategy and current-week meeting pulse figures are composed from existing tenant-wide endpoints rather than invented data or per-client fan-out.
- Attention sorting falls back to name while the portfolio aggregate is unavailable.

### `PortfolioProgramElements.tsx`

- Uses the existing watched program-element endpoint and links to the existing program-element detail route.
- Uses PB → Auth → Approp labels with em-dash separators as specified by the prototype.
- Missing cross-client attribution is explicitly labeled unavailable.
- Missing portfolio net delta renders `— net`.

### `portfolio.css`

- Keeps the vNext token system and adds prototype-oriented geometry for the page header, pulse band, table column rhythm, card layout, program-element cards, and responsive behavior.
- The clients table remains horizontally scrollable with a 1240px minimum width.
- Program-element cards use the prototype code-chip and two-column card geometry.

### `PortfolioIndexPage.test.tsx`

The focused tests cover:

- populated live-data rendering
- pulse labels
- status classification
- search filtering and filtered-empty state
- status filtering
- name sorting
- client-source error state and retry
- Import with LDA dialog opening
- deep-link Import with LDA dialog

## Existing backend wiring

The following behavior is connected to existing backend components:

- Client list: `GET /api/clients`
- Portfolio summary: `GET /api/intelligence/portfolio-summary`
- Active strategies pulse source: `GET /strategy-api/strategies`
- Current-week meetings pulse source: `GET /api/engagement/meetings`
- Watched program elements: `GET /api/programs` / existing `getProgramElementsList` helper with watched filtering
- Program-element detail navigation: existing program-element route
- Import with LDA lookup/review/apply:
  - `GET /api/firm/lda-registrants`
  - `GET /api/firm/import-candidates`
  - `POST /api/firm/import`
- Client profile navigation: `/clients?clientId=<id>` and existing Client CRM
- Existing CRM Work projection: `GET /strategy-api/strategies`
- Existing CRM and Meri mutation flows remain owned by their existing components; no parallel Portfolio mutation API was introduced.

## Explicit backend gaps / honest UI states

### G1 — Portfolio summary does not contain all five pulse values

`/api/intelligence/portfolio-summary` does not return active-strategy or current-week-meeting counts. The UI composes those two values from existing tenant-wide endpoints without firing per-client requests.

A future backend improvement would add both counts to the portfolio summary response for one consistent aggregate and refresh boundary.

### G2 — Program-element client attribution and net portfolio delta

The existing watched program-element response provides per-PE budget figures and per-PE deltas, but no portfolio-scoped join to client attribution and no summed net delta.

The UI therefore:

- renders real PB/Auth/Approp values and per-PE delta when available;
- renders `Client attribution unavailable` for the footer;
- renders `— net` in the section header;
- does not synthesize client names, dollar values, or net totals.

### G3 — Per-client Work/Intelligence/Attention/Next-touch aggregate

The prototype expects portfolio-wide row data for strategy count/readiness, intelligence counts, attention count, and next touch. Existing endpoints are client-scoped. Assembling them per row would violate the prototype's no-N+1 contract.

The table preserves the designed columns but renders `—` in unavailable cells. A future portfolio-scoped rollup endpoint is required for populated values.

## Verification

Passed:

- Focused Portfolio Vitest: 19 tests passed across 2 files.
- Web TypeScript typecheck: passed with 0 errors.
- Web production build: passed.
- `git diff --check`: passed.

The production build emitted the existing non-fatal Vite warning about large chunks.

Not completed:

- `pnpm run lint` could not execute because the worktree environment does not resolve the `eslint` executable:

  `'eslint' is not recognized as an internal or external command`

- A full `pnpm run test` was attempted but the Vitest worker exited unexpectedly after substantial suite output. The focused Portfolio tests and typecheck/build remained green. The full-suite interruption was not treated as a Portfolio assertion failure.

## Relevant Markdown references

Primary product/design references:

- `C:\Users\neoma\Downloads\PORTFOLIO-UI-BUILD-SPEC.md` — detailed visual, layout, interaction, responsive, route, and backend binding contract.
- `C:\Users\neoma\Downloads\PORTFOLIO-HANDOFF.md` — original Portfolio handoff and scope/context.
- `C:\Users\neoma\Downloads\Capiro Portfolio (offline).html` — visual prototype; not Markdown, but the source of visual comparison.

Repository handoff and backend references:

- `C:\c\dev\capiro-portfolio-ui\docs\handoff\portfolio-api-inventory.md` — endpoint-by-endpoint inventory followed to server controllers, auth, query keys, and known gaps.
- `C:\c\dev\capiro-portfolio-ui\GAPS.md` — confirmed backend gaps, evidence, shipped fallback behavior, and explicitly checked non-gaps.
- `C:\c\dev\capiro-portfolio-ui\docs\handoff\PORTFOLIO-UI-HANDOFF-2026-08-15.md` — this handoff.

Architecture and design-system references:

- `C:\c\dev\capiro-portfolio-ui\apps\web\src\vnext\foundations\tokens.css` — shared vNext tokens; do not replace with prototype hard-coded palette.
- `C:\c\dev\capiro-portfolio-ui\apps\web\src\vnext\foundations\responsive.css` — canonical responsive breakpoints and content gutters.
- `C:\c\dev\capiro-portfolio-ui\apps\web\src\vnext\app\VNextRouter.tsx` — vNext route interception.
- `C:\c\dev\capiro-portfolio-ui\apps\web\src\vnext\pages\client-crm\VNextClientCrmRoute.tsx` — `/clients` index/profile seam.
- `C:\c\dev\capiro-portfolio-ui\apps\web\src\vnext\pages\client-crm\client-crm-routing.ts` — existing CRM query-route behavior and legacy deep-link mapping.

Skill/reference Markdown consulted for this implementation:

- `C:\Users\neoma\AppData\Local\hermes\skills\software-development\capiro-pe-ui-prototype\SKILL.md`
- `C:\Users\neoma\AppData\Local\hermes\skills\software-development\capiro-pe-ui-prototype\references\vnext-portfolio-surface-map.md`
- `C:\Users\neoma\AppData\Local\hermes\skills\software-development\capiro-pe-ui-prototype\references\portfolio-index-vnext-map.md`
- `C:\Users\neoma\AppData\Local\hermes\skills\software-development\capiro-pe-ui-prototype\references\pe-prototype-fidelity.md`
- `C:\Users\neoma\AppData\Local\hermes\skills\software-development\capiro-pe-ui-prototype\references\appshell-v2-condensed-spec.md`
- `C:\Users\neoma\AppData\Local\hermes\skills\software-development\browser-automation-testing\SKILL.md`
- `C:\Users\neoma\AppData\Local\hermes\skills\software-development\test-driven-development\SKILL.md`

## Next recommended steps

1. Review the six modified source files against the offline prototype at desktop, tablet, and mobile widths.
2. Verify authenticated `/clients` and `/clients?clientId=<id>` behavior on `os.capiro.ai` or a local vNext session.
3. Resolve the environment's missing ESLint executable and rerun `pnpm run lint`.
4. If product sign-off requires populated G2/G3 values, add backend aggregate endpoints before changing the honest `—` states.
5. Run the full test suite in a stable single-threaded or otherwise resource-safe environment, then separately verify the focused Portfolio tests again.
6. Only after review and sign-off should a commit, merge, or deployment be considered. Merging must not be treated as deployment.

## Credential and deployment note

No credentials are included in this document. No commit, merge, ECS rollout, or deployment was performed.
