# Outreach V3 Reasoning V1 Contract

## Purpose

Revised Outreach Phase 3 adds a thin reasoning layer over the deterministic Phase 2 Campaign State substrate.

The invariant is:

```text
reasoning may inspect and propose
reasoning may never directly mutate campaign state
```

Campaign Spec + immutable state versions remain canonical business truth.

## Authoritative versus nonauthoritative state

Authoritative:

```text
outreach_sessions
outreach_state_versions
outreach_events
outreach_command_proposals
```

Nonauthoritative reasoning continuity:

```text
outreach_reasoning_conversations
outreach_reasoning_turns
OpenAI response IDs when provider-state mode is explicitly enabled
```

Conversation/provider state may be lost without changing campaign truth.

## Runtime

Reasoning runs only in the existing `engagement-api` process.

```text
OUTREACH_V3_REASONING_ENABLED=false   # default
```

Disabled reasoning routes return 404.

The runtime policy contains one special external action:

```text
outreach_reasoning
```

It is allowed only when:

```text
serviceName == engagement-api
AND OUTREACH_V3_REASONING_ENABLED == true
```

It is denied in the main API even when the main API's general external actions are enabled.

This exception does not enable generation, send, OAuth, Recall, attachment I/O, subscriptions, workers, callbacks, or other external actions.

## Provider abstraction

`OutreachReasoningProvider` owns provider transport only.

V1 provider:

```text
openai
```

OpenAI uses the Responses API over HTTPS and the existing shared `AiCredentialResolverService`.

Do not duplicate tenant BYOK/global-key policy.

Provider credentials are resolved through the reasoning-specific runtime action rather than the broad internal-AI action.

## Retention modes

### `capiro_managed` — default

```text
OpenAI store = false
provider response ID is not used for cross-turn continuity
Capiro persists visible user/assistant text needed for continuity
bounded visible transcript is supplied explicitly on later turns
```

This is the default until a separate customer/organization data-control decision explicitly enables provider-managed state.

### `provider_state` — separate opt-in

Requires both:

```text
OUTREACH_V3_REASONING_STATE_MODE=provider_state
OUTREACH_V3_REASONING_PROVIDER_STATE_ENABLED=true
```

Behavior:

```text
OpenAI store = true
previous_response_id may provide provider continuity
provider response references may be stored outside Campaign Spec
Capiro does not fabricate unstored visible message bodies
```

Provider response IDs are audit/continuity references only. They are never campaign identity or version authority.

## Instructions

Instructions are supplied on every provider request.

They include:

- current canonical Campaign Spec;
- current state version + spec hash;
- derived readiness/blockers;
- implemented Phase 2 command vocabulary;
- executable read capability vocabulary;
- no-send/no-generation/no-hidden-authority rules.

No model response may replace these server-owned inputs.

## Read tools

Phase 3 exposes only read capabilities actually implemented and registered for the Outreach surface at its base:

```text
get_capiro_record
get_client_context
get_recent_activity
```

Not executable in Phase 3:

```text
search_memory
research_government
analyze_relationships
search_targets
get_target_profile
any generation/send/write capability
```

`CapabilityRegistry` is the execution boundary.

The server constructs `AuthorizedCapabilityContext` from authenticated tenant/user context and Campaign Spec scope.

A model may request a narrower record/client. It cannot submit tenant, actor, role, impersonation, or trusted scope authority.

For an exact one-client sponsor, the capability context is narrowed to that client.

For multi-client/coalition/no-client campaigns, Capiro does not fabricate a primary client. Any client-specific tool request is individually reauthorized by the shared capability.

Capability denials are collapsed to safe model-visible tool failure and do not leak ethical-wall or inaccessible-record identity.

## Tool budgets

Per reasoning turn:

```text
provider/tool rounds        <= 6
total tool calls            <= 16
one serialized tool output  <= 96 KiB
```

Parallel tool calls are disabled in V1.

The turn lease is 15 minutes, longer than the maximum normal bounded provider window. A crashed worker's stale claim can eventually be reclaimed.

## Reasoning input

Public turn input:

```json
{
  "message": "visible user text"
}
```

No public field can set:

```text
tenantId
actorUserId
source
expectedStateVersion
provider response ID
proposal status
approval status
send authority
```

User message length is bounded to 16,000 characters.

## Provider output

Provider result is server-parsed into:

```text
assistantMessage
proposedCommands[]
openQuestions[]
referencedToolResults[]
providerResponseRef
usage
```

Visible assistant message is bounded to 24,000 characters.

At most 20 command proposals are allowed per turn.

Every proposed command is re-parsed through the exact Phase 2 command schema.

The Phase 3 gateway additionally refuses every command whose Phase 2 registry status is not `implemented`.

Therefore a provider cannot activate later-phase vocabulary merely because Phase 2 registered that vocabulary as `future`.

## Proposal-only mutation boundary

The reasoning layer receives `OutreachCommandProposalService` but not an exported `OutreachCommandEngineService`.

The only model-origin write is:

```text
createModelProposalWithinTx(...)
```

It:

- uses authenticated tenant/user;
- locks the owner session;
- requires the exact state version inspected by the model;
- stores `source=future_model` server-side;
- writes a normal pending Phase 2 proposal;
- appends a proposal-created event;
- does not apply commands.

The reasoning service has no `applyProposal()` or `applyBatch()` dependency.

Explicit user Apply remains the existing Phase 2 proposal route and reauthorizes references at Apply time.

## State drift during reasoning

External model/tool work runs outside a database transaction.

After the provider returns, one short transaction performs:

```text
optional future_model proposal create
proposal-created event
visible reasoning-turn audit
provider-reference update
```

The proposal requires the state version the model actually inspected.

If campaign state advanced during the model turn:

```text
409
retryable
no proposal
no success-turn audit
no auto-rebase
```

A failure-turn audit may be recorded separately after the authoritative operation fails.

## Conversation concurrency

A server UUID claims the conversation before external reasoning starts.

A second non-stale turn receives a retryable 409.

The claim is released in `finally` and may be cleared after archive without permitting any other archived-row mutation.

No database transaction is held open across provider latency.

## Conversation history

The owner may list bounded reasoning turns.

In Capiro-managed mode, stored visible user/assistant bodies are returned.

In provider-state mode, absent bodies remain null; Capiro does not fabricate history from hashes or hidden provider state.

Tool result references, proposal IDs, questions, usage, latency, and status are bounded audit metadata.

## Persistence

Phase 3 creates only:

```text
outreach_reasoning_conversations
outreach_reasoning_turns
```

It does not alter legacy Outreach or Phase 2 campaign-truth tables.

Conversations carry tenant/session/owner identity and provider continuity metadata.

Turns carry visible/audit metadata and the state version inspected.

No table includes:

```text
Campaign Spec copy
current state pointer
wizard/current UI stage
chain-of-thought
scratchpad
hidden/private reasoning
```

RLS is enabled and forced.

Reasoning turns are append-only.

Conversation delete is protected outside explicit tenant-lifecycle purge.

Conversation identity is immutable.

## Hidden reasoning

Capiro does not request, persist, return, log, or expose hidden chain-of-thought.

Provider-internal reasoning items needed transiently for one raw Responses API tool loop may be forwarded back to the provider during that same non-stored request chain, but they are never written to Capiro's database or exposed to the browser.

## Logging

Allowed operational metadata:

```text
service
release SHA
conversation ID
session ID
state version
provider/model
reasoning effort
provider response reference
proposal IDs/count
read capability names/result refs
usage
latency
safe error code
```

Do not log:

```text
Campaign Spec body
user message body
assistant message body
proposal command body
client names
context bodies
hidden reasoning
API keys
```

## Model-unavailable fallback

If OpenAI credentials/provider access are unavailable:

- reasoning route returns a bounded safe error;
- Campaign Spec remains unchanged;
- deterministic Phase 2 controls remain usable;
- no proposal is fabricated.

## Acceptance gates

Before Phase 3 can be approved:

```text
Phase 2 independently approved
Phase 3 DB-free verifier PASS
Phase 3 disposable DB verifier PASS
100-case deterministic contract eval PASS
100-turn live OpenAI eval PASS
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
fresh independent reviewer approval
```

Phase 3 implementation does not authorize deployment or merge.
