# Outreach V3 Revised Phase 4 — Target Intelligence

## Scope

Phase 4 adds governed target discovery, profiles, relationship metadata, Campaign Spec selection state, deterministic health/coverage, and target-aware reasoning tools to the existing `engagement-api` runtime.

It does not add the final Outreach UI, context strategy, generation, review, preflight, sending, LangGraph, or a new service.

## Capabilities

Shared capability registry now implements:

- `search_targets`
- `get_target_profile`
- `analyze_relationships`

They are available to both Meri and Outreach consumers through the existing provider-neutral capability layer.

### Search sources

- federal Directory members
- federal Directory staff
- active state legislators
- authorized client people
- authorized Engagement contacts
- existing client-target recommendation cache

Results are explainable recommendations with deterministic target and recommendation references. Nothing is auto-added.

### Profiles

Profiles include source-aware identity, role, contact, jurisdiction, safe personalization facts, warnings, relationship metadata availability, and explicit restricted categories.

### Relationships

Relationship analysis uses authorized client-scoped:

- meeting-attendee metadata
- email-envelope metadata
- open task/commitment metadata

It does not return private email/note bodies.

## Campaign state

Phase 2’s reserved target arrays are activated without changing the Campaign Spec schema-version literal:

- `selectedTargetRefs` now contains canonical server-resolved target snapshots.
- `rejectedRecommendationRefs` contains campaign-local deterministic rejection records.

Context arrays remain closed until the context phase.

Implemented commands:

- `ADD_TARGET_REFS`
- `REMOVE_TARGET_REFS`
- `REJECT_TARGET_RECOMMENDATION`

`ADD_TARGET_REFS` accepts locators, resolves and authorizes them in the command transaction, then supplies canonical snapshots to the pure reducer.

State restore reauthorizes selected targets.

## Reasoning boundary

The OpenAI reasoning gateway receives read-only target tools. It may create a pending proposal, but it cannot apply one.

A proposed target locator must appear in an explicitly referenced Capiro target tool result. Invented or unreferenced target locators are rejected before proposal persistence.

Sponsor context and target audience remain separate. Authorized client-contact discovery does not promote client content into Campaign Spec context or imply representation.

## APIs

Dark target APIs are mounted only in `engagement-api` and require:

```text
OUTREACH_V3_STATE_ENABLED=true
OUTREACH_V3_TARGETS_ENABLED=true
```

Routes:

- target search
- target profile
- relationship analysis
- target coverage

Both flags fail closed by default.

## Explicit nonchanges

- current Outreach v2 unchanged
- current Meetings/Reports/Integrations unchanged
- no web UI
- no new mockup implementation
- no context writes
- no generation/send
- no LangGraph
- no migration
- no new Fargate service
- no production worker/callback/Recall/canonical cutover

## Verification

```bash
pnpm verify:outreach-v3-phase-4
pnpm verify:outreach-v3-phase-4:local -- --sha "$(git rev-parse HEAD)"
```

The DB-free gate runs Phase 3 reasoning regression, dedicated TypeScript, target contracts/capabilities/state/reasoning/architecture tests, API build and diff checks.

The authoritative local gate additionally runs Phase 2 database regression, Phase 3 reasoning local acceptance, and the current Engagement UI local acceptance.

No completion claim is valid without the real markers and retained evidence.
