# App Shell vNext — implementation contract

Canonical Figma: page `721:2502`, expanded `722:2502`, collapsed `723:2530`, interaction states `725:2560`.

This file is the Phase 1 data/action mapping required before implementation. Every displayed value and
every action below resolves to an **existing** canonical query/mutation. Nothing here introduces a new
endpoint, query cache, or business rule.

## 1. Displayed data → existing owner

| Figma node | Displayed data | Existing owner | Endpoint |
| --- | --- | --- | --- |
| `722:2528` Profile Name | user first/last name | `useMe()` (`lib/me.ts`) | `GET /api/me` |
| `722:2529` Profile Role | user title, else tenant role | `useMe()` | `GET /api/me` |
| `722:2526` Avatar Initials | derived from `useMe()` name/email | `useMe()` | `GET /api/me` |
| `722:2523` Notifications Count | `unread` | `useNotifications()` (`pages/workspace/api.ts`) | `GET /workspace-api/notifications` |
| `819:2612` Mailbox Sync | connection state/provider/age | `useMailboxSyncStatus()` (already in vNext) | `GET /api/engagement/integrations` |
| `722:2590` Context / CLIENT | selected client + client list | `useClientFilter()` + clients query | `GET /api/clients` |
| `722:2510` Global Search | query results | canonical search surface (see §4) | — |
| Sidebar nav visibility | feature gates | `useIntelFeatureFlags()` + `useMe().features` | `GET /intel-api/feature-flags`, `GET /api/me` |
| `722:2504` Brand | static mark + environment label | runtime config `webSurface` | `/runtime-config.js` |

`722:2593` JURISDICTION and `722:2596` BUDGET YEAR are **not backed by an existing shell-level contract**.
See §5.

## 2. Actions → existing owner

| Action | Existing owner |
| --- | --- |
| Open Meri | `openMeriWorkspaceWindow()` (`components/chat/meri-window.ts`) |
| Nav navigation | `react-router` `NavLink` against routes registered in `App.tsx` |
| Select client context | `useClientFilter().setSelectedClientId` |
| Mailbox card click | route to `/settings/integrations` |
| Sign out | Clerk `useClerk().signOut` |
| Notifications open | route to the canonical notifications surface |

## 3. Interaction contract (Figma `730:2573`, verbatim)

| Key | Rule |
| --- | --- |
| MERI | Always visible on desktop; Ctrl+J opens its separate workspace window. |
| NOTIFICATIONS | Badge is count-only; details open in a dedicated surface. |
| OVERLAYS | Only one shell overlay may be open at a time. |
| DISMISSAL | Escape and outside click close; no destructive action fires. |
| FOCUS | Keyboard focus returns to the invoking control. |
| SCOPE | Search and context surfaces state all-client or selected-client scope. |

Client-context enablement per surface (Figma `729:2612`): `PORTFOLIO · ON`, `ENGAGEMENT · ON`,
`DASHBOARD · OFF`. This matches the written Dashboard rule (Dashboard is always all-client), so the
context bar's client control is disabled on Dashboard and persisted client context must not influence
Dashboard requests.

## 4. Global search

The Figma popover (`726:2569`) shows typed results with `Kind`, `Name`, `Meta` and a keyboard shortcut,
plus a footer stating scope. The canonical web app does not expose a single cross-entity search endpoint
that returns this shape. Phase 1 therefore ships the **control and popover mechanics** (open, Escape,
outside click, focus return, scope statement) and renders the honest not-enabled state for results
rather than fabricating a result set. See §5.

## 5. Documented backend gaps (no invented endpoints)

| Gap | Figma | Status |
| --- | --- | --- |
| Congressional Staff list | `820:2627` | No canonical list route; only `/directory/staff/:staffId` detail exists. |
| Committee Staff list | `820:2631` | No canonical list route; only `/directory/committees/:committeeId` exists. |
| Department of War list | `820:2635` | No canonical route at all. |
| Cross-entity global search | `726:2569` | No canonical aggregate search endpoint. |
| Context JURISDICTION | `722:2593` | No shell-level jurisdiction contract. |
| Context BUDGET YEAR | `722:2596` | No shell-level budget-year contract. |

Each renders the designed unavailable / not-enabled state behind the vNext shell flag. None of them
fabricates data, derives authoritative values from unrelated endpoints, or persists important state
only in `localStorage`.
