# Meetings & Meri — Phase 2 Blueprint (cross-user collision model)

**Status:** ✅ IMPLEMENTED 2026-07-11 (dormant behind `meetingsCrossUser.enabled`, default OFF). Ninja's decisions (§6): **(1) Option B — group by iCalUId at query time; (2) do NOT widen `ownMeetingWhere` — deliver cross-user only via the tenant-scoped shared feed (no SOC 2 posture change); (3) allow multi-user notetakers (natural via per-user rows).** Built: the flag + `mergeSharedMeetingsByICalUid` grouping in `listSharedMeetingsForClient` + the frontend contributor/notetaker rendering. Follow-up (not blocking): backfill `iCalUId` on pre-groundwork rows (§5) — until then only meetings synced after the groundwork deploy group.
**Predecessor:** Phase 1 (Waves 0–3) shipped 2026-07-11, dormant behind `meetingsV2.enabled` — see [the Phase 1 plan](2026-07-10-meetings-meri-v2-redesign-plan.md). Phase 1 built the full single-contributor experience + the collision-model _code_ (contributors/notes-dedup/expander) as a documented no-op. Phase 2 makes that code actually fire.

---

## 1 · What Phase 2 delivers (the spec parts still not functional)

- **Cross-mailbox meeting identity** — when User A and User B each sync the same real calendar event, the system recognizes it as ONE meeting (spec §7's premise).
- **Attendee-based visibility** — a meeting is visible to any internal attendee (a tenant user matched by email), not only its single creator/connection-owner. This replaces `ownMeetingWhere()`.
- **Real §7 collision model** — two people sharing the same meeting → one Documents record; notes canonical/deduplicated; a second contributor surfaced only when they have their own divergent prep/debrief (the expander).
- **Multi-user notetakers (§4.4)** — two users can each send their own per-sender Meri to the same meeting; notes captured once, attributed to all bots.

Everything else in the spec already shipped in Phase 1.

---

## 2 · Current-state seam (verified)

- Meetings are keyed **per-mailbox**: `@@unique([tenantId, source, externalId])` where `externalId = Graph event.id` (mailbox-specific). `persistGraphEvent` upserts by `tenantId_source_externalId` (`microsoft-graph-sync.service.ts:651-656`). So two attendees' syncs → **two rows** for one real meeting.
- Microsoft Graph exposes **`iCalUId`** on the event resource — a value **stable across mailboxes** for the same meeting. It is NOT currently captured.
- Visibility today = `ownMeetingWhere(userId)` = `{ OR: [{createdByUserId}, {connection.createdByUserId}] }`, applied at **~21 call sites** in `engagement.service.ts` (772, 803, 877, 1456, 2749, 3195, 3257, 3321, 3352, 3456, 3498, 3630, 3649, 3784, 4045, 4066, 4134, 4872, 4912, 5020, 5231) + the notetaker dispatch guard.
- Notetaker allows **one active session per meeting** — `BadRequestException` if any non-terminal `MeetingBotSession` exists (`notetaker.service.ts:277-284`).
- `MeetingAttendee.email` is `@db.Citext`; `User.email` is `@db.Citext` — so attendee↔user matching is a clean case-insensitive email join.
- Phase 1's API already returns a `contributors[]` array (length-1 today) and dedups notes in the response `decorateMeetings` — the shapes are ready; Phase 2 populates them with real multi-contributor data.

---

## 3 · THE decision (Ninja) — how to unify cross-mailbox duplicates

When two mailboxes sync the same event (same `iCalUId`, different `externalId`), we must present one meeting. Three approaches, with trade-offs. **This is a production-data decision — I will not implement the switch until you pick.**

### Option A — Canonical meeting (merge/dedup by iCalUId)

Make `(tenantId, iCalUId)` the identity. One `Meeting` row per real meeting; all attendees' syncs upsert into it. Artifacts (prep/notes/debrief) attach to the one row.

- ✅ Cleanest data model; §7's "canonical notes, one record" is natural.
- ❌ Requires a **destructive backfill migration** to collapse existing duplicate rows (each duplicate already owns its own attendees/notes/preps/debriefs/attachments/tasks/bot-sessions — merging them is non-trivial and irreversible). Ongoing: sync must pick a "winner" row per iCalUId and reconcile organizer/connection.
- ❌ Highest risk on live prod data.

### Option B — Group without merging (RECOMMENDED)

Keep per-mailbox rows untouched. Add `iCalUId` as a **grouping key**; a lightweight `MeetingGroup` (or just group-by-iCalUId at query time) presents the set as one meeting. Artifacts stay on each user's own row; the API's `decorateMeetings` merges a group into one payload (notes deduped across the group, prep/debrief per-contributor) — exactly the Phase-1 response shape, now fed by N rows instead of 1.

- ✅ **Non-destructive** — no risky migration; existing rows keep working; flag/rollback-safe.
- ✅ Maps directly onto Phase 1's already-built `contributors[]` + notes-dedup response contract (minimal frontend change).
- ✅ Notes-dedup rule (§7): notes are per-row, but the group's canonical notes = the Meri-captured notes (dedup in the response); each contributor's prep/debrief stays theirs.
- ⚠️ "One meeting" is a query-time grouping, not a single row — a few read paths must group; writes stay per-row.

### Option C — Hybrid canonical-record

Keep per-user rows for prep/debrief, but introduce a canonical `Meeting` (by iCalUId) that owns the shared notes + visibility, with per-user rows linked to it. More model surface than B; less migration risk than A.

**Recommendation: Option B.** It reuses Phase 1's response contract, avoids a destructive prod migration, and is fully flag/rollback-safe. The other genuine sub-decision (independent of A/B/C):

### Visibility policy (confirm)

Replace `ownMeetingWhere` with: _a meeting is visible to a tenant user if they created it, own its connection, OR are an internal attendee (their `User.email` matches a `MeetingAttendee.email`)_. This widens who can see a meeting — a **security-posture change** (SOC 2). Confirm the attendee-match rule (email-exact, internal-domain only?) and that widening visibility to attendees is intended.

---

## 4 · Implementation shape (once §3 is decided) — assuming Option B

- **Groundwork (DONE, dormant):** `Meeting.iCalUId` column + `@@index([tenantId, iCalUId])`, populated at Graph sync (`event.iCalUId`) and null for manual meetings. Additive; no behavior change. (Migration `20260711…_meeting_ical_uid`.)
- **Visibility predicate:** add `visibleMeetingWhere(ctx)` = `ownMeetingWhere` OR attendee-email-match; swap it in at the ~21 call sites behind a helper so the change is one edit + audited. Gate on a flag (`meetingsCrossUser.enabled`) so it rolls out independently of `meetingsV2`.
- **Grouping in reads:** `listMeetings`/`getMeeting`/library/shared-meetings group rows by `(tenantId, iCalUId)` (rows without an iCalUId stay standalone), and `decorateMeetings` folds a group into one payload: canonical notes (Meri), `contributors[]` = each row's owner with their own prep/debrief, notes-dedup + expander per §7.2.
- **Notetaker:** relax the single-active-session guard from per-meeting to **per-(meeting, requesting user)** so each user can dispatch their own bot; `notetakers[]` attribution on the notes header.
- **Frontend:** mostly free — Phase 1 already renders `contributors`/expander/`sharedBy`/notes-once. Wire the (already-built, dormant) expander + "N notetakers" + co-share notice, which start firing once groups have >1 contributor.

---

## 5 · Rollout / safety

- Ship the iCalUId groundwork now (dormant — just captures the id).
- Backfill `iCalUId` on existing rows via a one-off `sync`/diag verb (re-read from `raw_jsonb` where present, else next delta sync fills it).
- Gate the behavior change behind its own flag; enable per tenant after verification, same as `meetingsV2`.
- Option B means rollback = flip the flag (no data to un-merge).

---

## 6 · Decisions (RESOLVED 2026-07-11)

1. **Identity → Option B** (group by iCalUId at query time). ✅ Built.
2. **Visibility → do NOT widen `ownMeetingWhere`.** Cross-user grouping happens only on the tenant-scoped *shared* feed (client Documents), which is already org-visible — so §7's collision model is delivered without letting colleagues open each other's un-shared personal meetings (no SOC 2 posture change). ✅ Built.
3. **Multi-notetaker → allowed**, naturally via per-user rows; the grouped record merges the per-sender names into `notetakers[]`; the per-row single-active-session guard is unchanged. ✅ Built (no notetaker-service change needed).

**Delivered behind `meetingsCrossUser.enabled` (default OFF).** Enable per tenant (SQL): `jsonb_set(... '{clioFeatureFlags,meetingsCrossUser.enabled}','true'…)`.
**Remaining follow-up (non-blocking):** backfill `iCalUId` on rows synced before the groundwork deploy so historical meetings also group (a one-off re-sync / raw_jsonb read).
