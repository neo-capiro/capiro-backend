# Outreach V3 Revised Phase 3 — Input Lock

## Execution status

```text
PHASE3_PROVISIONAL_IMPLEMENTATION_AUTHORIZED_BY_OWNER
PHASE2_DEPLOYED_DARK_BASE: OWNER_ACCEPTED_WITH_CLERK_AUTH_WAIVER
PHASE2_INDEPENDENT_VALIDATION: PENDING
FORMAL_PHASE3_ACCEPTANCE: BLOCKED_ON_REMAINING_ASSURANCE_GATES
DEPLOYMENT: NOT AUTHORIZED
```

## Branch and base

```text
repository: neo-capiro/capirov2
branch: agent/outreach-v3-p3-reasoning-gateway
Phase 2 code base: 89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
Phase 2 PR: #862
Phase 2 deployed image SHA: 89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
```

The owner explicitly authorized productive Revised Phase 3 implementation while Phase 2 acceptance closed in parallel.

The owner later supplied the Phase 2 deployed-dark acceptance report and explicitly chose to **skip Clerk-authenticated live route verification** rather than continue token recovery. That decision is recorded in:

`docs/plans/outreach-v3/revised-phase-2-deployed-dark-owner-acceptance.md`

The Clerk-dependent scenarios are `WAIVED_BY_OWNER / NOT_EXECUTED`; they must never be rewritten as PASS.

The deployed Phase 2 code SHA exactly matches the SHA this Phase 3 branch was created from. Therefore no Phase 2 code/schema reconciliation is required from the supplied deployment result.

A fresh independent Phase 2 approval marker remains a separate assurance gate unless the owner later explicitly waives it. Phase 3 also retains its own DB-free, disposable-DB, live-model-eval, and independent-review gates.

## Authoritative scope inputs

No dedicated Revised Phase 3 executable plan was available at branch creation. The implementation scope is therefore locked to:

1. `docs/plans/outreach-v3/revised-phase-3-readiness.md` from the Phase 2 branch;
2. the Revised Thin-Reasoning Master Plan (`outreach-v3-thin-reasoning-revised-master-plan.md`);
3. Phase 2 Campaign State / command / event contracts;
4. Phase 1 shared capability and AI-credential boundaries;
5. the current repository implementation where paths or contracts differ from planning-time assumptions;
6. the owner-supplied Phase 2 deployed-dark acceptance + Clerk verification waiver recorded above.

## Phase 3 thesis

Phase 3 adds a thin reasoning layer **over** the deterministic campaign substrate.

```text
OpenAI reasoning
  -> server-authorized read tools
  -> visible assistant response
  -> validated structured command proposal(s)
  -> explicit user Apply through Phase 2
```

Campaign Spec/state versions remain authoritative. Conversation/provider state is nonauthoritative.

## Hard implementation boundaries

Phase 3 may implement:

- provider-neutral `OutreachReasoningProvider`;
- OpenAI Responses API as the first provider;
- server-owned conversation continuity;
- reduced-retention / Capiro-managed conversation mode;
- separately gated provider-state continuity;
- Campaign Spec/readiness inspection;
- existing implemented shared Capiro read capabilities;
- structured Phase 2 command proposals;
- explicit proposal IDs returned to the caller for later user Apply;
- visible user/assistant/tool/proposal audit metadata;
- deterministic model-unavailable fallback/status;
- dark reasoning API routes in the existing `engagement-api` only;
- deterministic evaluation fixtures.

Phase 3 must not implement:

```text
final Outreach V3 UI
target/profile/context Phase 7 intelligence
new search-target capabilities
generation
sample generation
full draft generation
preflight
email send
external action tools
direct model state mutation
auto-Apply of model proposals
LangGraph
general LangChain agent executor
new Fargate service
main API cutover
Outreach v2 replacement
production deployment
```

## Mutation authority

The reasoning layer must not import or inject `OutreachCommandEngineService`.

Model-origin changes are persisted only as proposals through the Phase 2 proposal service. A browser/provider cannot set tenant, actor, proposal source, state version pointer, approval status, or send authority.

Direct deterministic UI controls remain a separate Phase 2 path and are outside model authority.

## Read-tool authority

The server creates `AuthorizedCapabilityContext` from authenticated Capiro context and Campaign Spec scope.

Initial executable tools are limited to capabilities actually registered on the Outreach surface at this base:

```text
get_capiro_record
get_client_context
get_recent_activity
```

Planning/catalog-only capabilities are not exposed as executable model tools until their owning phase implements and registers them.

The model may request narrower scope. It may not widen tenant/client scope.

## Conversation retention decision

Until a separate organization/customer data-control approval exists, default Phase 3 provider behavior is:

```text
mode = capiro_managed
OpenAI store = false
```

Capiro-managed mode stores only user-visible conversation content needed for product continuity plus bounded tool/proposal audit metadata. It never stores hidden chain-of-thought.

A future explicitly enabled `provider_state` mode may use OpenAI response continuity and persist provider response references outside Campaign Spec. It must remain nonauthoritative and off by default.

For `store=false` reasoning-model tool loops, encrypted provider reasoning items may be replayed transiently within the same in-flight turn when required by the Responses API contract. They are not persisted, logged, returned to the browser, or treated as Capiro reasoning state.

## OpenAI contract

Use the existing shared `AiCredentialResolverService`; do not duplicate BYOK/global credential policy.

Use the Responses API. Provider instructions are supplied on every turn. Provider response IDs never enter Campaign Spec/state versions.

No OpenAI SDK dependency is required if the existing repository's raw-fetch provider style remains simpler and testable.

## Phase 2 reconciliation result

The owner-supplied deployed-dark report resolves the Phase 2 code lineage as:

```text
final deployed Phase 2 code SHA = 89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
Phase 3 provisional/base SHA     = 89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
code reconciliation required     = NO
schema reconciliation required   = NO
Clerk authenticated live gate    = WAIVED_BY_OWNER / NOT_EXECUTED
```

If Phase 2 receives later code/schema/security repairs, compare those descendants and incorporate them before Phase 3 closeout. Documentation/evidence-only descendants should be recorded separately rather than triggering unrelated expensive reruns.

## Acceptance posture

The Clerk-authenticated Phase 2 live gate is no longer a blocker because the owner explicitly waived it.

These remain required for formal Phase 3 acceptance unless separately and explicitly waived:

```text
fresh independent Phase 2 assurance disposition
Phase 3 DB-free verifier PASS
Phase 3 disposable DB verifier PASS
Phase 3 deterministic 100-case eval PASS
Phase 3 live 100-turn OpenAI eval PASS
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
fresh independent Phase 3 approval
```

Phase 3 implementation does not authorize merge, shared migration, flag enablement, or deployment.
