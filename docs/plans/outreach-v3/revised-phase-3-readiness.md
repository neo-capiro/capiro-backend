# Outreach V3 Revised Phase 3 Readiness

## Current verdict

```text
READY_FOR_REVISED_PHASE3: NO
```

Revised Phase 2 implementation is present, but Revised Phase 3 must not begin until the Phase 2 executable and independent gates are real and recorded.

Required before changing this verdict:

```text
OUTREACH_V3_PHASE2_DB_FREE_COMPLETE
OUTREACH_V3_PHASE2_DB_COMPLETE
OUTREACH_V3_PHASE2_FLOW_DB_COMPLETE
Phase 3 regression = PASS
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
Independent validation = OUTREACH_V3_PHASE2_APPROVED
```

A source review, green-looking diff, or documentation-only marker is not a substitute.

## Exact Phase 2 contract Revised Phase 3 will consume

Revised Phase 3 introduces the **thin reasoning gateway + conversation continuity**. It must consume—not replace—the following Phase 1/2 contracts:

### Canonical campaign truth

```text
current Campaign Spec V1
current state version
current spec hash
derived readiness/blockers
immutable version history where explicitly needed
```

The reasoning model may inspect these values. It may not become the source of truth.

### Mutation boundary

The model may produce **strict command proposals** only.

It must use:

```text
OutreachCommandProposalService
Phase 2 command catalog/registry
expectedStateVersion
explicit user Apply
```

It must not:

```text
call OutreachCommandEngineService as hidden model authority
write Prisma/SQL directly
set current_state_version
mutate state-version/event rows
invent command types
silently rebase stale proposals
auto-apply a proposal
```

Direct deterministic UI controls may continue to invoke implemented commands according to the Phase 2 command contract; that path does not require a model.

### Shared read capabilities

Reasoning may use the governed Phase 1 capability layer for read-only Capiro context. It must preserve:

- tenant scoping;
- actor/user scoping;
- client reference reauthorization;
- ethical walls;
- bounded/safe capability errors;
- provenance/exclusions.

The reasoning gateway must not fork client/ethical-wall authorization logic.

### Feature availability

Phase 2 intentionally leaves these unavailable:

```text
target intelligence
context intelligence
generation
preflight/send
```

Phase 3 reasoning must understand readiness blockers and avoid pretending those later capabilities exist. It must not “solve” a future-phase blocker by inventing target/context/send authority.

## Conversation continuity boundary

Phase 3 may add visible conversation/message continuity appropriate to the revised roadmap.

Conversation state must remain separate from Campaign State:

```text
conversation message/history != Campaign Spec
conversation provider id      != state version
model summary                 != state version
```

A lost/recreated model conversation must not lose or alter the campaign. A campaign can be read and deterministically edited without a model conversation.

## Reasoning privacy boundary

Do not persist hidden chain-of-thought.

Allowed future persistence may include user-visible assistant messages, structured command proposals, provider conversation IDs, tool-result metadata and normal audit fields when the Phase 3 plan authorizes them.

Never add a `reasoning`, `chainOfThought`, scratchpad, hidden-thought or equivalent field to Campaign Spec, Phase 2 events or Phase 2 proposals.

## Runtime

Continue using the existing `engagement-api` architecture.

Do not create a new Outreach API/Fargate service merely to host the reasoning gateway unless a separately approved architecture change explicitly replaces this contract.

Current main API/current web/Outreach v2 remain unchanged until their own later cutover/UI phases.

## Phase 2 artifacts Phase 3 must read before implementation

```text
docs/contracts/outreach-v3-campaign-state-v1.md
docs/contracts/outreach-v3-command-protocol-v1.md
docs/contracts/outreach-v3-event-ledger-v1.md
docs/plans/outreach-v3/revised-phase-2-campaign-state.md
docs/plans/outreach-v3/revised-phase-2-findings-ledger.v1.json
docs/runbooks/outreach-v3-state-recovery.md
apps/api/src/outreach-v3/__fixtures__/outreach-v3-command-catalog.v1.json
apps/api/src/outreach-v3/__fixtures__/outreach-v3-readiness-blockers.v1.json
apps/api/src/outreach-v3/__fixtures__/outreach-v3-route-manifest.v1.json
```

## Promotion rule

Only an independently reviewed exact Phase 2 head with `OUTREACH_V3_PHASE2_APPROVED` may become the formal Phase 3 base.

If final Phase 2 closeout commits are documentation/evidence-only descendants of the executable accepted code SHA, record both SHAs explicitly rather than rerunning unrelated expensive suites solely because a handoff file changed.
