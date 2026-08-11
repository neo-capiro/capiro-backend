# Directory vNext — handover

**Branch:** `agent/directory-vnext` · **Worktree:** `C:\dev\capiro-directory-vnext-wt`
**Forked from:** `main` @ `1c75effc` (PR #907, which merged the vNext surface into `main`)
**State:** committed at `02b716f0`. Typecheck clean (0 errors). Tests **91 pass / 0 fail**
(baseline before this work was **59**) — re-verified independently before that commit, not
carried over as a claim.

**Source of truth:** Figma `2aa9ipR2qOfumaixZErCfU`, Directory root `934:2502`,
contract frame `941:2860`.

---

## 1. How to actually see it

The Directory vNext screen only renders on the **vNext surface**. `App.tsx` picks the
surface inside the `BillingGate` layout route:

```
BillingGate → (isVNextSurface ? <VNextApp/> : <AppShell/>)
VNextApp → .capiro-vnext-root → VNextShellScaffold → VNextRouter → <Outlet/>
```

`isVNextSurface` comes from `resolveWebPresentation(runtimeConfig.webSurface)` —
`webSurface: 'vnext'` is injected by the container entrypoint from `WEB_SURFACE=vnext`.
Locally you must make `/runtime-config.js` report `webSurface: 'vnext'`; otherwise you get
the canonical `AppShell` and the legacy `DirectoryPage`, and it will look like nothing
happened. **That is the single most likely reason "it doesn't display."**

Verified wiring (read, not assumed):

| Concern | Status |
| --- | --- |
| `.capiro-vnext-root` wrapper (all Directory CSS is scoped to it) | applied in `VNextApp.tsx` |
| 44px context bar on `/directory/*` → working surface at y=108 | yes — `isClientContextEnabledForPath` returns `true` for everything but `/` |
| `.capiro-vnext-content` padding fighting the full-bleed 112px header | none: it is only `grid-area/min-*/overflow:auto/bg` |
| Body can grow / scroll (no fixture clipping) | yes — content region is `overflow: auto` |
| Sidebar Directory flyout links | yes — `routeManifest` gaps closed; asserted in `shell-contract.test.tsx` |

**Why routes are registered in BOTH places:** `VNextRouter` returns the vNext screen
*before* `<Outlet/>`, so the vNext surface would work without an `App.tsx` route — but the
canonical surface would 404. Both are registered on purpose. Keep it that way.

---

## 2. What is built

- **Routes** — four list routes in `App.tsx` (~line 430); `/directory` → Congressional
  Staff preserving the query string; `routeManifest` gaps closed + `state-legislators`
  added; `nav-content.ts` description added.
- **`vnext/components/identity/`** — `IdentityMark`. Circular for `person`, rounded-rect
  for `office`/`committee`/`program`; sizes sm/md/lg (32/36/46); image → initials fallback;
  honorific-aware initials; absent metadata renders `—`.
- **`vnext/components/navigation/TopNavItem.tsx`** — `CapiroTopNavItem`, i.e.
  `Navigation/TopItem` (`432:133`): 34px tall, 12px padding-x, shell-control radius.
  **This is NOT the sidebar rail item** even though Code Connect maps the tabs to
  `CapiroNavItem`; the rail item has a 32px icon slot and 44px height that break tab
  geometry. Renders a `NavLink`, so tabs are real routes with focus + current state.
- **`vnext/pages/directory/`** — `directory-routes.ts` (single source of truth for paths,
  tabs and profile URLs), `DirectoryShell.tsx` (112px header + 4px accent rail + metrics,
  40px tab band, 1320 inner width), `DirectoryFilterPill.tsx`, `directory.css`,
  `CongressionalStaffVNext.tsx`.
- **Tokens added to `foundations/tokens.css`** (all were genuinely missing):
  `--capiro-radius-circular`, `--capiro-color-icon-accent`,
  `--capiro-color-shell-nav-hover-bg`, `--capiro-color-shell-nav-disabled`,
  `--capiro-navigation-top-item-height/-padding-x`, and `--capiro-primitive-warm-paper`.

### Congressional Staff (`937:2539`) geometry as implemented

Header 112 · eyebrow mono 10/14 +0.6px at (24,18) · title Hanken SemiBold 32/38
tracking −0.48px at (24,38) · subtitle mono 12/17 at (24,78) · accent rail 4×112 ·
metrics 3×(150×56) r9 gap 8 at top 24, right-aligned to the 24px gutter.
Tabs band 40 = 6 pad + 34 item, gap 8, px 24. Body px 24 / py 20, gap 10.
Search 460×40 r8. Filter pills r-circular, px12 py9. Results 930 + rail (flex) + 16 gutter.
Rows min-height 68, px14 py10, r9, grid `180px 210px 220px 180px 70px` gap 10 — the column
header and the rows share `.capiro-directory-row-grid` so they cannot drift.

---

## 3. Four premises in the brief that are false — do not re-plan without these

1. **`Hierarchy/Office`, `Hierarchy/Person`, `Identity/Mark` were never Code Connect–mapped
   and did not exist in code.** `get_code_connect_map` on `937:2539` *and* `938:2628`
   returns only `CapiroContextBar`, `GlobalSearch`, `CapiroButton`, `CapiroNavItem`,
   `CapiroBadge`. So "reuse the mapped components, create no duplicates" held for 5 of 8.
   `Identity/Mark` is a real DS `component_set` (kind + size axes, editable
   initials/name/metadata) and is now built. **The two Hierarchy components were left
   deliberately** — their canonical geometry exists only inside `938:2628`, and the brief
   itself says not to hard-code the fixture's ~0.79-scale numbers, so building them before
   reading that node would mean inventing design.
2. **`agent/directory-three-tab-split` already did routes + tabs + a shell submenu, and is
   stale and unmerged.** It forked before vNext landed (0 `src/vnext` files) and targets the
   old `AppShellV2`, so its shell and `DirectoryPage` edits are superseded — but it chose
   the *same* route paths. Don't merge it blindly; don't treat it as unrelated either.
3. **`--capiro-radius-card` is not a real token.** Card radius is `--capiro-radius-widget`
   (12px). Figma's `radius/control` is `--capiro-radius-control` (8px).
4. **Role and Committee cannot be filtered server-side.** `/api/directory/staffers` accepts
   only `q`, `chamber`, `state`, `issue`, `page`, `pageSize` (`directory.controller.ts:71`).
   Both pills currently render an honest "not filterable yet" note. Client-side filtering
   would be wrong: the endpoint is paginated, so it would filter one page and report a
   wrong total. **← open decision for Neo (§6).**

Filter *values* come from `availableFilters` on `/api/directory/contacts` — the field is
**`availableFilters`, not `facets`** (that mistake cost a typecheck cycle).

---

## 4. Data mapping that is already verified

`DirectoryStaffer` (from `/api/directory/staffers`) covers the row completely:
Staffer = `fullName`/`title` · Office = `member.{memberName,chamber,state,district}` +
`officeLocation` · Coverage = `issueAreas` + `roles` · Contact = `email`/`phone`.

**Committee and provenance are NOT on the list row** — they come from `getStaffDetail`, so
the selection rail fetches them per selected person. Guard `source` with `?.`:
`detail.data?.source.snapshotId` crashed the first draft, and a payload without `source` is
exactly the required "provenance missing" state.

Figma's fixtures carry prototype labels ("6 SAMPLE RECORDS · LAYOUT FIXTURE", "· sample")
and a **blank COVERAGE column header** — none of that ships; the header is labelled
COVERAGE to match the row content and the written spec.

---

## 5. Remaining work, in the order I'd do it

1. **Make it visually QA-able (do this first — it de-risks everything after).**
   `pnpm --filter @capiro/web visual:vnext:capture` is **already broken repo-wide** ("No
   Lighthouse screenshot data was available"), so review is manual in-browser today. The
   durable fix: split each screen into a data container + a pure `…View` (the pattern
   `DashboardVNextView` already uses), register it in the Clerk-free harness
   `src/vnext/testing/visual/VNextShellVisual.tsx` (`vnext-shell.html`), then capture at
   1600×1000 with fonts loaded and overlay against each Figma node at 50%.
   **No pixel claim has been made for anything yet.**
2. **Department of War** (`939:2736`) — search 500×40; filters PE Alignment / Service /
   Role / Organization; results 960 + inspector 344 + 16 gutter; columns
   145/160/205/75/195/60; PE-first sort stays default; **inspector must scroll internally**
   (the fixture holds more than its 576px panel). Reuse `AcquisitionPersonnel` +
   Program Element identities — `getAcquisitionPersonnel`/`…Detail` in
   `pages/program-element/api.ts`, already used by `DowDirectoryResults.tsx`.
3. **State Legislators** (`944:2867`) — 3-column grid, cards ~432, 12px gutters; stat values
   must hug content with `white-space: nowrap` (fixes the Figma wrap bug); **null bill/enacted
   counts render `—`, never `0`**. Data: `/api/explorer/state-legislators` +
   `/api/explorer/state-legislator-facets`.
4. **Committee Staff** (`938:2628`) — the big one. Read the node first to get canonical
   `Hierarchy/Office` / `Hierarchy/Person` geometry, build those two as shared
   `vnext/components`, then render at canonical size and **scale the canvas** rather than
   hard-coding fractional node sizes. Solid edge = verified office structure, dashed =
   working/bipartisan; never infer an edge from proximity. Canvas 1020 + inspector 284 +
   16; inspector scrolls internally. Roster is `?view=roster` (canonical, per `1269:3777`)
   — **there is no Roster reference frame in Figma**, so it cannot be called pixel-perfect
   until one exists; say so rather than inventing one.
5. **Four profile screens** (`945:2922`, `946:2947`, `947:2973`, `948:2998`) — main 900 +
   rail 404 + 16; content-driven heights, sticky desktop rail, nothing clipped. Ignore the
   fixture's 700px content height.
6. **`/directory/department-of-war/:personId`** — deliberately NOT registered yet. I chose
   not to ship a stub that reads as done; land it with the DoW profile screen (step 5).

### Two known rough edges

- On the canonical surface (and on vNext for the three un-built screens), the new list
  routes all render the legacy `DirectoryPage`, which **defaults to its Members tab** —
  `mode` is `useState('members')` and I did not wire route→tab. Cosmetically odd, not a
  regression (the routes didn't exist before). One small change in `DirectoryPage.tsx`
  would derive the initial `mode` from `useLocation().pathname`.
- `--capiro-primitive-warm-paper` (#f5f0e3) is recorded as the Figma sidebar surface but
  **deliberately not wired** to `--capiro-color-bg-sidebar` (#f3f6fa). Repointing it would
  reskin Dashboard/LegiWatch/Strategies and is not covered by the shell regression tests.
  The Figma screens also put `--capiro-color-text-inverse-secondary` (#e1e6ed) on that warm
  paper for the "NAVIGATION" label, which is a contrast defect in the source. Needs a
  deliberate, regression-tested decision — not a Directory-local hack.

---

## 6. Decision from Neo — DECIDED 2026-08-11: option (b)

**Role + Committee filters on Congressional Staff.** Neo chose **(b): add `role` and
`committee` params to the staffers service/repository** — real server-side filtering, not
the honest-placeholder state.

Rule 19 restricts backend work to a *proven* missing field; that test is met here, and the
proof is specific: the underlying data exists but the query params do not. `roles` is on
every `DirectoryStaffer` row already. **Committee is the harder half — it is NOT on the list
row**; it comes from `getStaffDetail`, so filtering by it needs a repository-level join, not
a param passed through to the existing query. Do not assume the two params are symmetrical
work.

Implementation notes for whoever picks this up:
- `/api/directory/staffers` currently accepts only `q`, `chamber`, `state`, `issue`, `page`,
  `pageSize` (`directory.controller.ts:71`). Extend controller → service → repository.
- Keep pagination correct: filter in the query, never post-filter a page, or the total is
  wrong. That is the exact failure the placeholder state was avoiding.
- `CongressionalStaffVNext.test.tsx` currently asserts **"Role/Committee never send a bogus
  param."** That test encodes the *old* decision and will need to be inverted deliberately —
  it is a premise change, not a broken test. Update it, don't delete it.
- Filter *values* come from `availableFilters` on `/api/directory/contacts` — the field is
  **`availableFilters`, not `facets`**.

Not done in this session (session scope was: commit + make it visually QA-able).

---

## 7. Test inventory

| File | Covers |
| --- | --- |
| `vnext/pages/directory/directory-routes.test.ts` (9) | four routes, tab order, legacy redirect **with query string preserved**, profile URL preservation, slash-id encoding, list-vs-profile path collision, manifest has no gaps |
| `vnext/pages/directory/CongressionalStaffVNext.test.tsx` (17) | row columns from the real contract, loading, error + retry, empty vs no-results-after-filter, missing email/phone, pagination, debounced search + clear, filter open/select/apply/clear, Escape closes + focus returns, Role/Committee never send a bogus param, row keyboard + selection, rail empty state, Open full profile navigation, clipboard success **and** denial, four peer tabs with current marked, no duplicate identity |
| `vnext/components/identity/identity.test.tsx` (5) | initials incl. honorifics, person vs non-person geometry, image→initials fallback, unknown metadata, accessible-name behaviour |

Two pre-existing tests were **updated, not deleted**, because this change intentionally
falsified their premise (they asserted the Directory routes were still gaps):
`foundation-contract.test.ts` and `shell-contract.test.tsx`. The unavailable-destination
mechanism keeps its own coverage via a synthetic gapped route, and `directory.css` was added
to both CSS contract lists (it already complies: scoped, zero raw hex).

**Re-run:**
```bash
cd C:/dev/capiro-directory-vnext-wt/apps/web && npx vitest run --poolOptions.threads.singleThread src/pages/directory src/vnext
```

Note: `pnpm lint` is unconfigured in this repo (no `eslint.config.*`, no `.eslintrc`, no
local eslint binary) — typecheck + vitest are the real gates.
