# Outreach V3 Revised Phase 2 — Input Lock

## Status

```text
PHASE2_EXECUTION_STARTED_BY_OWNER_OVERRIDE
```

## Repository state at branch creation

```text
Repository: neo-capiro/capirov2
Branch: agent/outreach-v3-p2-campaign-state-command-engine
Remote base used: cf0aa80d8d16fbd1e775fc054e8de34570535e23
Source branch: agent/outreach-v3-p1-shared-foundations-gpt56-complete
Phase 1 PR: #822
```

Neo explicitly authorized Revised Outreach Phase 2 implementation to begin on 2026-08-08 rather than continue blocking productive work on duplicate exact-SHA closeout reruns.

The separate Phase 1 acceptance runner reported a later code SHA `c9ec7e88` with `OUTREACH_V3_PHASE1_DB_FREE_COMPLETE`, but that commit was not addressable through GitHub when this Phase 2 branch was created. The latest pushed Phase 1 head was therefore used as the remote implementation base. This is an explicit execution-base deviation, not a claim that `cf0aa80...` itself produced the later acceptance marker.

When the Phase 1 closeout branch is pushed, compare the final independently accepted Phase 1 head with this base. Documentation/evidence-only drift does not invalidate Phase 2 implementation. Any later Phase 1 product/runtime/schema/security change must be reviewed and incorporated before Phase 2 closeout.

## Reported prerequisite evidence

The owner supplied the following acceptance evidence from the separate execution host:

```text
Phase 3 DB-free:
ENGAGEMENT_PHASE3_DB_FREE_COMPLETE
reported SHA: 876ff03a

Phase 3 deployed-app validation:
PHASE3_DEV_APPROVED
app.capiro.ai normal baseline: 21 requests, zero preview headers
preview read parity: Meetings / Outreach / Reports 200 via engagement-api
security matrix: 401/403 clean
external-action containment: 17/17 routes denied before side effects

Revised Phase 1 DB-free:
OUTREACH_V3_PHASE1_DB_FREE_COMPLETE
reported SHA: c9ec7e88
929 API tests
2060 web tests
cross-cutting safety checks green

Phase 1 independent validation at Phase 2 branch creation:
pending on the separate closeout host
```

This document preserves that distinction. It does not retroactively manufacture an independent verdict.

## Phase 2 architectural lock

Phase 2 is the deterministic campaign-state substrate only:

```text
Campaign Spec V1
immutable state versions
strict command registry
pure reducers
deterministic command engine
append-only event ledger
explicit command proposals
optimistic concurrency
idempotent command batches
derived readiness
```

Explicitly out of scope:

```text
OpenAI Responses API
conversation state
LangGraph / general LangChain agent
final Outreach V3 UI
target recommendation intelligence
context recommendation intelligence
generation
send
canonical Engagement cutover
production callback/Recall/worker transfer
new Fargate service
```

Phase 2 remains in the existing `engagement-api` architecture. Outreach v2 remains unchanged and default.

## Database boundary

Phase 2 is authorized to add additive migration source and rehearsal tooling for:

```text
outreach_sessions
outreach_state_versions
outreach_events
outreach_command_proposals
```

No shared dev or production migration execution is authorized by this work. No destructive DDL or legacy Outreach backfill is allowed.

## Existing reusable foundations

Phase 1 shared boundaries remain authoritative:

- `CapabilityAuthorizationService` for tenant/client/ethical-wall reauthorization;
- shared Capiro capability catalog and result contracts;
- neutral AI credential boundary (not used by Phase 2 state mutation);
- runtime ownership contract;
- existing `engagement-api` bootstrap and shared Aurora/Prisma configuration.

## Phase 2 invariants

1. Conversation/model state is never campaign truth.
2. A session does not require a client.
3. Sponsor and audience remain separate.
4. Every mutation is expected-version scoped.
5. Command batches are atomic and idempotent.
6. Reducers are pure and receive only validated/authorized input.
7. State snapshots and events are append-only.
8. Restore creates a new version; it never moves history backward.
9. Proposal creation never mutates campaign state.
10. Proposal Apply is explicit and reauthorizes references.
11. Future target/context/generation/send commands are discoverable but unsupported.
12. Phase 2 performs zero legacy Outreach dual-writes and zero external provider actions.
13. No persisted wizard/current-stage field is allowed.
