# Dashboard vNext — implementation contract

Canonical Figma: page `748:2502`, desktop expanded `751:2502`, collapsed `753:2532`,
customize `754:2562`, system-state gallery `754:2885`, tablet `757:2528`, mobile `758:2528`.

Controller: `vnext/adapters/legacy/useDashboardVNextModel.ts` → `DashboardVNext`.
HomePage was **not** copied; its data model was adapted. Every query below reuses the canonical
endpoint *and* the canonical query key, so the vNext Dashboard shares one cache with the existing
surfaces rather than creating a second one.

## 1. Displayed data → existing owner

| Module | Existing query key | Endpoint |
| --- | --- | --- |
| Needs Attention | `['portfolio-alerts']` | `GET /api/intelligence/portfolio-alerts?limit=30` |
| Needs Attention | `['intel-changes-tracked']` | `GET /api/intelligence/changes?since=…` |
| News & Narrative | `['dashboard-news-custom', params]` | `GET /api/intelligence/news/dashboard` |
| Today & Coming Up | `['engagement-meetings-week', from, to]` | `GET /api/engagement/meetings` |
| Today & Coming Up | `['coming-up']` | `GET /api/intelligence/coming-up` |
| Work Queue | `['dashboard-work-outreach']` | `GET /api/engagement/outreach?limit=50` |
| Work Queue | `['dashboard-workspace-drafts']` | `GET /workspace-api/drafts?scope=all` |
| Header greeting | `useMe()` | `GET /api/me` |

`/api/intelligence/comment-alerts` is intentionally **not** consumed by this surface — see §2.

## 2. Needs Attention module contract

Implemented as the pure, tested `selectAttentionItems()`. Permanently pinned first and not hideable.

**Included** (allowlist — `ATTENTION_ALERT_TYPES`): `comment_deadline` (external deadlines),
`hearing` (hearings/preparation windows), `bill_movement` (time-sensitive legislative movement),
`contract_award` and `competitor_filing` (external developments); plus intelligence changes at
`critical`/`high` severity (material funding/regulatory movement); plus material source failures.

**Excluded**: `comment_overdue` (overdue comments), and every alert type outside the allowlist —
so generic internal reviews, assigned actions and CRM housekeeping cannot leak in even if the
server adds new types. Work Queue items are never duplicated here; Work Queue reads different
endpoints entirely.

A source failure (`provider_unavailable`, `not_configured`) is raised as an actionable row so
failed ingestion is never silently hidden. `no_clients` is a configuration state, not a failure.

## 3. Work Queue contract

Outreach drafts + workspace draft documents only, matching the existing `DashboardWorkQueue`
policy ("only work the team is actively producing"). Governance reviews and generated action
recommendations keep their own surfaces and are not shown.

## 4. Scope

Dashboard is always all-client. The controller reads no client filter and sends none; the shell
disables the context-bar client control on `/` (Figma `729:2612` `DASHBOARD · OFF`). Tested.

## 5. Customization

Reuses the existing per-user localStorage contract, unchanged:
`capiro:dashboard-visibility:{tenantId}:{userId}` and `capiro:dashboard-news:{tenantId}:{userId}`
(the latter via the now-exported `useNewsPreferences`). Density adds
`capiro:dashboard-density:{tenantId}:{userId}`. No new backend persistence was introduced.
Needs Attention is fixed and cannot be hidden.

## 6. System states

Every module reports `loading | ready | partial | stale | unavailable | empty | all-clear`.
A failed request resolves to `unavailable` (or `partial` when a sibling source succeeded) and
**never** to zero or empty — asserted in `dashboard-contract.test.ts`.

## 7. Not yet implemented

- Module **reordering** (Figma allows it "where supported"); visibility and density ship, order does not.
- The `754:2885` state gallery is implemented as live per-module states, not as a static gallery screen.
- Tablet/mobile breakpoints are implemented but have only been reviewed at desktop width.
