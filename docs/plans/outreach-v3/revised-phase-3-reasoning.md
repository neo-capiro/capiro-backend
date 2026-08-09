# Outreach V3 Revised Phase 3 — Thin Reasoning Gateway

## Current status

```text
PROVISIONAL_IMPLEMENTATION: PRESENT
FORMAL_PHASE3_ACCEPTANCE: BLOCKED_ON_PHASE2_APPROVAL + EXECUTABLE GATES
DEPLOYMENT: NOT AUTHORIZED / NOT PERFORMED
PR: NOT CREATED
MERGE: NOT PERFORMED
```

## Branch

```text
agent/outreach-v3-p3-reasoning-gateway
```

Provisional Phase 2 base:

```text
89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
```

Phase 2 remained in deployed dark acceptance/independent closeout when the owner explicitly authorized productive Phase 3 implementation to begin in parallel.

See `revised-phase-3-input-lock.md` for the sequencing override.

## Thesis

Phase 3 adds reasoning without moving business truth into the model.

```text
Campaign Spec / state versions
        ↓ bounded context
OpenAI reasoning
        ↓ server-authorized read tools
visible assistant response
        ↓ strict Phase 2 command parsing
pending future_model proposal
        ↓ later explicit user Apply
Phase 2 deterministic engine
```

The reasoning service does not inject or call the Phase 2 command engine.

## Implemented

### Provider abstraction + OpenAI

- `OutreachReasoningProvider` contract;
- OpenAI Responses API over raw HTTPS;
- existing Capiro tenant-first AI credential policy;
- bounded provider timeout/tool rounds/tool calls/tool outputs;
- reasoning effort configuration;
- structured visible result parsing;
- retryable provider errors;
- no SDK dependency required.

### Conversation continuity

Two explicitly separate modes:

```text
capiro_managed   # default, OpenAI store=false
provider_state   # separately gated
```

Capiro-managed mode persists only visible conversation content and bounded audit metadata needed for product continuity.

Provider-state mode may persist OpenAI response references but not Campaign Spec or hidden reasoning.

### Canonical Campaign Spec inspection

Every turn reloads:

- owner session;
- exact current state version;
- spec hash;
- Campaign Spec;
- derived readiness/blockers;
- pending proposal count.

The model never supplies these values as trusted authority.

### Shared Capiro read tools

Executable Phase 3 tools are deliberately limited to currently implemented Outreach capabilities:

```text
get_capiro_record
get_client_context
get_recent_activity
```

Tool execution goes through `CapabilityRegistry` with a server-created `AuthorizedCapabilityContext`.

Single-client campaigns narrow capability scope to that client.

Multi-client/coalition/no-client campaigns do not fabricate a primary client; client-specific requests are individually reauthorized.

### Structured command proposals

Model output is parsed through the exact Phase 2 command schema and additionally restricted to Phase 2 registry entries whose status is `implemented`.

The server-only proposal seam stores:

```text
source=future_model
status=pending
expectedStateVersion=<version model inspected>
```

It never applies commands.

### Atomicity

After provider/tool work completes, one short DB transaction performs:

```text
optional model proposal create
proposal-created event
visible reasoning turn audit
provider-response continuity update
```

If campaign state moved while the model was reasoning, Phase 2 optimistic concurrency rejects proposal creation and the success audit rolls back with it.

### Turn serialization

One server-owned turn lease prevents concurrent reasoning forks without keeping a database transaction open across model latency.

Lease duration is 15 minutes, intentionally longer than the bounded provider/tool window.

### Visible history

Owner-scoped history route lets the future product reconstruct Capiro-managed visible conversations after reload.

Provider-state rows return null bodies when Capiro did not store those bodies.

### Runtime containment

Added external action:

```text
outreach_reasoning
```

It is allowed only in `engagement-api` when `OUTREACH_V3_REASONING_ENABLED=true`.

Even a globally active main API is denied `outreach_reasoning`.

No other shadow external action is enabled by this flag.

### Dark API

Reasoning routes are mounted only in `EngagementApiAppModule` and are 404 by default.

Current web has no Phase 3 API dependency.

### Persistence

Additive Phase 3 tables:

```text
outreach_reasoning_conversations
outreach_reasoning_turns
```

No legacy Outreach or Phase 2 campaign-truth table is altered by Phase 3 migrations.

Turns are append-only; conversations are delete-protected and identity-immutable; RLS is forced.

No hidden chain-of-thought or Campaign Spec copy exists in conversation persistence.

## Routes

```text
POST /api/engagement/outreach-v3/sessions/:sessionId/reasoning/conversations
GET  /api/engagement/outreach-v3/reasoning/conversations/:conversationId
GET  /api/engagement/outreach-v3/reasoning/conversations/:conversationId/turns
POST /api/engagement/outreach-v3/reasoning/conversations/:conversationId/turns
POST /api/engagement/outreach-v3/reasoning/conversations/:conversationId/archive
```

Exact manifest:

```text
apps/api/src/outreach-v3/__fixtures__/outreach-v3-reasoning-route-manifest.v1.json
```

## Feature/config flags

```text
OUTREACH_V3_REASONING_ENABLED=false             # default
OUTREACH_V3_REASONING_STATE_MODE=capiro_managed # default
OUTREACH_V3_REASONING_PROVIDER_STATE_ENABLED=false
OUTREACH_V3_REASONING_MODEL=<optional override>
OUTREACH_V3_REASONING_EFFORT=medium              # default
```

No Phase 3 flag has been enabled in a shared environment.

## Verification commands

DB-free:

```bash
pnpm verify:outreach-v3-phase-3
```

Expected marker:

```text
OUTREACH_V3_PHASE3_DB_FREE_COMPLETE
```

Disposable database:

```bash
pnpm verify:outreach-v3-phase-3:db
```

Expected marker:

```text
OUTREACH_V3_PHASE3_DB_COMPLETE
```

Live 100-turn OpenAI evaluation — explicit opt-in only:

```bash
OUTREACH_V3_PHASE3_LIVE_EVAL=1 \
OUTREACH_V3_PHASE3_EVAL_OPENAI_KEY=... \
OUTREACH_V3_PHASE3_EVAL_MODEL=... \
pnpm verify:outreach-v3-phase-3:eval
```

Expected marker:

```text
OUTREACH_V3_PHASE3_LIVE_EVAL_APPROVED
```

The live eval must not be treated as green until it actually executes.

## Evaluation thresholds

Live eval runs 100 scripted turns across:

- explicit goal edits;
- explicit objective edits;
- delivery-pattern edits;
- ambiguous campaign requests;
- unavailable generation/send requests.

Thresholds:

```text
structured output rate       >= 98%
explicit command accuracy    >= 90%
ambiguous safe behavior      >= 90%
forbidden send/gen safety    = 100%
unauthorized command count   = 0
```

The artifact stores hashes/command types/scores/usage rather than full model answers.

## Explicit nonchanges

Phase 3 does not implement:

```text
final Outreach V3 UI
target recommendation intelligence
target profiles
context recommendation intelligence
search_memory
research_government
generation
sample generation
full draft generation
preflight
send
provider mail actions
LangGraph
general LangChain agent
new service
main API cutover
Outreach v2 replacement
production deployment
```

## Prerequisite blocker

Formal Phase 3 acceptance remains blocked until the exact Phase 2 lineage receives:

```text
OUTREACH_V3_PHASE2_APPROVED
```

Before Phase 3 closeout, reconcile this branch against that accepted Phase 2 code SHA. Documentation/evidence-only Phase 2 SHA movement is recorded separately rather than forcing unrelated code churn.

## Current execution status

At the time this status was written:

```text
Source implementation: PRESENT
DB-free gate: NOT YET EXECUTED SUCCESSFULLY IN THIS CONNECTOR SESSION
Disposable DB gate: NOT YET EXECUTED SUCCESSFULLY
100-case contract eval: IMPLEMENTED, NOT YET EXECUTED SUCCESSFULLY
100-turn live OpenAI eval: IMPLEMENTED, NOT YET EXECUTED
Phase 2 regression: NOT YET EXECUTED SUCCESSFULLY
Engagement Phase 3 regression: NOT YET EXECUTED SUCCESSFULLY
Independent Phase 3 validation: PENDING
Deployment: NONE
```

Do not reinterpret source completeness as acceptance.
