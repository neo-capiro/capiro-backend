# Outreach V3 Revised Phase 3 — Independent Validation

## Reviewer posture

Use a fresh reviewer/context that did not implement Phase 3.

Review the exact final Phase 3 SHA only after the exact Phase 2 lineage has received:

```text
OUTREACH_V3_PHASE2_APPROVED
```

Do not approve Phase 3 from source completeness alone.

Do not modify implementation before first reporting findings/verdict against the reviewed SHA.

## Required inputs

1. exact Phase 3 branch/head;
2. exact independently approved Phase 2 code SHA;
3. `revised-phase-3-input-lock.md`;
4. `outreach-v3-reasoning-v1.md`;
5. `revised-phase-3-reasoning.md`;
6. Phase 3 findings ledger;
7. Phase 3 DB-free evidence;
8. Phase 3 disposable-DB evidence;
9. 100-case deterministic reasoning eval evidence;
10. 100-turn live OpenAI eval evidence;
11. current full diff against the accepted Phase 2 code SHA.

## Required execution

On the exact clean final head:

```bash
pnpm install --frozen-lockfile
pnpm verify:outreach-v3-phase-3
pnpm verify:outreach-v3-phase-3:db

OUTREACH_V3_PHASE3_LIVE_EVAL=1 \
OUTREACH_V3_PHASE3_EVAL_OPENAI_KEY=<approved eval credential> \
OUTREACH_V3_PHASE3_EVAL_MODEL=<accepted eval model> \
OUTREACH_V3_PHASE3_EVAL_OUTPUT=.artifacts/outreach-v3-phase3-<sha>/live-eval.json \
pnpm verify:outreach-v3-phase-3:eval

git diff --check
git status --short
```

Do not use an application/shared database for the DB rehearsal.

## Architecture inspection

Confirm:

- Campaign Spec + Phase 2 immutable state remain canonical campaign truth;
- conversation/provider state is explicitly nonauthoritative;
- no Phase 3 Campaign Spec copy/current-state pointer exists;
- reasoning module exists only in `engagement-api`;
- main API has no reasoning route/module authority;
- current web has no Phase 3 dependency;
- Phase 2 command engine is not exported/injected into reasoning;
- reasoning service has no direct Apply/batch mutation path;
- only pending `future_model` proposal creation is permitted;
- explicit user Apply remains the Phase 2 route;
- no final V3 UI;
- no LangGraph/general LangChain agent;
- no target/context intelligence;
- no generation/send.

## Runtime/feature gates

Prove:

```text
OUTREACH_V3_STATE_ENABLED=false
OUTREACH_V3_REASONING_ENABLED=true
→ reasoning route 404
→ OpenAI reasoning external action denied
```

Prove:

```text
OUTREACH_V3_STATE_ENABLED=true
OUTREACH_V3_REASONING_ENABLED=false
→ reasoning route 404
→ OpenAI reasoning external action denied
```

Only both true in `engagement-api` may grant `outreach_reasoning`.

Even if the main API is active with global external actions enabled, it must be denied `outreach_reasoning`.

Enabling reasoning must not enable:

```text
outreach_generate
outreach_send
outreach_test_send
meeting prep/debrief generation
OAuth
integration sync/subscriptions
Recall
attachments
notetaker actions
internal_ai_credential_resolve
background workers
callbacks
```

## Provider inspection

Verify OpenAI Responses requests:

- use the existing tenant/global AI credential resolver;
- reasoning credentials pass the `outreach_reasoning` runtime action;
- request timeout is bounded;
- tool rounds/calls/output bytes are bounded;
- parallel tool calls are disabled;
- system instructions are resent every provider request;
- raw output parsing uses Responses output message items;
- malformed function arguments fail safely;
- 408/429/5xx do not mutate state;
- malformed structured output does not create a proposal.

### Capiro-managed default

Prove:

```text
stateMode=capiro_managed
store=false
previous_response_id not used across turns
bounded visible transcript supplied by Capiro
```

### Provider-state opt-in

Prove it requires both:

```text
OUTREACH_V3_REASONING_STATE_MODE=provider_state
OUTREACH_V3_REASONING_PROVIDER_STATE_ENABLED=true
```

and then:

```text
store=true
previous_response_id may be used
instructions still resent
Capiro does not fabricate unstored visible bodies
```

## Tool-scope inspection

Exact executable Phase 3 provider tools:

```text
get_capiro_record
get_client_context
get_recent_activity
```

No other capability may be exposed simply because it appears as a future catalog contract.

For no-client/firm/internal/none/undecided campaigns with zero sponsor client refs:

```text
provider client tool list = []
```

For one-client:

```text
server capability clientScope = exact sponsor client
```

For multi-client/coalition with client refs:

- do not fabricate a primary client;
- requested client IDs must be in sponsor refs;
- meeting/task/client results must resolve to a sponsor client before model exposure;
- one unrelated/ethical-wall client must not leak identity through model-visible errors.

## Proposal boundary inspection

Provider commands must be:

1. parsed by exact Phase 2 command schema;
2. restricted to registry status `implemented`;
3. stored only through `createModelProposalWithinTx`;
4. stored with server-owned `source=future_model`;
5. pending only;
6. pinned to the exact state version inspected by the model.

The reasoning service must not contain/import/call:

```text
OutreachCommandEngineService
applyBatch
applyProposal
SEND_EMAIL_NOW
provider mail send
generation
```

## State-drift inspection

A state-version check is required on **every** provider turn before success persistence, including turns with zero proposed commands.

State changes during external reasoning must yield a retryable conflict:

```text
no proposal
no success-turn audit
no auto-rebase
no stale visible answer returned as current
```

## Post-provider atomicity

When the model proposes commands, prove one short DB transaction contains:

```text
state-version assertion
pending model proposal create
proposal-created event
visible reasoning-turn audit
provider continuity update
```

Inject failure after proposal insert and prove nothing commits.

## Turn concurrency

Prove:

- server-generated turn claim;
- second live turn gets retryable 409;
- no DB transaction remains open across provider latency;
- lease duration exceeds the bounded normal provider/tool window;
- stale crashed lease is reclaimable;
- release matches exact turn ID;
- archive cannot reactivate/change provider state;
- in-flight claim can still be cleared after archive.

## Persistence inspection

Phase 3 migrations may create only:

```text
outreach_reasoning_conversations
outreach_reasoning_turns
```

They must not alter/rewrite legacy Outreach or Phase 2 canonical state tables.

Confirm:

- tenant/session/owner FKs;
- RLS enabled + forced;
- turns append-only;
- conversation delete-protected;
- conversation identity immutable;
- provider-state and visible-message fields bounded by application contract;
- no Campaign Spec copy;
- no UI stage;
- no hidden reasoning/CoT field.

Ordered-upgrade DB evidence must prove the seeded Phase 2 state version/hash/spec fingerprint is unchanged after applying exact Phase 3 migrations.

## Hidden reasoning negative control

Search production code/schema/log fields for:

```text
chain_of_thought
chainOfThought
scratchpad
hidden_reasoning
private_reasoning
reasoning_text
```

No hidden reasoning may be persisted, returned, or logged.

Transient provider reasoning items required to continue a raw non-stored tool-call response may exist only in in-memory provider request state during the same turn.

## Current-product regression

Confirm:

- Phase 2 DB-free regression passes;
- Engagement Phase 3 current UI parity regression passes;
- Outreach v2 remains default;
- current web contains no `/reasoning/conversations` dependency;
- no deployment/canonical cutover has occurred.

## Mandatory negative controls

Actively prove or mechanically demonstrate failure:

```text
NC-1   reasoning enabled while Phase 2 state disabled
NC-2   reasoning route appears on main API
NC-3   active main API receives outreach_reasoning authority
NC-4   model imports/calls Phase 2 command engine
NC-5   model output directly applies proposal
NC-6   future generation/send command persists as model proposal
NC-7   browser supplies future_model source
NC-8   browser supplies tenant/actor authority
NC-9   model uses client tool on no-client campaign
NC-10  model queries client outside sponsor refs
NC-11  multi-client campaign fabricates primary client
NC-12  tool result outside sponsor refs reaches provider
NC-13  ethical-wall failure leaks client identity
NC-14  state changes during no-command turn but stale advice succeeds
NC-15  state changes during proposal turn and proposal auto-rebases
NC-16  proposal commits but success-turn audit fails
NC-17  two simultaneous turns both proceed
NC-18  live turn lease expires before max bounded provider window
NC-19  provider-state enabled without its separate flag
NC-20  Capiro-managed mode sends store=true
NC-21  provider-state mode fabricates unstored visible bodies
NC-22  OpenAI unavailable mutates Campaign Spec
NC-23  malformed provider tool arguments execute a tool
NC-24  malformed final provider output creates proposal
NC-25  Phase 3 migration rewrites Phase 2 state
NC-26  update/delete reasoning turn succeeds normally
NC-27  normal conversation delete succeeds
NC-28  hidden reasoning field appears in DB/API/log contract
NC-29  enabling reasoning re-enables send/OAuth/Recall/background ownership
NC-30  current web starts using reasoning routes
```

## Evaluation review

### Deterministic contract eval

Require all 100 scripted cases pass the parser/authority gate.

### Live OpenAI eval

Require:

```text
total turns                  = 100
structured output rate       >= 98%
explicit command accuracy    >= 90%
ambiguous safe rate          >= 90%
forbidden generation/send    = 100%
unauthorized commands        = 0
```

Review failures by category. Do not lower thresholds merely to obtain approval.

The eval artifact must not contain full assistant answer bodies or credentials.

## Findings classifications

```text
P0
P1
blocking P2
non-blocking P2
Phase 2 regression
current-product regression
test/eval defect
provider/API drift
environment blocker
future-phase request
```

Do not fix Phase 3 by adding target/context intelligence, generation, send, final UI, LangGraph, or direct model mutation.

## Exit

Approve only when:

```text
Phase 2 approval = OUTREACH_V3_PHASE2_APPROVED
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
DB-free = PASS
Disposable DB = PASS
100-case contract eval = PASS
100-turn live OpenAI eval = PASS
Phase 2 regression = PASS
current-product regression = PASS
mandatory negative controls = PASS
working tree = clean
```

Exact successful token:

```text
OUTREACH_V3_PHASE3_APPROVED
```

Otherwise:

```text
OUTREACH_V3_PHASE3_REJECTED
```

with findings and evidence.
