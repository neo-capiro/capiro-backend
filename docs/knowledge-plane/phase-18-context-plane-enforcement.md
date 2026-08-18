# Knowledge Plane Phase 18 — Context Plane Enforcement

## Status

Phase 18 establishes the shared Context Plane as the **only supported architecture for context-aware AI operations**.

This phase does **not** claim that Meri, Outreach, Workspace, LegiWatch, CRM, Meetings, or Strategies have already completed their product-specific cutovers. Those migrations remain Phases 19–25. Instead, Phase 18 makes the boundary enforceable now:

1. every context-aware operation has a stable registration;
2. a future/new operation is `packet_required` by default;
3. a legacy operation may continue only under an explicit, reviewed, phase-bounded migration exception;
4. an expired exception fails closed;
5. packet-required operations use the Phase 15 → 17 pipeline;
6. the existing ContextPacket release switch is the only rollback path;
7. every allow/deny/rollback/exception decision is written to the existing audit ledger with bounded metadata.

## Architectural invariant

> All dependent product surfaces obtain context through the shared Context Plane.

For a packet-required operation, the supported path is:

```text
registered operation
  → Universal Context Resolver / Retrieval V2 (Phase 15)
  → Five Context Layers (Phase 16)
  → Coverage-aware ContextPacket V2 (Phase 17)
  → reasoning consumer
```

`ContextPlaneGatewayService` is the application boundary for that flow. It does not import Retrieval V2 directly, an embedding provider, a model provider, or a feature-specific RAG implementation.

## Registered operation inventory

The Phase 18 registry is `apps/api/src/context/context-plane-operation-registry.ts`.

| Operation | Product | Packet surface | Legacy owner through | Adoption phase |
| --- | --- | --- | --- | ---: |
| `meri.chat` | Meri | `chat` | explicit migration exception | 19 |
| `meri.research` | Meri | `research` | explicit migration exception | 19 |
| `research.generate-report` | Research/report generation | `research` | explicit migration exception | 19 |
| `outreach.generate` | Outreach | `outreach` | explicit migration exception | 20 |
| `workspace.generate` | Workspace generation | `workspace-gen` | explicit migration exception | 21 |
| `workspace.editor-assist` | Workspace editor | `workspace-editor` | explicit migration exception | 21 |
| `legiwatch.generate-report` | LegiWatch | `memo` | explicit migration exception | 22 |
| `crm.fill-with-meri` | CRM | `research` | explicit migration exception | 23 |
| `meetings.prep-debrief` | Meetings | `memo` | explicit migration exception | 24 |
| `strategies.generate` | Strategies | `strategy` | explicit migration exception | 25 |

There is no wildcard registration and no indefinite exception. The core validator rejects wildcard ids, missing review metadata, duplicate operation ids, and any migration target at or before Phase 18.

## Rogue-retrieval / duplicate-context audit

Phase 18 audited the product areas named by the master plan and found the expected transitional architecture: several surfaces already use pieces of the governed Context Compiler, but still own feature-specific orchestration/retrieval paths that must be retired in their adoption phase.

### Meri / research / report generation — Phase 19

Concrete audited paths include:

- `apps/api/src/meri/meri.service.ts`
- `apps/api/src/meri/meri-tools.service.ts`
- `apps/api/src/meri/meri-research.service.ts`
- `apps/api/src/meri/governed-meri-research.factory.ts`
- `apps/api/src/meri/meri-docgen.service.ts`
- `apps/api/src/meri/meriv3-runtime.proxy.ts`

`MeriModule` already imports `ContextModule` and injects `ContextCompilerService` into governed research wiring, which is useful migration substrate, but the Meri module still owns its research/tool/runtime orchestration. Phase 19 must change Meri from partial/direct compiler use to the full Resolver → Retrieval V2 → ContextPacket path.

### Outreach — Phase 20

Concrete audited paths include:

- `apps/api/src/engagement/engagement-ai.service.ts`
- `apps/api/src/engagement/generation/**`
- `apps/api/src/engagement/outreach-job.service.ts`

`EngagementModule` already imports `ContextModule` and contains context-aware governance around generation, but it also owns an Outreach-specific generation stack (`EvidencePacketService`, `MessagePlanService`, `GenerationGatewayService`, etc.). Phase 20 determines which of those components remain product reasoning/verification and removes any independent context-retrieval responsibility.

### Workspace — Phase 21

Concrete audited paths include:

- `apps/workspace/**`
- `apps/api/src/workspace-assistant/workspace-assistant.service.ts`
- `apps/api/src/workspace-assistant/meriv2-orchestrator.client.ts`

The editor module already imports `ContextModule`, but it still owns document-scoped orchestration and an orchestrator client. Phase 21 moves document generation/editor assistance to governed ContextPackets without creating a Workspace-only knowledge store.

### LegiWatch / intelligence reports — Phase 22

Concrete audited paths include:

- `apps/api/src/intelligence/alert-memo/**`
- `apps/intel-api/**`

Legislative systems remain authoritative for legislative facts. Phase 22 replaces any report-specific context assembly with Context Plane consumption; it does not move authoritative legislative facts into memory.

### CRM / Fill with Meri — Phase 23

Concrete audited path:

- `apps/api/src/clients/**`

Phase 23 adopts canonical identity + Context Plane context for enrichment while keeping AI-generated fields distinguishable from authoritative/source-backed fields.

### Meetings — Phase 24

Concrete audited paths include:

- `apps/api/src/engagement/engagement-ai.service.ts`
- `apps/api/src/engagement/notetaker/**`
- `apps/api/src/meeting-capture/**`

Phase 24 routes prep/debrief context through the shared layer and resolves participants canonically where possible.

### Strategies — Phase 25

Concrete audited paths include:

- `apps/api-strategy/src/context/**`
- `apps/api-strategy/src/agents/**`
- `apps/api-strategy/src/meri/**`

The strategy service has its own context/document and agent surfaces. Phase 25 migrates their context acquisition to governed ContextPackets while retaining strategy reasoning in the strategy product.

## Migration-exception semantics

A Phase 18 migration exception is **not** a hidden bypass. It must have:

- one exact operation id;
- one target adoption phase;
- a written reason;
- the reviewed `knowledge-plane-phase-sequence` approval basis;
- concrete legacy implementation paths.

At `currentPhase >= targetPhase`, the exception becomes invalid automatically. This makes the Phase 19–25 work executable debt rather than permanent architecture.

When an exception is active, the gateway exits **before retrieval**. It does not partially query the Context Plane and then fall back to a legacy stack, because such hybrid behavior would make coverage/completeness unknowable.

## Packet-required enforcement

Once an operation is converted from `migration_exception` to `packet_required`:

1. unregistered operation → deny;
2. packet/resolver surface mismatch → deny;
3. tenant/actor envelope mismatch → deny;
4. run `ContextResolverService.resolveAndRetrieve(...)`;
5. run `ContextPacketV2Service.compile(...)`;
6. `enforce` mode requires a V2 packet;
7. `off` / `shadow` may return V1 only as the existing audited release-switch rollback;
8. write the enforcement decision to `audit_logs`;
9. only then return context to the reasoning consumer.

No second Context Plane release flag is introduced in Phase 18.

## Audit contract

`ContextPlaneAuditService` writes bounded metadata to the existing tenant-scoped `audit_logs` table. It records:

- Phase number;
- operation id / product;
- resolver and packet surfaces;
- allow/deny reason;
- rollout mode;
- migration exception id / target phase;
- packet version / id / trace hash / persistence state;
- retrieval completeness / stop reason.

It does **not** store:

- prompts;
- model responses;
- retrieval payload bodies;
- memory bodies;
- document/mail bodies;
- evidence excerpts.

Audit failure is fail-closed at the enforcement boundary.

## What Phase 18 intentionally does not do

Phase 18 does not:

- perform the Phase 19 Meri product cutover;
- perform the Phase 20–25 product migrations;
- delete product reasoning or verification logic that is not itself a context-retrieval stack;
- apply the Phase 17 database migration in production;
- provision AWS or NVIDIA infrastructure;
- re-embed data;
- start historical mailbox backfill;
- create ContextPacket V3;
- create a second retrieval gateway or feature-specific knowledge database.

## Acceptance criteria

Phase 18 is complete when tests freeze these rules:

- future operations are governed-packet-required by default;
- unregistered operations fail closed;
- wildcard/indefinite exceptions are impossible;
- exception expiry is automatic at the owning adoption phase;
- the named product families are explicitly inventoried;
- packet-required operations can only reach context through Resolver → ContextPacket V2;
- enforce mode refuses V1 for a packet-required operation;
- off/shadow remains the sole rollback path;
- tenant/actor/surface mismatches fail before retrieval;
- enforcement decisions are tenant-scoped and auditable;
- audit storage is bounded and contains no context bodies;
- no Phase 19–25 cutover is falsely claimed.

## Next checkpoint

After Phase 18, perform the dedicated **AWS / database deployment-readiness checkpoint** before Phase 19. That checkpoint should inventory Knowledge Plane migrations against Aurora, apply missing migrations in staging/disposable Postgres first, verify pgvector/tables/indexes/RLS/ethical walls/exact lexical indexes, deploy the current API, and run Retrieval V2 + ContextResolver smoke tests before broad adoption.
