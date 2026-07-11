# Engagement · Meetings & Meri Redesign — Architecture Blueprint

**Status:** Ready for review. Architecture only — no code written against this plan yet.
**Inputs:** `Capiro - Engagement Meetings Spec v2.html` (product spec) + `Capiro - Engagement Meetings (Meri Redesign) - standalone.html` (working prototype, verified live in-browser) + full read of the current `apps/web`/`apps/api` Meetings, Notetaker, Client-Documents, and cross-cutting-conventions code.
**Scope decision (confirmed with Ninja):** Ship the full visual/UX redesign, Meri scheduling, single-owner private/shared sharing, Meeting Library, and the client-profile Documents integration now. Defer the cross-user calendar-identity rework that true multi-attendee collision (§7 of the spec) and multi-user concurrent notetakers (§4.4) require to an explicitly separate **Phase 2**. Phase 1's collision-model code is still built per spec — it is simply a no-op when a meeting has exactly one contributor, which is the only case Phase 1 can produce.

---

## 1 · What we're building, in one paragraph

Replace the current single-file, 4,625-line Meetings tab (`EngagementPage.tsx`) with a purpose-built Day/Month/List calendar surface, backed by a private-until-shared visibility model on the existing `Meeting`/`MeetingPrep`/`MeetingNote`/`MeetingDebrief` tables, a new Meeting Library page, and a new "shared from meetings" section on the client profile's existing Documents tab. The Meri notetaker gets advance scheduling (already half-built server-side) and per-sender bot naming. The existing **Join-meeting** feature is carried through — relocated to the detail-panel header and restyled per the prototype — and the **dashboard Home widget's Meri/Join buttons are restyled to match the new design** (both explicit Ninja requests; see §7a, §8a). Nothing here touches who can see a meeting today (single-owner) or lets two different users attend one meeting with two bots — that's Phase 2.

---

## 2 · Current-state findings that shape this plan

These are not assumptions — each was verified by reading the actual code (file:line references in each research pass; full agent transcripts available if needed).

| Area | Finding | Consequence for this plan |
|---|---|---|
| **View modes** | Three view modes already exist (`list`/`calendar`/`day` in `EngagementPage.tsx:387`), but "calendar" is a **7-column week grid**, not a month grid. No Month view exists anywhere. | Month is genuinely net-new. Week grid is replaced (spec explicitly supersedes it), not kept as a fourth option. |
| **Meeting Library** | Zero matches anywhere in the repo for "Meeting Library" / any archive-browsing meeting surface. | 100% net-new page + endpoint. |
| **Visibility** | No `visibility`/`shared`/`private` field exists on `Meeting`. Today's only access control is `ownMeetingWhere()` (`engagement.service.ts:5716`) — a meeting is visible **only** to whoever created it or owns the calendar connection that synced it. No admin bypass, no shared-calendar concept, applied at ~15+ call sites. | This is the single biggest structural fact governing scope. It's *why* the collision model (§7) can't be real without a foundational rework — see §4 below. Phase 1 leaves this predicate untouched. |
| **Contributors / multi-owner** | Not modeled at all. Every meeting/note/prep/debrief has exactly one `authorUserId`/`createdByUserId`. Attendees (`MeetingAttendee[]`) are invite-metadata only, not linked to internal user accounts. | Confirms Phase 1/Phase 2 split is correct — there is no existing seam to build multi-contributor logic on top of yet. |
| **Prep status** | `MeetingPrepStatus` enum already exists: `generated \| edited \| approved \| stale \| failed` (`schema.prisma:83`), plus a working approve endpoint (`POST meeting-preps/:id/approve`). | Matches the spec almost exactly. No schema change needed for Prep. |
| **Debrief status** | `MeetingDebrief` has **no status/approval field at all** — just encrypted body + `confidential`/`accessLevel`. No approve endpoint exists. | Real gap. Needs a new enum + column + endpoint (§5 below). |
| **Notes status** | Same — no status field. But the spec's own prototype data model (`meeting-data.jsx` comment, §9) lists `notesApproved` alongside `prepApproved`/`debriefApproved`. Spec's action table shows no "Approve" action for Notes (Notes are produced by Meri or entered manually and are final on creation). | Resolve by *not* adding a DB column — treat "notes approved" as "the row exists," and return `notesApproved: true` computed in the API response for frontend selector-parity. No unnecessary schema. |
| **Meri scheduling** | `joinAt` (ISO8601 "join later" time) is **already plumbed end-to-end**: DTO → service → provider → Recall's `join_at` field (`notetaker.service.ts:96`, `recall.provider.ts:91`). The frontend dispatch call simply never sends it (`EngagementPage.tsx:829-846`) and there's no date/time picker. | This is a **frontend-only** build for the scheduling UI. No backend work. |
| **Per-sender Meri naming** | Single hardcoded `DEFAULT_BOT_NAME = 'Meri Notetaker (recording)'` (`notetaker.service.ts:25`), sent unconditionally to Recall. `requestedByUserId` is already captured on `MeetingBotSession`. A separate plan doc (`docs/plans/meeting-notetaker-signed-in-bots.md:71-73`) already establishes a hard constraint: whatever name is used, it must keep the `(recording)` suffix and must never read as a plausible human. | Service-layer change only: derive the bot name from the requesting user at dispatch time (e.g. `"{firstName}'s Meri Notetaker (recording)"`). No schema change — `requestedByUserId` already gives us the "who." |
| **Concurrent notetakers** | Actively **blocked**: a `BadRequestException` fires if any non-terminal session already exists for a meeting (`notetaker.service.ts:277-284`). | Because Phase 1 keeps single-owner visibility, no second user can ever reach this meeting to trigger the conflict anyway — so this guard is correctly left alone in Phase 1. Revisit in Phase 2. |
| **Virtual/join-link detection** | 100% regex-over-freetext, independently duplicated between `apps/web/.../meeting-actions.tsx` and `apps/api/.../notetaker.service.ts` (`detectPlatform`), with an explicit in-code "MUST stay in lockstep" warning. Microsoft Graph's structured online-meeting fields (`isOnlineMeeting`, `onlineMeeting.joinUrl`) are never fetched — the sync client's `GraphEvent` interface doesn't request them. There is no stored `joinLink`/`provider`/`isVirtual` column on `Meeting` — it's recomputed from freetext on every render. | In scope for Phase 1: consolidate the duplicated regex into one shared utility, prefer Graph's structured fields when present, and **store** the result on `Meeting` at sync time. This directly implements the spec's own contract (`eligibleForMeri(m) = m.virtual && m.joinLink`, §4.1) as real columns instead of a re-derived side effect, and retires a known duplication risk already flagged in the code. |
| **Join affordance (existing feature)** | Not a standalone component — it's the first button in the shared `MeetingQuickActions` (`apps/web/src/pages/engagement/meeting-actions.tsx:131-139`): antd `<Button size="small" color="green" variant="solid">` with a `VideoCameraOutlined` icon. On click it runs `extractMeetingJoinUrl(meeting)` and `window.open(url,'_blank','noopener,noreferrer')`. Shown only when `!ended && Boolean(extractMeetingJoinUrl(meeting))` (`:113`). Rendered **inline on every meeting row** in the Engagement tab (icon+label) and on the dashboard (compact icon-only + Tooltip). `extractMeetingJoinUrl` prefers `metadata.webLink` (if it passes `isSupportedJoinUrl`), else regex-scans `location`/`description`; supports Zoom/ZoomGov, Meet, Teams (incl. `.us`/live), Webex, GoTo, Slack huddles. | The Join feature is **kept and carried into the redesign** (per Ninja). But its *placement/styling changes to match the prototype*: in the new Meetings tab it moves off the row and into the **detail-panel header** as an accent-blue external-link text link (§3, §7). The click behavior and provider detection are unchanged — and now read the stored `meeting.joinLink` (§5) instead of re-deriving on every render, falling back to `extractMeetingJoinUrl` for pre-migration rows. |
| **Dashboard Home meeting widget** | `HomePage.tsx` `ClientEngagement` component (lines 558-759): queries `GET /api/engagement/meetings` for the current Mon–Sun week, renders a 7-day week strip + a per-selected-day list. Each row = a `<Link>` (time/subject/sub-line/status `Tag`) + the **same shared `MeetingQuickActions`**, passed `compact` → icon-only antd Buttons in Tooltips (Join green, Send Meri `primary`, Notes `default`). Send Meri opens an inline consent `Modal` (shared `NotetakerConsentFields`); Notes opens a `Modal` (shared `DebriefNotesView`). **No "Meri Attending" state exists anywhere in the codebase today** (`grep 'Meri Attending'` = 0 hits). | Per Ninja: the dashboard's **Meri and Join buttons must be restyled to the new design** (§8a). Send Meri → navy filled pill; add the **Meri Attending** light-blue pill state (net-new; needs notetaker-state on the meeting payload, which §5/§6 already add); Join → accent-blue external-link text link. The dashboard keeps Join **inline on the row** (it has no slide-over panel to host it), unlike the Meetings tab where Join moves into the panel header. |
| **Notetaker tenant gating** | Single manual SQL flag flip, `capiro-internal` only, no admin UI (`tenant-flags.ts:64-89`). Item F (Recall DPA/SOC 2/subprocessor listing/$5 trial) is still an open compliance blocker, tracked in `docs/plans/meeting-notetaker-go-live-checklist.md`. | Out of scope for this plan. The redesigned Meetings page must render correctly whether or not `notetaker.enabled` is on for a tenant (i.e. "Send Meri" simply doesn't appear when the flag is off — no new gating logic needed, this already works today). |
| **Client Documents tab** | **Already exists** in production (`ClientProfilePage.tsx` → `DocumentsTab`, lines 1201-1443): upload/list/delete, a KB-status chip, a notes textarea. Upload → indexing pipeline already works end-to-end (`EngagementAttachment` → `ClientKbService.indexAttachment` → `context_embeddings`), fire-and-forget on confirm. | The "Documents" surface itself is not new. What's new is one additional section inside it ("Shared from meetings") — see §6. |
| **Per-document indexed state** | Not persisted per document — only an aggregate "N items indexed" chip exists today (`GET /api/clio/kb/:clientId/status`). `uploadedByUserId` is stored on `EngagementAttachment` but not returned by the list endpoint/frontend type. | Small, contained addition: an `indexedAt` timestamp column + returning the existing `uploadedByUserId`. Not a new pipeline. |
| **Sharing/visibility precedent elsewhere** | The closest analog, `WsCollaborator` (Workspace engine, `apps/workspace`), lives in a **separate Prisma schema/service with no RLS at all** — not directly reusable, and its DB has no tenant isolation to inherit. The pattern worth copying is the *shape* (owner + explicit share state), not the table. | Build sharing directly on `apps/api`'s existing `Meeting` table (already RLS-protected), rather than importing a cross-service dependency. |
| **RLS convention for new columns/tables** | `apps/api` has a clean, repeatable convention (`clio_memory` precedent): ship code changes in one PR, land `ENABLE/FORCE ROW LEVEL SECURITY` + policy in a separate migration, using `rls_bypass() OR tenant_id = current_tenant_id()`. | Moot for most of this plan — Phase 1 adds **columns to already-RLS-protected tables** (`Meeting`, `MeetingDebrief`, `EngagementAttachment`), not new tables. No new RLS migration needed. |
| **List/pagination convention** | `apps/api` has a house style for bounded list endpoints: `page`/`limit` DTO validated with `class-validator`, `normalizePage`/`normalizeLimit` helpers, `{ data, total, page, limit }` envelope (acquisition-personnel module). | Meeting Library's endpoint follows this exact shape for consistency. |

---

## 3 · Design reference — verified against the running prototype

I loaded the actual prototype (not just the written spec) and exercised Day view, Month view, the meeting detail panel (Prep tab, Notes tab mid-Meri-attendance state), the Private/Shared toggle, and the Meeting Library page. Structure confirmed:

- **Day view**: 7-day mini-week strip at top (weekday + date number + meeting count per day, today highlighted), below it meeting rows grouped under a `"Today — Friday, July 10"`-style date header. Row = time (left) → title (bold) + provider icon/label + client name → Meri-state action directly beneath (`Send Meri` dark pill button, or `Meri Attending` blue pill) → far right, a tight cluster of `Prep / Notes / Debrief` pills (gray = incomplete, green + check = complete, **never red**) + a chevron.
- **Month view**: standard 7-column grid, each day cell stacking up to ~3 meeting chips (time + truncated title) with a `+N more` overflow indicator.
- **List view**: flat agenda, same row shape as Day, grouped under date headers spanning the visible range (structure confirmed via DOM text; a rendering quirk in the sandboxed browser made List-view text fail to paint in screenshots even though the DOM/computed-styles were correct — noted for implementers to sanity-check in a real browser, not a spec finding).
- **Detail panel** (right-side slide-over): header row = date/time range + provider + **`Join`** (see below); large title; `Meri Attending` badge when applicable; client-name pill (small caps) with a right-aligned **Private/Shared segmented toggle** (lock icon on Private); a collapsed `ATTENDEES · N ›` row; a `Prep | Meeting Notes | Debrief` tab strip (a small blue dot marks the tab with unread/new content); tab body scrolls independently. Prep tab shows a light-blue "Meri drew on the previous debrief…" context banner, then `OBJECTIVE` / `SUMMARY` / `TALKING POINTS` (numbered `01 02 03`) / `WATCH-OUTS` (amber box), then `Regenerate · Edit · Export PDF` + an `Approved` status chip. The Notes tab, while Meri is still attending, shows an empty state ("Meri Attending — notes will populate after Meri attends and summarizes the call") with a `Cancel Meri` action.
- **Meeting Library page** (`Meetings / Library` breadcrumb): search box, `All clients` dropdown, artifact-type chip filter (`All / Prep / Notes / Debrief`), visibility chip filter (`All / Shared / Private`), and a table with columns `DATE | MEETING | MATERIALS | VISIBILITY` (materials shown as pills, green-check when approved; visibility as a `PRIVATE`/`SHARED` badge).

**Exact button/affordance styling (measured off the running prototype's computed styles — treat as the literal target):**

| Affordance | Where in prototype | Element | Exact style (measured) |
|---|---|---|---|
| **Join** | Detail-panel **header** meta line, right after the provider (`… · Teams · ⧉ Join`) — **not** on calendar rows | `<a>` text link with an **external-link icon** (24×24 svg) + "Join" label | color `--accent` (`#2A57CE` / `rgb(42,87,206)`), font-size 11.5px, weight 500, `display:flex; gap:4px`, no background, `text-decoration:none`, `cursor:pointer`, `href` set (opens the join URL in a new tab). **Not** the current green filled `VideoCameraOutlined` button. |
| **Send Meri** | On the **row**, beneath the title | `<button>` filled pill | bg `--navy` (`#0C1A38` / `rgb(12,26,56)`), text `#F5F2EB`, font-size 12.5px, weight 600, padding `6px 12px`, border-radius 8px, small Meri/robot glyph before the label |
| **Meri Attending** | On the **row**, beneath the title (replaces Send Meri once a bot is scheduled/attending) | `<span>` pill | bg `#DEE6F8` (tag-blue), text `#1A3F9F` (`rgb(26,63,159)`), font-size 12.5px, weight 600, padding `6px 12px`, border-radius 8px |

Implementers should treat this section plus the spec's own CSS tokens (`--paper`, `--ink`/`--ink2`/`--ink3`, `--navy`, `--accent`, `--border`, `--sunken`, `--success`, `--notable`, `--critical` — critical/red reserved, never used for material status) as the literal visual target, mapped onto the app's existing design-token system rather than hardcoded inline.

---

## 4 · Decision Point — meeting identity & cross-user visibility (Phase 1 vs Phase 2)

This is the one piece of the spec that cannot be built as written without a foundational change, so it gets its own section rather than being buried in the schema diff.

**The problem:** §7's collision model ("two people share the same meeting → one record, notes deduplicated, contributor expander") requires that when User A and User B each independently sync the same real-world calendar event, the system recognizes it as *one* meeting. Today it almost certainly wouldn't: `Meeting` rows are created per calendar connection, keyed `[tenantId, source, externalId]`, where `externalId` is the mailbox-specific Graph event id — not Microsoft Graph's cross-mailbox-stable `iCalUId`. Combined with `ownMeetingWhere()` (visible only to the creator/connection-owner), User B literally cannot open, prep, or send a Meri to a meeting User A's calendar synced — there is no second Capiro user who could ever trigger a collision today.

**Resolution (confirmed with Ninja): Phase it.**

- **Phase 1 (this plan):** Ship every visual and workflow piece of the redesign for the single-contributor case, which is the only case the current data model can produce. The collision-model *code* (contributor list, expander, dedupe rule) is still built exactly as specified — it just always evaluates to "one contributor, no expander," which is indistinguishable from the current single-owner reality and requires no foundational rework.
- **Phase 2 (separately scoped, not part of this build):** Match meetings across mailboxes via Graph's `iCalUId`, replace `ownMeetingWhere()` with an attendee-based visibility predicate (internal attendees matched by email to a Capiro user account), and only then relax the notetaker's single-active-session guard to be scoped per-requesting-user instead of per-meeting. This is a substantial, separately-risk-managed change touching calendar sync, notetaker dispatch, and a predicate used at 15+ call sites — it deserves its own plan and its own review, not a rider on a UI redesign.

This split is why Phase 1's schema footprint (§5) is unusually small: no contributors table, no share-event log, no notification system — because with exactly one possible contributor, "contributors" is just `[{ userId: meeting.createdByUserId, artifacts: [...] }]`, computed in the API response layer, never persisted.

---

## 5 · Data model changes (Phase 1)

Deliberately minimal: **zero new tables, no new RLS migrations** (only new columns on tables already covered by existing tenant-isolation policies).

### `Meeting` — add:
```prisma
joinLink        String?           @map("join_link")
provider        String?           // teams | zoom | meet | webex | goto | slack — derived at sync time
isVirtual       Boolean           @default(false) @map("is_virtual")

visibility      MeetingVisibility @default(private)
sharedAt        DateTime?         @map("shared_at") @db.Timestamptz(6)
sharedByUserId  String?           @map("shared_by_user_id") @db.Uuid
```
```prisma
enum MeetingVisibility {
  private
  shared

  @@map("meeting_visibility")
}
```
- `joinLink`/`provider`/`isVirtual` are populated at ingest time (`persistGraphEvent` and manual-create), by a new shared utility (see §7) that prefers Graph's structured `isOnlineMeeting`/`onlineMeeting.joinUrl` fields (requires adding them to the Graph `$select`/`GraphEvent` interface — same OAuth scope, no new consent) and falls back to the existing regex scan of `location`/`description`/`webLink` when the structured fields are absent (manual meetings, non-Graph sources). This retires the frontend/backend duplicated-regex risk already flagged in the code (see §2) — one implementation, called from both the sync path (server) and, via the same shared package, the client for any UI-side eligibility checks.
- `visibility` gates Library/Documents-tab eligibility; sharing requires `clientId` to be set (enforced in the service, matching spec §6.2).
- `sharedAt`/`sharedByUserId` back the "Saved to *[client]* · Documents" deeplink line and the Library's visibility column. Un-share simply flips `visibility` back to `private` and clears both — trivial in Phase 1 since there's exactly one possible sharer.

### `MeetingDebrief` — add:
```prisma
status MeetingDebriefStatus @default(generated)
```
```prisma
enum MeetingDebriefStatus {
  generated
  edited
  approved

  @@map("meeting_debrief_status")
}
```
Mirrors the existing `MeetingPrepStatus` pattern. Paired with a new `POST /meetings/:id/debriefs/:debriefId/approve` endpoint, symmetric with the existing prep-approve route.

### `EngagementAttachment` — add:
```prisma
indexedAt DateTime? @map("indexed_at") @db.Timestamptz(6)
```
Set by `ClientKbService` when `indexAttachment()` completes successfully (currently fire-and-forget with no completion signal back to the row). Also: return the already-stored `uploadedByUserId` from `listAttachments()`/the frontend `ClientAttachment` type — pure plumbing fix, no schema change needed for that part.

### Nothing else changes.
No `contributors` table, no `MeetingShareEvent` log, no notification table. If a compliance-relevant audit trail for share/unshare actions is required, wire it into whatever generic audit-logging convention already exists elsewhere in the codebase (this plan did not find one in scope for meetings specifically — verify against the platform's audit convention before shipping share/unshare, don't invent a parallel mechanism).

---

## 6 · API surface changes (Phase 1)

All new/changed endpoints stay under the existing `apps/api` Engagement module (no new module) and follow the existing `@CurrentTenant()` + `prisma.withTenant()` convention throughout.

| Endpoint | Change |
|---|---|
| `GET/POST/PUT meetings*` | Response payload gains `joinLink`, `provider`, `isVirtual`, `visibility`, `sharedAt`, `sharedByUserId`, and a computed `contributors: [{ userId, name, artifacts }]` (always length-1 in Phase 1) + computed `notesApproved: true` once a note exists. |
| `POST /meetings/:id/share` *(new)* | Validates `clientId` is set; sets `visibility=shared`, `sharedAt=now()`, `sharedByUserId=ctx.userId`. Returns the confirmation payload the UI needs to render "what/where/who" (approved-artifact summary + client name) before the user commits — i.e. this is called *after* the user confirms, with a preceding `GET` (or same-payload dry-run) used to populate the confirmation step's text. Because Phase 1 has one possible sharer, the "someone already shared this" co-share notice is dead code with a documented trigger condition (`visibility === 'shared' && sharedByUserId !== ctx.userId`) that cannot fire until Phase 2 — build it, don't wire a fake fallback around it. |
| `POST /meetings/:id/unshare` *(new)* | Sets `visibility=private`, clears `sharedAt`/`sharedByUserId`. |
| `POST /meetings/:id/debriefs/:id/approve` *(new)* | Symmetric with the existing prep-approve endpoint; flips `status → approved`. |
| `PATCH /meetings/:id/debriefs/:id` | Gains status transitions `generated → edited` on manual edit (mirrors prep's existing edit-then-approve flow). |
| `GET /meetings/library` *(new)* | Paginated (`page`/`limit`, `{ data, total, page, limit }` per house convention), filters: `clientId`, `artifactType` (`prep\|notes\|debrief`), `visibility` (`shared\|private`), date range. Server-side filters to `ownMeetingWhere(ctx.userId)` ∩ "has at least one approved artifact." |
| `GET /clients/:id/shared-meetings` *(new)* | Backs the Documents-tab "Shared from meetings" section: meetings for this client where `visibility=shared`, newest first, with approved-artifact summary + `sharedByUserId`/`sharedAt` for the "Shared by {name}" line. |
| `POST /meetings/:id/notetaker` | No contract change; service derives `botName` from `ctx.userId`'s display name instead of the hardcoded constant. |
| Frontend dispatch call | Now sends `joinAt` when the user picks a future time in the new scheduling UI (backend already accepts it — see §2). |

---

## 7 · Frontend architecture

**Structural recommendation:** extract the Meetings feature out of the 4,625-line `EngagementPage.tsx` into its own module, `apps/web/src/pages/engagement/meetings/`, mirroring the existing `outreach/` subfolder convention already used elsewhere in this codebase. This redesign already touches nearly every line of the meetings code in that file — it's the natural (and only reasonable) point to stop adding to the monolith rather than growing it further. Concretely:

- `meetings/DayView.tsx`, `MonthView.tsx`, `ListView.tsx` — the three calendar bodies, switched by the view chips (chips switch the body, not a filter — per spec AC). Rows render **Send Meri / Meri Attending** + the P/N/D status cluster + chevron. **Rows do NOT render Join** (it moves to the panel header — see next bullet, matches the prototype).
- `meetings/MeetingDetailPanel.tsx` — the slide-over, with `PrepTab.tsx` / `NotesTab.tsx` / `DebriefTab.tsx` as children. **The `Join` affordance lives in this panel's header** (accent-blue external-link text link, styled per §3), not on the rows. This is a deliberate placement change from today (where Join is an inline green button on every row): in the new design you open a meeting, then Join from its header.
- `meetings/ShareConfirmation.tsx` — the what/where/who modal + co-share-notice (dormant in Phase 1, see §6).
- `meetings/MeetingLibraryPage.tsx` — new page, new route `/engagement/meetings/library`.
- **Rework the shared `meeting-actions.tsx`** rather than leave it as-is. Today it exports one `MeetingQuickActions` that renders Join+Send Meri+Notes as antd Buttons and is consumed by both the Engagement tab and the dashboard. In the redesign, the *presentation* diverges (Meetings tab = Send Meri pill on row + Join link in panel header; dashboard = compact inline Send Meri/Meri Attending/Join, §8a), so split it into: (a) small presentational primitives — `SendMeriButton` (navy pill), `MeriAttendingPill` (light-blue pill), `JoinLink` (accent-blue external-link) — that both surfaces compose, and (b) keep the shared behavior helpers (`extractMeetingJoinUrl`, consent form body `NotetakerConsentFields`, `DebriefNotesView`) untouched. This preserves the "one source of truth for join detection + consent" property while letting each surface lay the buttons out to its own spec.
- A new shared package module, e.g. `packages/shared/src/meetings/detectVirtualMeeting.ts`, that absorbs `JOIN_URL_PATTERN` / `isSupportedJoinUrl` / `extractMeetingJoinUrl` — used by the backend sync/dispatch code and re-exported for the frontend, replacing the two independently-maintained regex copies (the in-code "must stay in lockstep" warning becomes structurally enforced). The `JoinLink` component prefers the stored `meeting.joinLink` (§5) and falls back to this detector only for pre-migration rows.

**Do not preserve the current week-grid `MeetingCalendarList` component** as a fourth mode — the spec explicitly supersedes it with Month. **`HomePage.tsx`'s dashboard widget is explicitly in scope** (§8a) — it is *not* left unmodified: it consumes the reworked primitives above so its Meri/Join buttons match the new design. It does not, however, use the new view/detail-panel components, so those can be built independently of the dashboard restyle.

### 7a · Join affordance — behavior contract (unchanged from today, only re-placed/re-styled)
The existing Join feature is kept in full. On click it navigates to the meeting's join URL in a new tab (`window.open(url, '_blank', 'noopener,noreferrer')`), where `url = meeting.joinLink ?? extractMeetingJoinUrl(meeting)`. It is shown only when the meeting has **not ended** and a **supported join URL exists** (same `!ended && Boolean(joinUrl)` gate as today; provider set covers Zoom/ZoomGov, Meet, Teams incl. `.us`/live, Webex, GoTo, Slack huddles). What changes is purely presentational: **Meetings tab → accent-blue external-link text link in the detail-panel header; dashboard → accent-blue external-link link inline on the row.** No backend change; the click handler and detection logic are the current ones, relocated.

**Rollout mechanism:** gate the new Meetings module behind a tenant flag (e.g. `meetingsV2.enabled`, same `settings_jsonb.clioFeatureFlags` mechanism already used for `notetaker.enabled` and the MeriV2 rollout) rather than a big-bang cutover. This is a production page in active use; the existing per-tenant-flag pattern in this codebase exists precisely for this kind of replacement. Flip per tenant after verification, then delete the old view components once every tenant is cut over.

---

## 8a · Dashboard Home widget — Meri/Join restyle (Ninja request)

The dashboard's "Client Engagement" widget (`HomePage.tsx` `ClientEngagement`, lines 558-759) keeps its structure — the Mon–Sun week strip, per-day list, the row `<Link>`, the status `Tag`, and its consent/notes modals all stay. **Only the per-row action buttons change, to match the new Meetings design language:**

| Button | Today | After (new design) |
|---|---|---|
| **Send Meri** | antd `<Button size="small" color="primary" variant="solid">`, compact icon-only + Tooltip | **Navy filled pill** (`SendMeriButton` primitive, §7): bg `--navy`, cream text, robot glyph + "Send Meri" label — the same treatment as a Meetings-tab row |
| **Meri Attending** | *does not exist today* | **New light-blue pill** (`MeriAttendingPill` primitive): bg `#DEE6F8`, text `#1A3F9F`. Shown in place of Send Meri once a notetaker is `scheduled`/`attending` for that meeting |
| **Join** | antd `<Button size="small" color="green" variant="solid">` with `VideoCameraOutlined`, compact icon-only + Tooltip | **Accent-blue external-link text link** (`JoinLink` primitive): `--accent`, external-link icon + "Join". Stays **inline on the row** (the dashboard has no slide-over to host it) |
| **Notes** | antd `<Button size="small" color="default" variant="filled">` | Out of scope for the restyle (Ninja named only Meri + Join). Keep it functional; visually reconcile it to sit alongside the two restyled affordances in the same `flex; gap` row without clashing. |

**Prerequisite the restyle depends on:** the "Meri Attending" state requires the dashboard to know each meeting's notetaker status. That already comes for free — the meetings payload the widget queries (`GET /api/engagement/meetings`) gains the notetaker/`meri` state in §6 (`none | scheduled | attending | done`), so the widget derives Send-Meri-vs-Meri-Attending the same way a Meetings-tab row does. No new dashboard-specific endpoint.

**Consistency guarantee:** because both surfaces compose the *same* `SendMeriButton` / `MeriAttendingPill` / `JoinLink` primitives (§7), the dashboard and the Meetings tab cannot visually drift — the compact-vs-labeled `compact` flag that is the *only* difference today is removed in favor of the shared primitives. The dashboard's existing CSS overrides (`.home-panel-row-wrap .engagement-meeting-quick-actions { margin:0; padding-right:14px; flex-shrink:0 }`, `theme.css`) are updated to lay out the new primitives inline-right; the base `.engagement-meeting-quick-actions` rule is retired with the old component.

---

## 8 · Client profile — Documents tab integration

No new tab, no new page — the existing `DocumentsTab` component (`ClientProfilePage.tsx:1201`) gains a second section, per spec §8:

1. **"Shared from meetings"** (new) — one row per meeting from `GET /clients/:id/shared-meetings`, newest first, artifact pills, `"Shared by {name}"` subtitle (contributor expander logic present but dormant per §4/§6). Clicking a row opens the meeting record (deep-linked back into the Meetings module's detail panel, or a read-only variant of it — implementer's call, not spec-constrained).
2. **Context documents** (existing, unchanged behavior) — gains a per-document "Indexed" badge driven by the new `indexedAt` column, and shows the uploader (already stored, just needs to be returned/rendered).

No change to the upload/parse/index pipeline itself — it already works end-to-end.

---

## 9 · Rollout sequencing

```
Wave 0 — Foundations (schema + shared utils)
  • Migration: Meeting.{joinLink,provider,isVirtual,visibility,sharedAt,sharedByUserId} + MeetingVisibility enum
  • Migration: MeetingDebrief.status + MeetingDebriefStatus enum
  • Migration: EngagementAttachment.indexedAt
  • packages/shared: detectVirtualMeeting (consolidates the two regex copies)
  • Graph sync: add isOnlineMeeting/onlineMeeting.joinUrl to the $select/GraphEvent interface
  • Tenant flag: meetingsV2.enabled (default off)

Wave 1 — Backend API
  • Meeting read/write payload additions
  • POST .../share, POST .../unshare
  • Debrief status + approve endpoint
  • GET meetings/library (paginated)
  • GET clients/:id/shared-meetings
  • Notetaker: per-sender botName derivation; frontend-facing joinAt now actually usable

Wave 2 — Frontend: shared primitives + Meetings module extraction + rebuild
  • Rework meeting-actions.tsx into shared primitives: SendMeriButton (navy pill),
    MeriAttendingPill (light-blue pill), JoinLink (accent-blue external-link);
    keep NotetakerConsentFields / DebriefNotesView / join-detection behavior
  • New apps/web/.../meetings/ module; Day/Month/List; detail panel restyle;
    Join in the panel header (not on rows); collapsible attendees;
    Private/Shared toggle + confirmation modal; Meri scheduling picker
  • Remove week-grid component (superseded, not kept)

Wave 3 — Dashboard restyle + Meeting Library + Documents-tab integration
  • HomePage ClientEngagement widget: swap the compact MeetingQuickActions for the
    new SendMeriButton / MeriAttendingPill / JoinLink primitives (§8a); update the
    dashboard CSS overrides; Join stays inline on the row
  • New Library page/route
  • DocumentsTab "Shared from meetings" section + indexed badge/uploader display

Wave 4 — Tenant cutover
  • Flip meetingsV2.enabled per tenant after parity verification
  • Delete old view components + shrink EngagementPage.tsx once fully cut over
```

Waves 0–1 have no user-visible surface and can ship dark at any time. Waves 2–3 are what the flag gates. Wave 4 is cleanup, not new capability. **Dashboard note:** the Wave-3 dashboard restyle uses the shared primitives built in Wave 2. Decide at build time whether the dashboard restyle ships behind `meetingsV2.enabled` too (cleanest — dashboard and tab flip together per tenant) or immediately for everyone (the primitives are backward-compatible and the dashboard doesn't depend on the new views). Recommend gating it on the same flag so a tenant sees one consistent design at a time.

---

## 10 · Acceptance criteria mapping (spec §10)

| Spec AC | Phase |
|---|---|
| Day/Month/List are true modes, chips switch the body | 1 |
| Right-clustered full-word P/N/D pills, no icon-only | 1 |
| Gray/green material status, no red; blue "Meri Attending" | 1 |
| Send Meri only on virtual meetings with a join link | 1 (now backed by stored `joinLink`/`isVirtual`, not live regex) |
| Meri named per-sender | 1 |
| Multiple users send their own Meri to one meeting; notes attributed to N notetakers | **2** — cannot occur until cross-user visibility exists |
| Artifacts default private; only approved artifacts reach Library/sharing | 1 |
| Share flip opens what/where/who confirmation | 1 |
| Co-share notice when already shared by someone else | Code built in 1; unreachable until **2** (no second possible sharer yet) |
| Client material on client profile via navigation/deeplink, never embedded | 1 |
| Documents keys by meeting (two shares = one row) | 1 (trivially true — one meeting, one owner, one share) |
| Notes shown once; second contributor only when they diverge; expander lists only divergent artifacts | Code built in 1; only exercised in **2** |
| Meeting stays shared while any contributor has shared; per-contributor unshare | 1 for the single-contributor case; multi-contributor semantics are **2** |

**Additional acceptance criteria (Ninja requests, not in spec §10) — all Phase 1:**

| Requirement | Acceptance |
|---|---|
| The existing **Join** feature is carried into the redesign | On a not-ended virtual meeting with a supported join URL, a `Join` affordance is present and opens the join URL in a new tab. In the Meetings tab it appears in the **detail-panel header** (accent-blue external-link link, per §3); it is not lost. Behavior/detection identical to today. |
| **Dashboard** Meri & Join buttons match the new design | On the Home dashboard's Client Engagement widget, "Send Meri" renders as the navy pill, a "Meri Attending" light-blue pill appears once a notetaker is scheduled/attending, and "Join" renders as the accent-blue external-link link — visually identical to the Meetings-tab treatment, via shared primitives (§7, §8a). |

---

## 11 · Risks & explicit non-goals

**Risks**
- `meeting-actions.tsx` is shared by both the Meetings tab and the dashboard Home widget, and this plan reworks it into presentational primitives (§7) while both surfaces are simultaneously restyled (§8a). Regression-test **both** consumers together — the Engagement tab (3 render sites) and the dashboard widget (1) — and keep the behavior helpers (`extractMeetingJoinUrl`, `NotetakerConsentFields`, `DebriefNotesView`) byte-stable so only presentation moves. A broken shared primitive breaks two production surfaces at once.
- The dashboard "Meri Attending" state is net-new UI backed by the notetaker-state field added in §6 — verify the dashboard's `GET /api/engagement/meetings` payload actually carries that state before wiring the pill, or it silently falls back to always showing "Send Meri".
- Adding Graph's structured online-meeting fields to the sync client is new surface area on a sync path that's currently regex-only for a reason (Graph doesn't always populate `onlineMeeting.joinUrl` even for Teams events) — keep the regex fallback, don't remove it.
- Recall's Item F (DPA, subprocessor listing, SOC 2 report, $5-trial upgrade) remains an open compliance blocker independent of this plan — it constrains how far "Send Meri" usage can scale, not the Meetings UI redesign itself.
- SOC 2 Type II posture: confirm the audit-logging question in §5 before shipping share/unshare in production — sharing a client's private meeting material is exactly the kind of action that likely needs to land in whatever compliance audit trail already exists elsewhere in the platform.
- This repo has two local clones with the OneDrive path as canonical `main` — confirm any implementing agent is working in the correct one.

**Explicit non-goals for this plan**
- Google Workspace / IMAP-CalDAV calendar sync (still schema placeholders; unaffected).
- Notetaker multi-tenant rollout policy / admin toggle UI (separate initiative; this plan only requires "Send Meri" to degrade gracefully off when the flag is off, which already works today).
- Cross-mailbox meeting identity, attendee-based shared visibility, multi-user notetaker dispatch (Phase 2, scoped separately per §4).
- GDPR/erasure handling for meeting artifacts beyond what already exists — flagged as a pre-existing gap, not solved here.
