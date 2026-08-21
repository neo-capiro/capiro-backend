# LegiWatch Live Hearings — Parallel Phase 5/6 Implementation

This change is intentionally additive and was built while Phase 4 capture integration ran in a separate worktree.

## Phase 5 — Live Hearings workspace

The Phase 1 three-section shell now renders a purpose-built Live Hearings surface instead of the legacy Hearing Watch list when `tab=hearings`.

Internal views:

- Master Calendar
- Live Now
- Committee Rooms
- Scheduled Recordings
- My Sessions
- Archive
- Canonical event room
- Persistent committee room

The workspace uses the existing `/legiwatch` route and query-preserving deep links:

```text
/legiwatch?tab=hearings&hearingView=calendar
/legiwatch?tab=hearings&hearingView=event&event=<canonical-hearing-id>
/legiwatch?tab=hearings&hearingView=committee&committee=<committee-id>
```

This avoids changing the top-level router while Phase 2–4 are being integrated. Canonical path aliases can be added later without changing the page components.

### Data contracts

Reads already established by Phase 3:

```text
GET /api/legiwatch/live-hearings/calendar
GET /api/legiwatch/live-hearings/live
GET /api/legiwatch/live-hearings/events/:id
GET /api/legiwatch/live-hearings/events/:id/updates
```

Additional endpoints consumed only by their corresponding views:

```text
GET    /api/legiwatch/live-hearings/events/:id/transcript
GET    /api/legiwatch/live-hearings/events/:id/intelligence
GET    /api/legiwatch/live-hearings/committees/:id
POST   /api/legiwatch/live-hearings/events/:id/schedule
DELETE /api/legiwatch/live-hearings/events/:id/schedule
```

No mock rows are used. A missing optional endpoint yields a truthful unavailable/empty state and does not fabricate a transcript, committee roster, capture, or intelligence card.

### Capture truthfulness

The UI never offers unattended recording merely because an event is public or lives on a `.gov` page.

`Schedule recording` requires all of:

- public proceeding;
- not canceled or completed;
- `SERVER_CAPTURE_ALLOWED`;
- no browser-only, no-public-stream, policy-blocked, or source-error terminal state.

Browser-assisted recording remains available when the official event page is a safe HTTP(S) URL and the proceeding is public. Closed, classified, non-streamed, and canceled events expose neither recording action.

Official links reject:

- non-HTTP(S) schemes;
- executable URLs;
- credential-bearing URLs.

Raw media URLs are intentionally absent from the browser contract.

## Phase 6 — Public intelligence and tenant relevance

The intelligence core establishes two separate rails.

### Global public rail

Input:

- canonical public transcript segment;
- public hearing metadata;
- optional public extractors.

Output:

- questions;
- commitments;
- deadlines;
- funding amounts;
- bill references;
- Program Element references;
- agency references;
- policy positions;
- key quotes.

Deterministic extraction always runs first. Optional extractors run with `Promise.allSettled`; one provider failure cannot suppress deterministic facts.

The global boundary recursively rejects tenant/private fields, including compound names such as:

- `tenantId`
- `clientName`
- `watchlistTerms`
- `delegatedUserId`
- `confidentialNotes`

### Tenant relevance rail

Only after public insights are persisted, a separate processor scores them against tenant-owned client context.

Tenant output may contain:

- tenant id;
- client id/name;
- matched keyword, bill, Program Element, agency, or committee;
- relevance score and rationale.

Tenant matching never mutates or writes back into the global insight object. A tenant-context or tenant-persistence failure cannot roll back public insight persistence.

## Integration seams after Phase 4

The local Phase 2–4 branch should provide concrete adapters for:

```text
PublicHearingTranscriptSegment -> PublicTranscriptSegmentInput
public insight persistence      -> PublicHearingInsightSink
tenant context loading          -> TenantHearingRelevanceContextProvider
tenant relevance persistence    -> TenantHearingRelevanceSink
```

Phase 6 deliberately does not invent new Prisma tables while the canonical Phase 2/4 schema is local-only. If no reusable public insight and tenant relevance tables exist, add those models in a separately reviewed migration during local integration.

## Validation

The delivery package contains:

- standalone Phase 5 structural TypeScript log;
- strict Phase 6 TypeScript log;
- strict Phase 6 test-source TypeScript log;
- executable Phase 5 capture-capability validation;
- executable Phase 6 public/tenant boundary validation;
- Git whitespace checks;
- patch checksums.

Full monorepo Vitest/Jest, browser tests, and API integration tests must run after the patches are applied to the local Phase 2–4 worktree with installed dependencies.
