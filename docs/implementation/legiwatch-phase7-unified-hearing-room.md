# LegiWatch Live Hearings — Phase 7 Unified Hearing Room and Scheduling UX

Status: implementation complete on `agent/legiwatch-phase7-unified-hearing-room`.

Stacked base: validated Phase 0/3/4/5/6 closeout head `273d0038a87ea98a9e114594a5a50fcb197bf351`.

This phase does not merge, deploy, enable production capture-all, or activate production schedules.

## Exit contract

Phase 7 closes the user workflow around the global capture foundation:

1. Find a canonical public proceeding in Master Calendar / Live Now / Committee Rooms.
2. Enter one canonical Hearing Room.
3. Schedule unattended recording without creating a tenant-owned media/transcript copy.
4. Close Capiro without interrupting the server capture.
5. Return to the same canonical transcript, including explicit interruption gaps.
6. Use browser-assisted capture only when a shared server capture is not already available and policy permits the official public page.
7. Browse the user's scheduled recordings and the public canonical archive.

Phase 8 intelligence persistence is deliberately not implemented here. The Phase 7 API returns an explicit `PHASE_8_PERSISTENCE_NOT_ENABLED` seam instead of fabricating intelligence cards.

## HTTP surface

Under `/api/legiwatch/live-hearings`:

- `GET /events/:id/room` — canonical room aggregate.
- `GET /events/:id/transcript` — canonical global transcript, stable keyset pagination.
- `GET /events/:id/participation` — current tenant/current user schedule/follow state.
- `POST /events/:id/schedule` — idempotent tenant demand + one global capture + durable preflight.
- `DELETE /events/:id/schedule` — remove only this user's manual demand; never delete global history or another tenant's demand.
- `POST /events/:id/follow` — tenant/user follow state, no capture demand.
- `DELETE /events/:id/follow` — remove tenant/user follow state.
- `POST /events/:id/join-browser` — safe handoff: attach to canonical capture, browser fallback, or explicit block.
- `GET /recordings` — this user's scheduled public proceedings with global capture state.
- `GET /archive` — public canonical completed/terminal proceedings.
- `GET /events/:id/intelligence` — explicit Phase 8 not-enabled seam.

Phase 3/4 routes remain unchanged: calendar, live, coverage, committee directory/detail/members/updates, canonical event metadata, and event updates.

## One hearing / one capture / one transcript

`hearing_subscription` remains capture demand. Scheduling two tenants onto the same hearing produces two tenant subscriptions and one `public_hearing_capture` row because the global table retains its database-level unique hearing invariant.

Phase 7 does not create a tenant transcript table. `GET /events/:id/transcript` resolves the hearing's single global capture and reads `public_hearing_transcript_segment` directly.

The transcript reader uses `(sequence, id)` keyset pagination and returns:

- segment id;
- sequence;
- start/end milliseconds;
- text;
- speaker label/name;
- transcription/speaker confidence where recorded;
- finality;
- explicit `hasGapBefore` / `gapBefore` markers;
- revision.

It never returns Deepgram credentials, Deepgram session references, raw media URLs, tenant ids, client ids, or watchlist terms.

## Schedule policy

The public schedule route passes through `LiveHearingsPhase7ScheduleGuard` before tenant demand is created.

Capture policy is authoritative and cannot be widened by a transient resolver state:

- `SERVER_CAPTURE_ALLOWED` — schedule allowed.
- no candidate yet — schedule demand accepted for official-source preflight.
- `REVIEW_REQUIRED` — demand accepted pending Phase 5 preflight/re-resolution.
- `BROWSER_CAPTURE_ONLY` — unattended server capture rejected.
- `LICENSE_REQUIRED` — unattended server capture rejected.
- other blocked policy — rejected.
- private / canceled / completed proceeding — rejected.

The worker still re-resolves in its own egress environment immediately before consumption; request-time resolution never supplies a stale ingest URL to the worker.

## Follow is not capture demand

Phase 6 correctly treats `hearing_subscription` as server-capture demand. Reusing the same row merely to "follow" an event would therefore schedule recordings accidentally.

Phase 7 adds `hearing_follow` as a separate tenant/user table:

- unique `(tenant_id, user_id, hearing_id)`;
- FORCE RLS with the canonical tenant policy;
- notification preferences only;
- no raw media or transcript data;
- no effect on Phase 6 demand counts.

`hearing_follow` is intentionally SQL-owned and accessed through tenant-scoped raw queries. The forward migration is the runtime source of truth; generated Prisma delegates are not used for this table. Production uses forward migration deployment rather than destructive schema reconciliation. Any future migration-generation work must preserve the SQL-owned table rather than generating a drop.

## Browser-assisted fallback

`POST /events/:id/join-browser` never returns a raw media transport.

If the canonical server capture is active or complete, the response is `ATTACH_CANONICAL` and the frontend stays on the shared transcript.

Otherwise, an eligible public proceeding may return `BROWSER_CAPTURE` with only the reconciled official event page. The frontend then reuses the established browser session API with:

- `audioSource: browser_mic`;
- `recordingPolicy: transcript_only`;
- canonical hearing id / committee id;
- official source page.

Private, canceled, or unresolved-no-official-page proceedings return an explicit `BLOCKED` reason.

## Official broadcast

The Phase 7 event surface includes an official broadcast panel.

Inline framing is allowlisted, not inferred. A known first-party Senate ISVP public embed page may render inline. Other official sources render as a direct official-source link. YouTube, C-SPAN, arbitrary committee pages, credentialed URLs, and non-http schemes are not auto-framed.

No resolved media URL is exposed to the browser.

## Hearing Room contents

The unified room surfaces real persisted/official data only:

- official proceeding metadata;
- official broadcast/link;
- exact capture state (`domain_status`);
- stream/resolution/capture policy provenance;
- captured duration, reconnects, transcript-gap duration, terminal/failure reason;
- canonical transcript with current speaker and confidence;
- visible gap markers;
- machine-generated transcript disclaimer;
- witness strings from the canonical hearing record;
- official document/update links from `committee_site_update` evidence;
- committee member roster and stated chair/ranking titles;
- official update timeline;
- tenant schedule/follow state;
- explicit Phase 8 intelligence placeholder.

A user is told when server capture continues independently of the browser.

## V2 navigation / rollback

The validated tenant feature flag `legiwatchLiveHearingsV2` remains the activation gate. The global V2 kill switch can disable the rebuild but cannot enable a tenant.

For enabled tenants:

- Master Calendar and Committee Rooms reuse the validated Phase 3/4 canonical surface.
- Live Now, Scheduled Recordings, My Sessions, Archive, and Event Room use the Phase 7 surface.
- the source-coverage drawer remains visible.

The old `LiveHearingsPage` remains the fail-closed rollback surface when V2 is disabled.

Bill Tracker and Settings are untouched.

## Tests added

API/unit contracts:

- `live-hearings-phase7.service.spec.ts`
- `live-hearings-phase7-schedule.guard.spec.ts`
- `live-hearings-phase7-public.guard.spec.ts`
- `live-hearings-phase7.controller.spec.ts`
- `legiwatch-phase7-follow-migration.spec.ts`

Disposable-Postgres integration:

- `live-hearings-phase7.integration.spec.ts`
  - two tenants -> one global capture;
  - cancel-one-tenant preserves other demand + capture;
  - follow isolation and zero capture demand;
  - transcript keyset pagination + gap markers;
  - browser join attaches to active canonical capture.

Web contracts:

- `live-hearings-phase7-api.test.ts`
- `LiveHearingsV2BroadcastPanel.test.ts`

## Validation commands for a real worktree

```powershell
pnpm --filter @capiro/api exec prisma validate
pnpm --filter @capiro/api exec prisma generate
pnpm --filter @capiro/api exec tsc -p tsconfig.hearings.json --noEmit
pnpm --filter @capiro/api test -- `
  src/live-hearings/live-hearings-phase7.service.spec.ts `
  src/live-hearings/live-hearings-phase7-schedule.guard.spec.ts `
  src/live-hearings/live-hearings-phase7-public.guard.spec.ts `
  src/live-hearings/live-hearings-phase7.controller.spec.ts `
  src/prisma/legiwatch-phase7-follow-migration.spec.ts `
  --runInBand

pnpm --filter @capiro/web typecheck
pnpm --filter @capiro/web test -- `
  src/pages/radar/live-hearings/live-hearings-phase7-api.test.ts `
  src/pages/radar/live-hearings/LiveHearingsV2BroadcastPanel.test.ts
pnpm --filter @capiro/web build
```

After applying all API migrations to a disposable Postgres database:

```powershell
pnpm --filter @capiro/api test -- `
  src/live-hearings/live-hearings-phase7.integration.spec.ts `
  --runInBand
```

Then rerun the existing Phase 0/3/4/5/6 regression gates, especially one-capture, subscription isolation, capture recovery/fencing, and the full Live Hearings web tests.

## Launch boundary

Phase 7 implementation does not authorize:

- merging the stacked branch;
- deploying API/web/intel-api;
- enabling production EventBridge/SQS capture schedules;
- enabling `LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS`;
- widening YouTube or C-SPAN capture policy;
- weakening SSRF/RLS;
- claiming Phase 8 intelligence is complete.
