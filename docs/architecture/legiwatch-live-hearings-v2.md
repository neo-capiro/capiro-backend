# Architecture Decision: LegiWatch Live Hearings V2

**Status:** Accepted  
**Date:** 2026-08-21  
**Scope:** Master-plan Phases 0, 3, 4, 5, and 6

## Decision

LegiWatch Live Hearings V2 treats public congressional proceedings as a global public-record data plane with tenant-specific demand and relevance layered on top.

The binding capture invariant is:

```text
One public hearing
    ↓
One media connection
    ↓
One Deepgram transcription stream
    ↓
One canonical public transcript
    ↓
Many tenant subscriptions
```

A tenant subscription never creates a tenant-owned copy of the public capture or canonical transcript. Tenant/client/watchlist context must not be written into global hearing, stream-candidate, capture, capture-job, or canonical transcript records.

## Coverage contract

The supported product promise is:

> Every publicly scheduled House, Senate, joint committee, and subcommittee event discovered in supported official sources is represented once and is either captured or assigned an explicit, auditable exception reason.

Closed, classified, private, canceled, and genuinely non-streamed proceedings are not eligible for unattended public capture. They remain represented with an explicit status/reason where applicable.

Zero discovered events is never evidence of complete source coverage. Coverage health is tracked separately from event count.

## Eligible event types

The unattended capture runtime recognizes these canonical public event classes:

- hearing
- markup
- meeting
- business meeting / `business_meeting`
- roundtable
- forum

Additional event classes require an explicit code and policy update before they are treated as capture-eligible.

## Source policy

Every stream resolution receives an explicit capture policy:

- `SERVER_CAPTURE_ALLOWED`
- `BROWSER_CAPTURE_ONLY`
- `LICENSE_REQUIRED`
- `BLOCKED`
- `REVIEW_REQUIRED`

Initial operating posture:

| Source class | Default posture |
|---|---|
| First-party Senate-hosted media | Server-capture candidate |
| First-party House/Congress media | Server-capture candidate |
| Committee-owned media/CDN | Server-capture candidate after resolver validation |
| Official page embedding YouTube | Browser-only unless separately approved |
| C-SPAN | License required; server capture blocked without approval |
| Unknown third-party transport | Review required / blocked from automatic fetch |
| Arbitrary user-supplied media URL | Not part of the ordinary V2 workflow |

A resolved URL is not itself authorization to server-capture. Policy classification is evaluated independently from technical resolvability.

## Resolution and reason-code contract

Every resolver attempt produces a state, capture policy, and reason code. The canonical reason vocabulary includes:

- `FIRST_PARTY_STREAM_READY`
- `STREAM_NOT_LIVE_YET`
- `DELAYED_START_GRACE_EXPIRED`
- `NO_MEDIA_DISCOVERED`
- `CLOSED_PROCEEDING`
- `CLASSIFIED_PROCEEDING`
- `EVENT_CANCELED`
- `EVENT_POSTPONED`
- `OFFICIAL_NOTICE_NO_STREAM`
- `YOUTUBE_BROWSER_ONLY`
- `CSPAN_LICENSE_REQUIRED`
- `UNKNOWN_PROVIDER_REVIEW_REQUIRED`
- `RESOLVER_NETWORK_POLICY_BLOCK`
- `RESOLVER_SOURCE_ERROR`
- `INVALID_RESOLVER_RESULT`

Terminal capture outcomes additionally persist a terminal reason such as `CAPTURE_COMPLETE`, `CAPTURE_COMPLETE_WITH_GAPS`, a concrete failure code, `EVENT_CANCELED`, or `CAPTURE_BLOCKED`.

Reason codes are durable audit data. Human-readable error detail may supplement them but must not replace them.

## Stream resolution architecture

The resolver is a background capability, not an ordinary user workflow.

Resolution order prefers approved first-party congressional sources. The scheduler may preflight a hearing, but the capture worker must resolve again from its own network/egress environment immediately before consuming media. Short-lived, signed, cookie-bound, or IP-bound media URLs are never treated as durable source truth.

SSRF/network protections remain mandatory for every automatic fetch and redirect hop. Unknown providers are not automatically fetched merely because they appear on an official page.

## Scheduled capture architecture

Scheduled capture uses one global `PublicHearingCapture` per canonical hearing, enforced by the database uniqueness invariant on `hearing_id`.

The worker model requires:

- durable global jobs containing stable public identifiers only;
- worker-side re-resolution;
- distributed capture leases;
- monotonically increasing fencing tokens;
- bounded retries;
- takeover after lease expiry;
- explicit transcript gaps for interruptions;
- idempotent transcript segment persistence;
- finalization into `COMPLETE`, `COMPLETE_WITH_GAPS`, `FAILED`, `CANCELED`, or `BLOCKED`.

A worker restart or retry must continue the same canonical timeline and must not create another capture or another tenant-specific transcript.

## Durable job boundary

`public_hearing_capture_job` is a global orchestration table. It may contain canonical hearing/capture IDs, due time, lease metadata, bounded error text, and safe control metadata such as `mustReresolve`.

It must not contain:

- `tenantId`
- `clientId`
- client names
- watchlist terms
- private notes
- raw tenant context
- media credentials
- Deepgram API keys
- durable short-lived media URLs

## Committee directory decision

Committee Rooms are keyed from current `CongressCommittee` records, not from hearing rows inside a date window.

Therefore:

- every current parent committee remains selectable even with zero hearings;
- every current subcommittee remains selectable even with zero hearings;
- parent/subcommittee hierarchy comes from `parentSystemCode`;
- committee membership comes from the canonical committee-membership corpus;
- chair/ranking-member labels come from roster titles, never party inference;
- a subcommittee may explicitly inherit its parent source-health observation without creating a fabricated subcommittee `CommitteeSource` row.

## Master Calendar decision

The canonical calendar contract uses:

- `from`, `to`
- `chamber`
- `committee`, `subcommittee`
- `eventType`, `eventStatus`
- `streamState`, `captureState`
- `followState`
- `q`
- `page`, `pageSize`

Compatibility aliases may be accepted during cutover, but the service normalizes them into this vocabulary before querying canonical data.

The canonical response envelope is `{ rows, total, page, pageSize }`. Compatibility aliases may mirror `rows` during migration but must not become a second data model.

## Rollout control

The V2 surface is tenant-gated by the `legiwatchLiveHearingsV2` feature flag and fails closed while tenant feature state is unresolved.

`VITE_LEGIWATCH_LIVE_HEARINGS_V2=false` is an emergency global UI kill switch. It can disable V2, but it cannot enable V2 for a tenant whose feature flag is disabled or unresolved.

`LEGIWATCH_CAPTURE_ALL_PUBLIC_EVENTS` is a separate backend operational control. It defaults off. Production schedule activation and capture-all policy require an explicit deployment/rollout decision; implementation code must not silently enable them.

## Preserved behavior

This decision does not replace or remove:

- Bill Tracker
- existing LegiWatch Settings/watchlists
- browser-assisted tab-audio recording
- existing browser Deepgram/WebSocket capture
- existing hearing-room compatibility routes during cutover

Interactive browser recording and unattended server capture remain distinct modes.

## Consequences

This architecture prevents duplicate congressional media connections and duplicate transcription spend across tenants, gives Committee Rooms stable identities independent of congressional scheduling volume, and makes failures auditable instead of silently presenting missing data as an empty calendar.

The tradeoff is additional global orchestration/state management: source health, resolution outcomes, leases, fencing, retries, and durable jobs must all be maintained as first-class production concerns.
