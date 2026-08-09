# Outreach V3 Revised Phase 5 — Governed Context + Strategy

## Status

Implementation complete on the Phase 5 branch. Full executable verification is intentionally deferred to the combined Phase 4-6 validation pass at the product owner’s direction.

Base Phase 4 head:

```text
208dae611d9f5636f3b7507f8782ff7cc864c4ed
```

Branch:

```text
agent/outreach-v3-p5-context-strategy
```

## Purpose

Phase 5 makes context and campaign strategy first-class governed Outreach state without allowing the reasoning model to mutate state or perform generation/send actions.

The user/model may discover useful context. Capiro resolves the exact source, authorization, verification class, sensitivity, scope, provenance and evidence/guidance authority. The model may create a pending proposal. Campaign state changes only through the deterministic Phase 2 command engine and normal Apply flow.

## Implemented context classes

```text
required_policy
writing_guidance
campaign_fact
target_specific
group_safe
```

Writing guidance is instruction-only and is never treated as factual evidence.

## Implemented source classes

```text
governed memory item
Capiro client/meeting/task record
Capiro document/attachment
government record
target-profile fact
manual user-supplied context
```

Every accepted context reference carries a deterministic context key and snapshot hash.

## Scope model

```text
campaign
target:<exact selected target key>
group:<explicit group ref>
```

Target-specific context must remain target-specific. Group-safe context must be normal sensitivity and explicitly group-scoped.

## Client isolation

Client-specific context is accepted only for a campaign with one explicit client sponsor matching the source client.

Multi-client, coalition, firm, internal and no-sponsor campaigns remain client-neutral in Phase 5. `clientId=null` means tenant-neutral data, never a wildcard across client data.

Sponsor changes that would leave accepted client-specific context attached to the wrong campaign scope are blocked transactionally.

## Capabilities

Phase 5 promotes these shared capabilities to implemented:

```text
search_memory
research_government
get_document
recommend_outreach_strategy
```

They use the same shared capability registry that serves Meri and Outreach.

### search_memory

- tenant/user scoped;
- exact client or tenant-neutral scope;
- owner-private visibility;
- governed lifecycle suppression;
- ethical-wall enforcement;
- instruction/evidence distinction;
- bounded results/provenance.

### research_government

Searches source-backed Capiro government datasets and returns exact selectable references. It does not invent policy conclusions.

### get_document

Returns bounded governed document metadata/context snapshots, never raw S3 credentials or unrestricted bytes. It preserves private meeting visibility for meeting-linked attachments.

### recommend_outreach_strategy

Deterministic recommendation over canonical campaign counts/state only. It recommends delivery pattern, personalization, tone and length and does not mutate state.

## Commands

Implemented in Phase 5:

```text
ACCEPT_CONTEXT_REFS
EXCLUDE_CONTEXT_REFS
```

Still future-owned:

```text
SET_SENDER_REF
SET_ATTACHMENT_REFS
REQUEST_SAMPLE_GENERATION
REQUEST_FULL_GENERATION
REQUEST_SEND_REVIEW
```

## State behavior

Accepted context is stored in Campaign Spec V1 as immutable resolved snapshots. Excluded context is stored as context-key plus bounded exclusion reason.

Restoring a historical Campaign Spec reauthorizes both target and accepted-context references before the new restore version can commit.

Removing a selected target also removes accepted target-specific context for that target.

Context review re-resolves accepted snapshots and reports:

```text
current
changed
unavailable
```

It never silently rewrites the Campaign Spec.

## Reasoning behavior

Phase 3 reasoning now receives context/strategy read tools when registered and allowed by campaign scope.

The model may propose exact `ACCEPT_CONTEXT_REFS` selections only when those selections came from referenced tool results. Context exclusions must reference existing Campaign Spec context or referenced tool results.

The reasoning service still does not inject or call `OutreachCommandEngineService`.

## Dark API

Runtime:

```text
engagement-api
```

Flags:

```text
OUTREACH_V3_STATE_ENABLED
OUTREACH_V3_CONTEXT_ENABLED
```

Routes are frozen in:

```text
apps/api/src/outreach-v3/__fixtures__/outreach-v3-context-route-manifest.v1.json
```

No current Outreach v2 UI consumes these APIs in Phase 5.

## Readiness

Phase 5 turns `context=true` in the deterministic readiness engine.

Additional blocker:

```text
CONTEXT_HAS_UNVERIFIED_EVIDENCE
```

Generation, drafts and preflight remain unavailable.

## Explicit nonchanges

Phase 5 does not:

- implement final Outreach V3 UI;
- add a new service;
- change current Outreach v2;
- implement draft generation;
- implement draft approval;
- implement preflight;
- implement send;
- add LangGraph/LangSmith;
- add a Prisma migration;
- change AWS ownership/routing;
- enable context in production.

## Verification contract

Permanent commands are scaffolded:

```bash
pnpm verify:outreach-v3-phase-5
pnpm verify:outreach-v3-phase-5:local -- --sha "$(git rev-parse HEAD)"
```

These are intentionally not claimed green in this handoff. They are reserved for the owner-directed combined Phase 4-6 acceptance pass after Phase 6 implementation.
