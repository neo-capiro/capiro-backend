# Knowledge Plane Phase 16 — Five Context Layers

## Status

Phase 16 formalizes one shared five-layer Context Plane contract between the Phase 15 Universal Context Resolver and the existing Context Compiler. It does not implement ContextPacket V2, broad Meri/Workspace cutover, storage changes, or infrastructure changes.

## Canonical architecture

There are exactly five architectural layers:

| ID | Shared layer | Content class | Canonical contents |
| --- | --- | --- | --- |
| A | `firm-context` | steering | firm identity, firm playbook |
| B | `user-context` | steering | user preferences, profile, voice |
| C | `client-context` | steering | explicitly scoped client steering and client people |
| D | `live-authoritative` | evidence | current authoritative/live Capiro source data, including public/government facts |
| E | `institutional-knowledge` | evidence | private evidence and provenance-bearing institutional knowledge |

`SecurityScope`, `SubjectScope`, FocusEntities, and UI/current-object hints are resolver concepts, not context layers. Meri and Workspace are consumers, not context layers. There is no sixth `external-research` layer.

## Existing SteeringLayer compatibility

Phase 16 does not replace the current curated-memory compiler vocabulary. It nests it under A-C:

- Layer A: `firm-identity`, `firm-playbook`
- Layer B: `user-voice`
- Layer C: `client-steering`, `client-people`
- Layers D/E: no SteeringLayer members; they are factual/evidence inputs

This preserves the existing compiler and packet behavior while giving Retrieval V2 facts a universal architectural home before Phase 17 evolves ContextPacket V2.

## Retrieval V2 mapping

The API owns an exhaustive `Record<RetrievalDomain, EvidenceContextLayer>`. A new Retrieval V2 domain therefore cannot compile until it explicitly chooses D or E.

Layer D currently receives current/live system-of-record domains:

- clients
- contacts
- tasks
- action recommendations
- Program Elements
- LegiWatch/bills
- hearings
- grants
- contracts/opportunities
- federal awards
- directory
- District Nexus

Layer E currently receives private evidence / institutional-history domains:

- mail
- meetings/debriefs
- outreach history
- strategies/work
- institutional knowledge / Temporal Knowledge Graph

This mapping does not change source authority. A retrieval score is still not factual confidence, and a layer assignment is not evidence by itself.

## Resolver → layers → compiler bridge

`ContextLayerService` normalizes two existing contracts into the shared five-layer model:

1. `fromResolution()` maps Phase 15 resolver output and requested Retrieval V2 domains into A-E.
2. `fromCompilerRequest()` maps the existing `ContextRequest.layers: SteeringLayer[]` input into A-C.
3. `bridgeToCompiler()` combines the resolved subject with the legacy compiler request without treating UI context as SubjectScope.

The bridge is deliberately fail closed:

- External/general subject + client open in the UI: client steering is removed from the compatibility compiler request.
- One explicit client subject: Layer C uses that resolved client, never an unrelated UI-selected client.
- Portfolio subject: Layer C retains all resolved client IDs, but the current single-client steering compiler receives no client steering rather than silently narrowing the portfolio to one client.

Phase 17 can replace that compatibility limitation when ContextPacket V2 carries coverage-aware multi-source factual context.

## Acceptance boundaries frozen by tests

Phase 16 tests require:

- exactly A-E / five architectural layers;
- Layer D is `live-authoritative`;
- A-C are steering and D/E are evidence;
- every Retrieval V2 domain maps explicitly to D or E;
- UI context, SecurityScope, and SubjectScope never become layers;
- no Meri-only or Workspace-only layer;
- no sixth external/public research layer;
- resolver output maps deterministically into the five-layer contract;
- the legacy compiler only receives client steering for one explicitly resolved client subject.

## Explicitly out of scope

Phase 16 does not:

- add a Prisma migration or new persistence model;
- add ContextPacket V2 coverage/completeness fields;
- provision AWS or NVIDIA infrastructure;
- re-embed data;
- start historical mailbox backfill;
- migrate Meri or Workspace to the new Context Resolver;
- perform Phase 18 product-wide enforcement.

Those remain later phases in the Knowledge Plane sequence.
