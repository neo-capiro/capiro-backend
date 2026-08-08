## Purpose

Implement Outreach V3 Revised Phase 2: **canonical Campaign State + deterministic command engine** on the existing `engagement-api` architecture.

This PR intentionally stops before reasoning, targets/context intelligence, generation, send, final V3 UI, or canonical Engagement cutover.

## Branch/base note

```text
Branch: agent/outreach-v3-p2-campaign-state-command-engine
Remote base used at branch creation: cf0aa80d8d16fbd1e775fc054e8de34570535e23
Phase 1 PR: #822
```

Neo explicitly authorized productive Phase 2 execution while final Phase 1 administrative/independent closeout was still finishing. The later locally reported passed Phase 1 SHA (`c9ec7e88`) was not pushed/addressable through GitHub when this branch was created. This deviation is recorded in `docs/plans/outreach-v3/revised-phase-2-input-lock.md`; it is **not** a claim that the independent Phase 1 verdict had already completed at branch creation.

## Current outcome

```text
IMPLEMENTATION: PRESENT
SOURCE-REVIEW OPEN P0: 0
SOURCE-REVIEW OPEN P1: 0
SOURCE-REVIEW BLOCKING P2: 0
DB-FREE EXECUTION: PENDING REAL RUN
DISPOSABLE-DB EXECUTION: PENDING REAL RUN
REAL STATE-FLOW EXECUTION: PENDING REAL RUN
PHASE 3 REGRESSION EXECUTION: PENDING REAL RUN
INDEPENDENT VALIDATION: PENDING
OUTREACH_V3_PHASE2_APPROVED: NOT YET
SHARED DB MIGRATION: NOT PERFORMED
DEPLOYMENT: NOT PERFORMED
```

Do not merge this PR on source completeness alone.

## Implemented

### Canonical Campaign State

- strict `outreach_campaign_spec_v1`;
- no-client blank state;
- normalized/bounded/explicit-null JSON;
- locale-independent canonical ordering;
- SHA-256 state hashing;
- immutable state versions;
- restore creates a new version;
- readiness/blockers derived from state;
- no persisted wizard/current stage;
- no hidden reasoning field.

### Additive persistence

New isolated tables only:

```text
outreach_sessions
outreach_state_versions
outreach_events
outreach_command_proposals
```

Database defenses include:

- tenant/user identity FKs;
- composite child `(session_id, tenant_id)` binding;
- state-version/event-sequence uniqueness;
- command-batch idempotency uniqueness;
- RLS enabled/forced;
- append-only versions/events;
- proposal content + terminal lifecycle immutability;
- explicit runtime privilege narrowing.

No legacy Outreach table is altered or backfilled.

### Deterministic commands

Implemented:

```text
SET_GOAL
SET_OBJECTIVE
SET_TOPIC
SET_DESIRED_OUTCOME
SET_ASK
CLEAR_ASK
SET_WHY_NOW
SET_SPONSOR_SCOPE
SET_TARGET_CRITERIA
SET_DELIVERY_PATTERN
SET_PERSONALIZATION
SET_CAMPAIGN_ANGLE
SET_TONE
SET_LENGTH
RESTORE_STATE_VERSION
```

Future target/context/generation/send-review command names are registered but have no reducer authority and fail with `OUTREACH_COMMAND_FUTURE_PHASE`.

There is no direct-send command.

### Concurrency / idempotency

- every mutation requires `expectedStateVersion`;
- owner session row locked before idempotency/version checks;
- exact batch retry replays durable prior result;
- same batch ID with changed normalized payload returns conflict;
- one stale concurrent writer loses rather than overwriting;
- a changed multi-command batch creates exactly one state version;
- no-op batch creates none.

### Sponsor scope

Supports:

```text
undecided
firm
client
multi_client
coalition
internal_team
none
```

Every sponsor client reference is reauthorized in the same state transaction through the Phase 1 shared capability authorization boundary. One denied/ethical-wall client fails the full command.

### Explicit proposal Apply

- proposal creation does not mutate Campaign State;
- commands are strict/normalized/hash-bound;
- Apply is explicit;
- Apply uses the same authoritative command engine;
- Apply creates a server-owned internal batch UUID;
- state mutation + proposal terminal stamp are atomic;
- competing old-version proposals become superseded;
- stale/superseded proposal cannot auto-rebase;
- reject does not mutate state.

### Dark state API

- exact V3 route manifest;
- strict `OUTREACH_V3_STATE_ENABLED` flag;
- default disabled -> 404/fail closed;
- module imported only by existing `EngagementApiAppModule`;
- main `AppModule` has no V3 state route;
- current web has no V3 state dependency.

## Verification added

```bash
pnpm verify:outreach-v3-phase-2
pnpm verify:outreach-v3-phase-2:db
pnpm verify:outreach-v3-phase-2:local -- --sha <exact-head>
```

The DB-free gate contains focused Jest/TypeScript/Prisma/static architecture checks, Phase 1 ownership/architecture regression and API build.

The disposable PostgreSQL gate proves:

- fresh full migration replay;
- pre-Phase-2 ordered upgrade;
- real legacy `outreach_records` sentinel unchanged;
- RLS/tenant isolation using NOSUPERUSER/NOBYPASSRLS probe role;
- composite tenant/session FK;
- append-only/unique/idempotency constraints;
- proposal DB lifecycle;
- narrowed runtime permissions.

The real DB state-flow rehearsal proves the deterministic lifecycle from blank v1 through commands, proposal Apply/supersession, concurrent writer conflict, restore into v8 and archive; it compares protected legacy-table hashes/counts before/after.

A dedicated GitHub Actions workflow uses no AWS credentials and an ephemeral `pgvector/pgvector:pg16` service.

## Browser acceptance policy

Per owner direction, localhost Clerk/browser acceptance is not the authoritative path. Historical localhost BLOCKED results must not be rewritten as PASS. Browser acceptance is against the deployed Capiro application. The Phase 2 exact-head runner records this explicitly while still executing disposable DB/state-flow and Phase 3 DB-free regressions.

## Fixed implementation findings

See:

`docs/plans/outreach-v3/revised-phase-2-findings-ledger.v1.json`

Notable repaired defects include:

- proposal Apply batch-ID preemption;
- child/session tenant mismatch at DB layer;
- broad-default runtime DB privilege assumptions;
- locale-dependent content hashing;
- semantically invalid sponsor proposal persistence;
- command control-character gaps;
- superseded Apply returning generic rather than stale conflict;
- future command registry reducer-authority enforcement;
- one DB rehearsal fixture defect.

## Explicit nonchanges

```text
Outreach v2                     unchanged/default
final Outreach V3 UI            not implemented
OpenAI Responses API            absent
OpenAI conversation state       absent
LangGraph/general LangChain     absent
target intelligence             not implemented
governed context engine         not implemented
generation                      not enabled
send                            not enabled
legacy Outreach dual-write      prohibited/proved by gates
new Fargate service             none
canonical Engagement cutover    none
Recall/callback/worker transfer none
shared database migration       not performed
AWS deployment                  not performed
```

## Authorization boundaries

This PR does **not** authorize:

- shared dev/staging/production migration;
- engagement-api deployment;
- setting `OUTREACH_V3_STATE_ENABLED=true` in a shared environment;
- canonical cutover;
- production deployment.

Those remain separate decisions.

## Remaining closeout gates

Before approval/merge:

1. real `OUTREACH_V3_PHASE2_DB_FREE_COMPLETE` on exact head;
2. real `OUTREACH_V3_PHASE2_DB_COMPLETE`;
3. real `OUTREACH_V3_PHASE2_FLOW_DB_COMPLETE`;
4. Phase 3 regression PASS;
5. mandatory negative controls;
6. open P0/P1/blocking-P2 = 0;
7. fresh independent reviewer returns exactly `OUTREACH_V3_PHASE2_APPROVED`;
8. clean final handoff.

Revised Phase 3 readiness remains **NO** until those gates are recorded.
