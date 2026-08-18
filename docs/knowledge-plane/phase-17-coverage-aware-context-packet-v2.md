# Knowledge Plane Phase 17 — Coverage-Aware ContextPacket V2

## Status

Phase 17 extends the existing governed ContextPacket V2 with retrieval truth from the Phase 15 Universal Context Resolver + Retrieval V2, using the five-layer boundary formalized in Phase 16.

It does **not** perform the Phase 18 product-wide Context Plane cutover.

## Required packet truth

A coverage-aware V2 packet now carries:

- `resolvedEntities`
- `subjectScope`
- `coverageManifest`
- `sourceHealth`
- `sourceFreshness`
- `retrievalCompleteness`
- `retrievalStopReason`
- `evidenceRefs`

Existing governance, memory, policy, model, compiler, trace, budget, exclusions, persistence, conflict, and health fields are retained.

## Completeness contract

`retrievalCompleteness` is intentionally three-state:

- `not_requested` — no Retrieval V2 request was planned for this context request.
- `complete` — every requested domain was positively searched with healthy source status, complete pagination, complete source coverage, no unavailable source, no `hasMore`, and no truncation.
- `incomplete` — retrieval was planned but coverage could not prove the above.

### Critical invariant

**Record count is never completeness proof.**

`recordsReturned = 0` can be complete only when the source/coverage contract positively proves the authoritative search completed. If a requested source is missing, unavailable, unauthorized, degraded, errored, unsupported, truncated, partially paginated, or lacks complete coverage, the packet is incomplete regardless of how many other records were returned.

If retrieval was planned but no Retrieval V2 response arrives, Phase 17 creates an explicit incomplete coverage manifest from the planned request: requested domains are retained, searched domains are empty, each requested source is marked unavailable, freshness is unknown, and the stop reason is `retrieval_response_missing`. The packet therefore still records what could not be checked.

Freshness is surfaced independently through `sourceFreshness`. Phase 17 does not invent a global staleness threshold; adapters remain responsible for representing stale/unhealthy source state through their Retrieval V2 source-health/coverage contract. A packet only reaches `complete` when Retrieval V2 itself positively reports healthy complete source coverage.

## Resolver → five layers → packet

`ContextPacketV2Service` performs the Phase 17 assembly boundary:

1. Accept a Phase 15 `ContextRetrievalResult`.
2. Use the Phase 16 `ContextLayerService` bridge so UI focus never becomes SubjectScope.
3. Compile the existing governed memory/steering packet.
4. Preserve V1 output while rollout is off/shadow; Phase 18 owns enforcement.
5. For V2, add coverage-aware retrieval metadata and evidence references.
6. Recompute the packet integrity hash so Phase 17 retrieval truth is covered by `traceHash` / persisted `packet_hash`.
7. Persist the Phase 17 state on the same governed `context_packet` row.

No Meri-specific or Workspace-specific ContextPacket implementation is introduced.

## Evidence handling

Retrieval record payload bodies are **not** copied wholesale into the packet persistence layer.

`evidenceRefs` retain only the bounded identity and provenance needed to trace context:

- retrieval domain
- source record id
- canonical/entity id, type and optional label
- occurred/updated timestamps
- source provenance

Entity-ref metadata and raw retrieval payload bodies are deliberately omitted. This preserves evidence lineage without turning ContextPacket into a duplicate document/mail/data store.

## Persistence

Phase 17 adds one additive migration-owned column to the existing `context_packet` table:

- `retrieval_context_jsonb`

It stores resolved subject/entity metadata, coverage, source health/freshness, completeness and stop reason. Existing packet columns are reused for:

- `evidence_jsonb` — evidence references
- `source_failures_jsonb` — failed/incomplete requested source summaries
- `health_jsonb` — combined governed-memory + retrieval health
- `packet_hash` — final integrity hash including Phase 17 retrieval truth
- `truncated` / `incomplete` — packet-level truth after retrieval assessment

The column is intentionally accessed through tenant-scoped raw SQL at this boundary. The repository already treats SQL migrations as the source of truth for database-only constraints/index behavior on `context_packet`; this keeps Phase 17 additive without creating a second packet table or parallel persistence architecture. The migration must be applied during the post-Phase-18 AWS/database readiness checkpoint before enforcing Phase 17 packets in production.

## Rollout behavior

Phase 17 deliberately preserves current rollback behavior:

- Context Packet rollout `off` / `shadow` continues to return the existing V1 result.
- Coverage-aware V2 output is returned when the existing V2 path is active.
- Phase 17 does not switch Meri, Workspace, Outreach, LegiWatch, CRM, Meetings or Strategies to the new service.
- Phase 18 is responsible for enforcing shared Context Plane consumption across those surfaces.

## Acceptance criteria

Tests freeze these boundaries:

- zero results never imply complete by themselves;
- zero results can be complete after a positively completed healthy authoritative scan;
- planned retrieval with no response preserves the requested domains and is incomplete;
- missing/unavailable/partial sources are incomplete;
- truncation propagates to packet `truncated` and `incomplete`;
- subject/entity resolution and coverage fields survive into V2;
- existing governance/model/trace/memory fields survive unchanged;
- the final packet hash changes with Phase 17 coverage/retrieval truth;
- evidence refs retain provenance but exclude raw retrieval payload bodies and entity metadata;
- unrelated UI client focus cannot leak client steering into an external-subject packet;
- Phase 17 persists on the existing `context_packet` row;
- no ContextPacket V3, second packet table, Meri-only packet, Workspace-only packet, provider-specific knowledge store, or Phase 18 cutover is introduced.

## Explicitly out of scope

Phase 17 does not:

- enforce the Context Plane across product surfaces;
- migrate Meri to the new resolver/packet path;
- provision AWS or NVIDIA resources;
- change embedding/vector infrastructure;
- re-embed the corpus;
- start historical mailbox backfill;
- add a new knowledge graph or event ledger.

Next: **Phase 18 — Context Plane enforcement**, followed by the dedicated AWS/database readiness checkpoint before Phase 19 Meri adoption.
