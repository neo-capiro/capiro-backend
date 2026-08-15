# Knowledge Plane Phase 5 — Meri Compatibility Closeout Delta

## Purpose

This delta does not redesign the Knowledge Plane and does not implement Meri
retrieval. It closes the Universal Entity Resolution requirements that the
shared Context Plane will later consume.

The canonical architecture remains:

```text
source evidence
→ KnowledgeEvent
→ KnowledgeAssertion + KnowledgeEvidence
→ KnowledgeEpisode
→ Temporal Knowledge Graph
→ Retrieval V2
→ ContextResolver / ContextCompiler
→ ContextPacket V2
```

Phase 5 owns trusted identity only.

## Required ordered resolution path

One orchestration path must attempt stages in this order:

```text
existing canonical entity
CRM client / company / person
contacts and exact email
email / official domain
Capiro Directory and known government IDs
SAM / UEI / CAGE
USAspending
LDA
SEC / CIK
official website
public web
model-assisted candidate reconciliation
```

The stages after an internal miss are automatic fallbacks. A consumer must not
need to invoke a special manual “research entity” operation.

## Safety policy

The evidence kind, not a confidence number by itself, controls identity action.

Automatic selection is permitted only for a unique deterministic match such as:

- existing canonical ID;
- exact tenant source ID;
- reviewed mapping;
- verified non-generic email;
- verified official domain for an organization;
- exact authoritative public identifier;
- exact verified alias already bound to one visible canonical entity.

Automatic global-public registration is limited to allowlisted authoritative
public sources and exact public identifiers. Public-web results and model output
are candidate-only. They may never directly:

- create a globally reusable entity;
- merge entities;
- auto-select a canonical entity;
- become factual evidence;
- override conflicting authoritative identifiers.

An exact identifier conflict is a hard stop requiring review. Later fuzzy,
public-web, or model stages cannot “vote it away.”

## Public identity and tenancy

Public identity may be global. Private identity context remains tenant scoped.

```text
GLOBAL
  canonical public organization / person / committee / program identity

TENANT
  private aliases
  mailbox-derived emails
  CRM source IDs
  private corrections
  meetings, relationships, assertions, strategies, and client knowledge
```

No stage may globalize tenant-private relationship knowledge.

## Provider boundary

Phase 5 closeout should expose one provider-neutral fallback contract. Provider
implementations may use Capiro source tables or approved public lookup services,
but the resolver owns the ordered orchestration and safety policy.

Minimum provider result fields:

```text
stage
source type
source ID / URL
candidate canonical name
entity type
candidate aliases
candidate identifiers
source authority
observed timestamp
confidence
exact-vs-inferred evidence kind
```

Provider results must be normalized before they reach the resolver. No provider
may write canonical tables directly.

## Trace and observability

Every complete resolution attempt should report:

```text
attempted stages
stage outcome
candidate entity IDs / candidate labels allowed by scope
selected entity ID, if any
resolution method
confidence
provenance
stop reason
whether public lookup ran
whether human confirmation is required
```

Do not expose inaccessible tenant-private candidates in traces returned to a
caller.

## Required closeout cases

The Phase 5 gate includes the existing deterministic/privacy corpus plus:

1. A non-client external organization resolved by a verified official domain.
2. An external organization absent from internal data that automatically reaches
   public lookup and returns candidate-only results.
3. A misspelled external company that reaches public lookup and model-assisted
   candidate reconciliation but remains ambiguous until corroborated or reviewed.
4. Replay that creates no duplicate canonical entity, alias, or identifier.
5. Public/model fallback that cannot expose another tenant’s private candidate.
6. Conflicting exact identifiers that stop before public/model fallback.

Metrics required before Phase 5 is frozen:

```text
canonical resolution accuracy
alias resolution accuracy
external-company resolution success
candidate recall for public fallback
automatic fallback stage coverage
false merge rate
duplicate entity rate
privacy leakage
cross-tenant leakage
```

Release blockers:

```text
false merges > 0
duplicate entities > 0
privacy leakage > 0
cross-tenant leakage > 0
missing required fallback stages
public/model auto-selection
```

## Phase boundary

Do not implement in Phase 5:

- Meri retrieval or tool routing;
- Semantic Data Catalog;
- Retrieval Planner V2;
- embeddings or reranking;
- mailbox assertion extraction;
- Temporal Knowledge Graph changes;
- ContextResolver or ContextPacket V2;
- production historical backfill.

Phase 6 may consume canonical entity IDs after the Phase 5 resolver is frozen.
