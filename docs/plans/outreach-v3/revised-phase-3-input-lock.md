# Outreach V3 Revised Phase 3 — Provisional Input Lock

## Execution status

```text
PHASE3_PROVISIONAL_IMPLEMENTATION_AUTHORIZED_BY_OWNER
FORMAL_PHASE3_ACCEPTANCE: BLOCKED_ON_PHASE2_CLOSEOUT
DEPLOYMENT: NOT AUTHORIZED
```

## Branch and base

```text
repository: neo-capiro/capirov2
branch: agent/outreach-v3-p3-reasoning-gateway
provisional Phase 2 base: 89b0a8e08e1cfcc7210a8684335faf6f8405bdf2
Phase 2 PR: #862
```

The owner explicitly authorized productive Revised Phase 3 implementation while the separate Phase 2 internal/dev dark-deployment acceptance and independent closeout continue.

This is a sequencing override only. It is **not** a retroactive Phase 2 approval. Phase 3 may not be declared accepted, merged, or deployed until the exact Phase 2 lineage receives `OUTREACH_V3_PHASE2_APPROVED` and any required Phase 2 repair is reconciled into this branch.

## Authoritative scope inputs

No dedicated Revised Phase 3 executable plan was available at branch creation. The implementation scope is therefore locked to:

1. `docs/plans/outreach-v3/revised-phase-3-readiness.md` from the Phase 2 branch;
2. the Revised Thin-Reasoning Master Plan (`outreach-v3-thin-reasoning-revised-master-plan.md`);
3. Phase 2 Campaign State / command / event contracts;
4. Phase 1 shared capability and AI-credential boundaries;
5. the current repository implementation where paths or contracts differ from planning-time assumptions.

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

## OpenAI contract

Use the existing shared `AiCredentialResolverService`; do not duplicate BYOK/global credential policy.

Use the Responses API. Provider instructions are supplied on every turn. Provider response IDs never enter Campaign Spec/state versions.

No OpenAI SDK dependency is required if the existing repository's raw-fetch provider style remains simpler and testable.

## Phase 2 reconciliation rule

Before Phase 3 closeout:

1. resolve the final accepted Phase 2 code SHA and docs/evidence SHA;
2. compare them with this provisional base;
3. incorporate every Phase 2 code/schema/security repair that is not already present;
4. rerun affected Phase 3 tests;
5. record both SHAs when later Phase 2 changes are documentation/evidence only.

## Acceptance posture

Phase 3 implementation may proceed now, but these remain impossible until Phase 2 acceptance:

```text
OUTREACH_V3_PHASE3_APPROVED
READY_FOR_REVISED_PHASE4
Phase 3 deployment
```
