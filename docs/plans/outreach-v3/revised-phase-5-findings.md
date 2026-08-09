# Outreach V3 Revised Phase 5 — Findings Ledger

## Validation posture

Full executable validation is deferred by product-owner instruction so Phases 4, 5 and 6 can be verified together.

Therefore this ledger distinguishes implementation-review findings from executable acceptance findings.

## Closed implementation-review findings

### P1 — context capability tenant envelope mismatch

`research_government` originally returned a null tenant scope even though the shared capability registry requires the result envelope tenant to match the authenticated execution tenant.

Resolution: result envelope now carries `ctx.tenantId` while the underlying government record remains global/public.

Status: closed in implementation.

### P1 — client memory scope could widen when clientId omitted

A sole-client reasoning context could call `search_memory` with a null input client and avoid applying the inherited client filter.

Resolution: capability now inherits `ctx.clientScope`, rejects explicit mismatch, and uses the effective client scope.

Status: closed in implementation.

### P1 — neutral memory search could expose unrelated client-scoped memory

A campaign without a sole client sponsor could search memory with `clientId=null`, which previously behaved as no client filter.

Resolution: null client scope now means `client_id IS NULL` only.

Status: closed in implementation.

### P1 — null context locator behaved as a client wildcard

Memory, Capiro record and document locators previously accepted a null client locator while resolving a client-owned source.

Resolution: context locator client ID is exact, including null. Client-owned records cannot resolve through a tenant-neutral locator.

Status: closed in implementation.

### P1 — private meeting attachment metadata visibility

A tenant member with a document ID could resolve a meeting-linked attachment without rechecking the meeting’s private/shared visibility.

Resolution: meeting-linked documents require the meeting to be shared or owned by the requesting user.

Status: closed in implementation.

### P1 — direct context APIs lacked campaign sponsor check

The reasoning layer constrained client-specific context, but direct Phase 5 context APIs did not independently require the requested client to be the campaign’s sole explicit sponsor.

Resolution: `searchMemory` and `getDocument` now enforce the same nonleaking sponsor rule before capability execution.

Status: closed in implementation.

### P1 — command-engine test harness missing context dependency

Phase 5 added `OutreachContextReferenceService` to the command engine constructor while the existing test harness still constructed the four-dependency Phase 4 service.

Resolution: test harness now supplies target and context resolvers and includes acceptance/restore/sponsor-isolation cases.

Status: closed in implementation.

## Deferred executable findings

The following are intentionally **not assessed yet**:

```text
TypeScript project result
focused Jest result
API production build
exact-head local harness
Phase 2 database regression on Phase 5 head
Phase 3 reasoning regression on Phase 5 head
current Engagement UI regression on Phase 5 head
independent reviewer P0/P1/P2 classification
```

They must be executed in the combined Phase 4-6 verification pass.

## Current severity statement

Implementation review has no known unresolved P0/P1 code finding at handoff time.

This is not equivalent to a verified `P0=0/P1=0/blocking-P2=0` acceptance result. That result is reserved for the combined verification pass.
