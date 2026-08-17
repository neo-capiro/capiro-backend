# Knowledge Plane Phase 14 — Retrieval Scoring

## Status

Implemented on `agent/knowledge-plane-phase-14-retrieval-scoring`.

Phase 14 formalizes **retrieval priority** across heterogeneous signals without turning those signals into factual truth, evidence quality, or one opaque confidence number.

## Pipeline

```text
authorized source retrieval
  → CoverageManifest proof
  → Phase 14 RRF candidate fusion
  → Phase 13 NVIDIA reranker
  → ranked RetrievalRecord set
  → ContextResolver / ContextPacket (later phases)
```

Coverage remains upstream of both scoring and reranking. Phase 13 remains the final learned relevance stage.

## Reciprocal Rank Fusion

The source signals do not share one meaningful raw numeric scale. Cosine similarity, identity confidence, timestamps, graph depth, authority tiers, and exact-match indicators must not be added directly.

Phase 14 ranks candidates independently within each available signal and combines those ranks with Reciprocal Rank Fusion:

```text
contribution = 1 / (k + signalRank)
```

Default `k=60`; `RETRIEVAL_RRF_K` may override it and is clamped to `1..1000`.

`fusedScore` is **retrieval priority only**. It is never factual confidence.

## Signal vocabulary

```text
lexical_exactness              relevance
semantic_similarity            relevance
entity_match_confidence        confidence
source_authority               authority
freshness                      freshness
graph_relationship_relevance   relevance
client_relevance               relevance
temporal_validity              validity
```

The score trace retains the signal class so relevance, confidence, authority, freshness, and validity remain distinguishable.

## Provider-neutral hints

`RetrievalRecord` may carry optional `retrievalSignals` outside factual `payload` and `provenance`:

```ts
interface RetrievalRecordSignals {
  lexicalExactness?: number;
  semanticSimilarity?: number;
  entityMatchConfidence?: number;
  graphRelationshipRelevance?: number;
  clientRelevance?: number;
  temporalValidity?: number;
}
```

Retrieval rails should populate only signals they genuinely know. Missing values stay missing. Phase 14 does **not** fabricate a semantic/BM25 score because the current Retrieval V2 adapters do not expose one common semantic score field yet.

## Signals derived safely today

- **Exact lexical:** Phase 11 `exactMatchKind` can provide exactness.
- **Entity match:** requested canonical IDs intersecting `record.canonicalEntityIds` are deterministic; canonical resolution records may expose their explicit identity-resolution confidence.
- **Authority:** comes from the Semantic Data Catalog, not a model. Current retrieval-priority tier is system-of-record > derived Knowledge Plane.
- **Freshness:** uses `updatedAt` / `occurredAt` for non-historical queries only.
- **Graph relevance:** shallower graph depth is more relationship-relevant via `1 / (1 + depth)`.
- **Client relevance:** existing authorized client IDs in a retrieved payload may influence priority. This is never authorization.
- **Temporal validity:** `asOf` and bounded-window requests can contribute validity.

A critical invariant is encoded in tests: **graph-edge `confidence` is not entity-resolution confidence**. Factual relationship confidence stays factual metadata.

Freshness is deliberately suppressed for `entity_history`, `relationship_history`, and `temporal_state`; newer is not automatically more relevant when the question is historical.

## NVIDIA boundary

RRF fusion runs first. The resulting candidate order is then passed to `RetrievalRerankerService`.

NVIDIA logits remain observable in the Phase 13 trace but are not inserted back into the initial RRF formula. This avoids assuming provider-native reranker scores are comparable to lexical/vector/entity scales and preserves the master-plan `fusion → reranker` order.

## Shadow-first rollout

`RETRIEVAL_SCORING_MODE` supports:

```text
off
shadow   # default
apply
```

`shadow` computes the full proposed order and decomposition but preserves the existing candidate order. `apply` applies RRF before NVIDIA reranking. Therefore a Phase 14 code merge does not silently change production retrieval ordering.

## Observability

`RetrievalObservability.scoring` exposes:

```text
status
algorithm = rrf
rrfK
candidateCount
scoredCount
applied
signalsUsed
scores[]
```

Each candidate trace includes baseline/current/proposed rank, fused score, source authority, and per-signal `rawValue`, `signalRank`, class, and RRF contribution.

## Coverage, provenance, and security

`CoverageManifest` is built before Phase 14. The scoring layer cannot change source availability, source health, pagination, truncation, completeness, freshness proof, stop reasons, or requested/searched entity counts.

The scoring service does not read or rewrite `record.provenance`; it only permutes the same authorized `RetrievalRecord` objects. Tenant and ethical-wall enforcement remains upstream in retrieval adapters.

## Tests and CI

Phase 14 covers:

- RRF rather than raw heterogeneous-score addition;
- shadow mode preserving existing order;
- explicit apply mode;
- separate relevance/confidence/authority/validity classes;
- graph depth without graph-confidence leakage;
- freshness suppression for historical queries;
- no invented semantic similarity;
- unchanged coverage and provenance identity after scoring;
- coverage before scoring;
- RRF fusion before NVIDIA reranking.

Acceptance workflow: `.github/workflows/knowledge-phase14-ci.yml`.

## Infrastructure impact

Phase 14 is application-code only. It adds no Prisma migration, table, index, pgvector change, vector DB, graph, re-embedding, AWS service, NVIDIA service, or production flag flip. No AWS action is required merely to merge this phase.

## Explicit exclusions

Phase 14 does not change factual authority, evidence, provenance, CoverageManifest semantics, tenant authorization, ContextResolver, ContextPacket, Meri reasoning, embedding providers, vector dimensions, or NVIDIA's source-of-truth status.

## Acceptance

- [x] One shared scoring layer inside Retrieval V2.
- [x] RRF used for heterogeneous rank fusion.
- [x] Signal classes stay distinct and observable.
- [x] Missing semantic scores stay missing.
- [x] Coverage is proved before scoring.
- [x] Provenance is untouched.
- [x] Fusion runs before NVIDIA reranking.
- [x] Shadow is default; apply is explicit.
- [x] No database or AWS infrastructure change.
- [x] Dedicated tests and CI workflow are present.

GitHub Actions has an existing repository-level `startup_failure` condition that can occur before jobs are created. If reproduced, record it as an Actions execution-layer failure — not green CI and not a Phase 14 test failure.
