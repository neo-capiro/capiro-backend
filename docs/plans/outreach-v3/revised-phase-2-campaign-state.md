# Outreach V3 Revised Phase 2 — Campaign State + Command Engine

## Current status

```text
IMPLEMENTATION: PRESENT
DB-FREE EXECUTION: PENDING REAL RUN
DISPOSABLE-DB EXECUTION: PENDING REAL RUN
REAL STATE-FLOW EXECUTION: PENDING REAL RUN
PHASE 3 REGRESSION EXECUTION: PENDING REAL RUN
INDEPENDENT VALIDATION: PENDING
SHARED DB MIGRATION: NOT AUTHORIZED / NOT PERFORMED
DEPLOYMENT: NOT AUTHORIZED / NOT PERFORMED
PRODUCTION CHANGE: NONE
```

Do not interpret source completeness as `OUTREACH_V3_PHASE2_APPROVED`.

## Git state

```text
Repository: neo-capiro/capirov2
Branch: agent/outreach-v3-p2-campaign-state-command-engine
Remote base used at branch creation: cf0aa80d8d16fbd1e775fc054e8de34570535e23
Phase 1 PR: #822
```

The owner authorized productive Phase 2 execution while final Phase 1 administrative/independent closeout was still completing. The newer locally reported Phase 1 acceptance SHA was not addressable through GitHub at branch creation. This deviation is recorded in `revised-phase-2-input-lock.md`; it is not retroactive proof that Phase 1 independent validation had already completed.

## Implemented substrate

### Canonical state

- strict `outreach_campaign_spec_v1`;
- no-client blank state;
- explicit nulls / no undefined;
- bounded text/arrays and 1 MiB spec ceiling;
- locale-independent canonical key/set ordering;
- SHA-256 content hash;
- no persisted wizard/current stage;
- no reasoning/chain-of-thought field.

### Persistence

Additive migration creates only:

```text
outreach_sessions
outreach_state_versions
outreach_events
outreach_command_proposals
```

Database invariants include:

- composite session+tenant child identity;
- state-version uniqueness;
- event sequence uniqueness;
- command-batch idempotency uniqueness;
- RLS enabled/forced;
- append-only state versions/events;
- proposal content/terminal lifecycle enforcement;
- explicit runtime privilege narrowing.

The focused Prisma projection lives at `apps/api/prisma/outreach-v3-phase2/schema.prisma`. Runtime state locking/mutations intentionally use explicit tenant/owner-scoped SQL because `FOR UPDATE` and exact audit sequencing are load-bearing.

### Sessions

- create/list/get/archive;
- owner-private;
- no client required;
- initial immutable version 1;
- bounded lists;
- current spec/hash/readiness;
- archive retains history.

### State history / restore

- immutable version reads;
- hash revalidation on read;
- `RESTORE_STATE_VERSION` reauthorizes known client refs;
- restore always creates a new state version;
- no pointer rewind/history rewrite.

### Events / idempotency

- ordered per-session ledger;
- session-row lock protects sequence allocation;
- exactly one durable `command_batch_result` per batch ID;
- normalized payload hash binds idempotency;
- exact retry replays committed result;
- same batch ID/different payload returns conflict.

### Strict commands

Implemented Phase 2 command vocabulary:

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

Future target/context/generation/send-review vocabulary is registered but has no reducer authority and returns `OUTREACH_COMMAND_FUTURE_PHASE`.

### Reducers

Pure deterministic reducer boundary:

- no Prisma;
- no capability runtime;
- no OpenAI/LangGraph;
- no mail/OAuth/Recall/S3/provider dependency;
- no clocks or random IDs;
- explicit no-op detection;
- fail-closed delivery cross-field validation.

### Sponsor authorization

Sponsor supports:

```text
undecided
firm
client
multi_client
coalition
internal_team
none
```

Client refs are strict/deduped and reauthorized inside the same state transaction via the Phase 1 capability authorization boundary. One unauthorized/walled client fails the entire command.

### Command engine

Authoritative mutation order:

```text
strict parse
normalize/hash
lock owner session
idempotency lookup
expected-version compare
load/hash-check current snapshot
authorize all commands
pure reductions in order
validate final state
insert <=1 new version
advance current pointer
append events
supersede old proposals
commit
```

No auto-retry for stale state.

### Proposals

- create does not mutate state;
- strict command/hash storage;
- explicit Apply only;
- stored command hash rechecked;
- Apply uses the same command engine;
- Apply uses a server-owned internal command-batch UUID, not the public proposal ID;
- Apply/state/proposal stamp are one transaction;
- competing old-version proposals are superseded;
- superseded Apply surfaces deterministic stale conflict;
- reject does not mutate state.

### Readiness

Derived from Campaign Spec plus Phase 2 feature availability. No UI stage is persisted.

### API composition

- exact V3 route manifest;
- `OUTREACH_V3_STATE_ENABLED` strict flag;
- default disabled -> 404/fail closed;
- state module imported only by existing `EngagementApiAppModule`;
- main `AppModule` unchanged;
- current web contains no V3 state call/enable flag.

## Verification added

Root commands:

```bash
pnpm verify:outreach-v3-phase-2
pnpm verify:outreach-v3-phase-2:db
pnpm verify:outreach-v3-phase-2:local -- --sha <exact-head>
```

DB-free gate covers:

- focused state/command/service tests;
- proposal lifecycle tests;
- dark flag test;
- architecture/no-provider/no-dual-write static gates;
- shared authorization regression;
- focused TypeScript;
- focused Prisma validation;
- runner syntax;
- Phase 1 ownership/architecture regressions;
- API build;
- diff whitespace.

Disposable DB rehearsal covers:

- fresh full migration chain;
- pre-Phase-2 ordered upgrade;
- real legacy `outreach_records` sentinel preservation;
- RLS through a NOSUPERUSER/NOBYPASSRLS probe role;
- cross-tenant denial;
- composite tenant/session FK;
- append-only history;
- uniqueness/idempotency constraints;
- proposal lifecycle DB invariants;
- narrowed runtime delete permissions.

Real DB state-flow rehearsal covers:

- no-client create;
- goal command + idempotent replay + ID reuse rejection;
- no-op;
- no sponsor;
- criteria/delivery;
- proposal creation without mutation;
- explicit Apply;
- competing proposal supersession/stale Apply;
- two concurrent writers / exactly one winner;
- restore into a new version;
- archive/write denial;
- contiguous event sequence;
- exact version sequence;
- protected legacy table before/after digests.

A dedicated GitHub Actions workflow exists but its result is not green until actual jobs/runs are observed.

## Fixed findings

See `revised-phase-2-findings-ledger.v1.json`.

Current source-review counts:

```text
Open P0: 0
Open P1: 0
Blocking P2: 0
```

These counts do not substitute for executable acceptance.

## Explicit nonchanges

```text
Outreach v2                   unchanged/default
final Outreach V3 UI          not implemented
OpenAI Responses              absent
OpenAI conversation state     absent
LangGraph/general LangChain   absent
Target intelligence           not implemented
Governed context engine       not implemented
Generation                    not enabled
Send                          not enabled
legacy Outreach dual-write    none by architecture contract
new Fargate service           none
canonical Engagement cutover  none
Recall/callback/worker move    none
shared DB migration           not performed
production deployment         not performed
```

## Remaining closeout sequence

1. obtain real `OUTREACH_V3_PHASE2_DB_FREE_COMPLETE` on exact head;
2. obtain real `OUTREACH_V3_PHASE2_DB_COMPLETE`;
3. obtain real `OUTREACH_V3_PHASE2_FLOW_DB_COMPLETE`;
4. run exact-head Phase 2 acceptance runner under the owner browser-acceptance override;
5. run/confirm Phase 3 regression evidence;
6. inspect GitHub CI if available;
7. independent reviewer runs mandatory negative controls;
8. require exact `OUTREACH_V3_PHASE2_APPROVED`;
9. update findings/status with real results;
10. only then mark Revised Phase 3 ready.

No shared migration or deployment is required to obtain code/disposable-DB acceptance.
