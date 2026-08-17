# Knowledge Plane Phase 13 — NVIDIA Reranking

## Status

Implemented on `agent/knowledge-plane-phase-13-nvidia-reranking`.

Phase 13 adds NVIDIA as a **relevance-only reranking layer inside Retrieval V2**. It does not create a source-of-truth system, vector database, graph, retrieval plane, or reasoning system.

## Master-plan contract

The Phase 13 architecture is:

```text
already-authorized source retrieval
        ↓
exact / semantic / entity / graph candidate set
        ↓
coverage proof from authoritative source results
        ↓
shared RetrievalRerankerService
        ↓
RerankingProvider
        ↓
NVIDIA NeMo Retriever Reranking NIM
        ↓
permutation of the SAME RetrievalRecord objects
        ↓
ContextResolver / compiler (later phases)
```

Required invariants:

1. reranking changes order, not authority;
2. provenance survives unchanged;
3. reranking cannot turn unavailable/incomplete coverage into complete coverage;
4. rerank scores are observable;
5. provider failure has controlled fallback behavior;
6. no NVIDIA-specific vector store;
7. no NVIDIA-specific Capiro graph.

Phase 14 retrieval-score fusion remains separate.

## Shared provider contract

`apps/api/src/reranking/reranking-provider.ts` defines the narrow provider-neutral boundary:

- provider/model/API-version metadata;
- one text query;
- an already-authorized list of candidate passages;
- a complete permutation of passage indexes;
- provider-native relevance scores;
- optional usage metadata;
- provider-neutral timeout/request/response failures.

The provider never receives Capiro source-authority fields, coverage state, graph partitions, tenant authorization policy, or provenance metadata.

## NVIDIA adapter

`NvidiaRerankingProvider` implements the NVIDIA NeMo Retriever ranking request/response contract:

```json
{
  "model": "nvidia/llama-nemotron-rerank-vl-1b-v2",
  "query": { "text": "..." },
  "passages": [{ "text": "..." }],
  "truncate": "END"
}
```

The adapter consumes returned passage `index` + `logit`, validates a complete one-to-one permutation, and exposes the logit only as an observable relevance score.

### Model lifecycle decision

As of 2026-08-17, NVIDIA's Build page marks the text-only `nvidia/llama-nemotron-rerank-1b-v2` hosted offering for near-term deprecation, while the current NeMo Retriever NIM support matrix still supports that model for self-hosted deployments and the active `nvidia/llama-nemotron-rerank-vl-1b-v2` accepts text passages as well as multimodal passages.

Capiro therefore defaults to:

```text
nvidia/llama-nemotron-rerank-vl-1b-v2
```

Capiro sends **text passages only** in Phase 13. `NVIDIA_RERANK_MODEL` remains the one model-selection override, so a private NIM can use the text-only model (or a future compatible model) without changing Retrieval V2.

## Hosted and self-hosted NIM routes

NVIDIA uses different HTTP routes for hosted Build APIs and self-hosted NeMo Retriever NIM. The provider abstraction hides that distinction.

### NVIDIA-hosted Build API

Set:

```text
RETRIEVAL_RERANK_ENABLED=true
NVIDIA_API_KEY=<secret>
```

With no explicit URL, Capiro generates the current NVIDIA model-specific hosted route:

```text
https://ai.api.nvidia.com/v1/retrieval/<publisher>/<model>/reranking
```

For the default model that resolves to:

```text
https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-vl-1b-v2/reranking
```

Hosted NVIDIA routes fail closed in provider selection when no bearer key exists.

### Private/self-hosted NeMo Retriever NIM

Set:

```text
RETRIEVAL_RERANK_ENABLED=true
NVIDIA_RERANK_BASE_URL=http://<private-nim-host>:8000/v1
```

The adapter calls:

```text
http://<private-nim-host>:8000/v1/ranking
```

`NVIDIA_API_KEY` may be omitted for a private endpoint whose network/auth layer does not use bearer auth.

### Explicit endpoint override

For a controlled proxy, future hosted route, or nonstandard NIM deployment:

```text
NVIDIA_RERANK_URL=https://<full-ranking-endpoint>
```

`NVIDIA_RERANK_URL` is a full endpoint and takes precedence over `NVIDIA_RERANK_BASE_URL`.

For compatibility with older NVIDIA examples, if `NVIDIA_RERANK_BASE_URL` is set to an NVIDIA hosted host such as `integrate.api.nvidia.com`, the factory normalizes it to the model-specific hosted reranking route rather than incorrectly appending `/ranking`.

### Other controls

```text
NVIDIA_RERANK_MODEL=nvidia/llama-nemotron-rerank-vl-1b-v2
NVIDIA_RERANK_TIMEOUT_MS=5000
RETRIEVAL_RERANK_MAX_CANDIDATES=128
```

## Dark-by-default activation

A code deploy alone does **not** send retrieval text to NVIDIA.

`RETRIEVAL_RERANK_ENABLED` must be explicitly enabled. If disabled, Retrieval V2 returns the exact baseline order and records `reranking.status=disabled`.

If enabled but no usable provider is configured, Retrieval V2 returns baseline order and records a controlled fallback.

This lets provider networking/credentials be introduced and canaried separately from the code merge.

## Authorization and privacy boundary

Reranking runs only after Retrieval V2 source adapters have returned records under their existing tenant/user/client/ethical-wall rules.

The provider receives only:

- the request's relevance query;
- a compact projection of each already-authorized record's domain + payload.

The provider does **not** receive:

- `RetrievalRecord.provenance`;
- internal `RetrievalRecord.recordId` values;
- source coverage/health state;
- tenant authorization policy;
- graph partition state.

Provider errors and fallback logs contain provider/model/reason metadata only. They deliberately exclude query text, passages, provider response bodies, and source exception bodies.

## Provenance and authority preservation

The reranker does not clone or rebuild records. It returns a permutation of references to the original `RetrievalRecord` objects.

Therefore:

- `payload` is unchanged;
- `provenance` is unchanged;
- entity references are unchanged;
- source timestamps are unchanged;
- no score is written into factual payload/provenance;
- a high NVIDIA score does not become factual confidence or source authority.

The observable rerank score exists only in `RetrievalObservability.reranking.scores`.

## Coverage cannot be upgraded

`RetrievalV2Service` computes `CoverageManifest` from authoritative `RetrievalSourceResult` objects **before** invoking the reranker.

The reranker receives only flattened candidate records. It receives no `CoverageManifest` and cannot mutate:

- source availability;
- source health;
- pagination state;
- truncation state;
- requested/searched entity counts;
- freshness;
- completeness;
- stop reasons.

A degraded or unavailable source therefore remains degraded/unavailable even when NVIDIA successfully reranks available candidates.

## Controlled fallback behavior

The shared reranker preserves baseline candidate order when:

- reranking is disabled;
- no relevance query is available;
- fewer than two candidates exist;
- no provider is configured;
- the candidate safety cap is exceeded;
- the provider times out;
- the provider request fails;
- the provider returns malformed/incomplete/duplicate indexes;
- any unexpected reranker execution error occurs.

There is no partial-prefix rerank when the safety cap is exceeded. Partially reranking only the first N records would prevent later authorized candidates from competing for higher rank, so the entire set falls back to baseline order.

## Candidate limits

`RETRIEVAL_RERANK_MAX_CANDIDATES` defaults to `128` and is clamped to `2..512`.

The 512 hard ceiling is the conservative common denominator with the self-hosted NeMo Retriever ranking API. Capiro's lower default bounds latency/cost and avoids unexpectedly transmitting a very large authorized candidate set on the first rollout.

Each provider passage is capped to 12,000 characters and query text to 8,000 characters. NVIDIA is instructed to truncate overlong query/passage pairs from the end (`truncate=END`).

## Observability

Every Retrieval V2 response can expose:

```text
observability.reranking.status
observability.reranking.provider
observability.reranking.model
observability.reranking.candidateCount
observability.reranking.rerankedCount
observability.reranking.durationMs
observability.reranking.fallbackReason
observability.reranking.usage
observability.reranking.scores[]
```

Each internal score trace records:

- domain;
- record ID;
- original rank;
- final rank;
- provider relevance score.

Record IDs stay inside Capiro observability; they are not sent in provider passages.

These fields are operational/retrieval observability. They are not evidence and not factual confidence.

## Tests and architecture guards

Phase 13 adds tests proving:

- NVIDIA request/response shape;
- correct NVIDIA-hosted model-specific endpoint;
- correct self-hosted `/v1/ranking` endpoint;
- hosted bearer auth and private-NIM no-auth operation;
- provider selection remains unconfigured/dark without endpoint or credential;
- hosted provider selection requires a key;
- model selection stays behind one factory seam;
- malformed/duplicate provider indexes fail closed;
- sensitive query/passage/provider-body text is absent from provider errors;
- only the same `RetrievalRecord` objects are reordered;
- payload/provenance object identity is preserved;
- provider failure restores exact baseline order;
- candidate-cap overflow restores exact baseline order;
- deployment remains dark until explicitly enabled;
- exact-lexical value can act as a relevance query;
- degraded/incomplete Retrieval V2 coverage remains degraded/incomplete after successful reranking;
- the NVIDIA adapter contains no pgvector/vector-store/graph/database responsibilities;
- provider passage construction excludes provenance;
- coverage is constructed before reranking.

The dedicated acceptance workflow is `.github/workflows/knowledge-phase13-ci.yml`.

## Infrastructure / operator boundary

This phase intentionally does not invent a production NVIDIA secret ARN or deploy a new GPU service. The code is merge-safe and dark by default.

For NVIDIA-hosted activation, the operator must inject `NVIDIA_API_KEY` into the API serve task through the existing secret-management process before setting `RETRIEVAL_RERANK_ENABLED=true`.

For NVIDIA-on-AWS/private-NIM activation, deploy the NIM endpoint separately, provide its private `/v1` base URL as `NVIDIA_RERANK_BASE_URL`, verify network reachability from the API service, and then enable the reranker. The Retrieval V2 integration does not change between deployment models.

## Explicit exclusions

Phase 13 does **not**:

- modify pgvector or `context_embeddings`;
- add a NVIDIA vector database;
- add a NVIDIA/Capiro duplicate graph;
- re-embed data;
- change embedding dimensions/models;
- alter source authority;
- alter provenance;
- alter coverage semantics;
- alter tenant/ethical-wall authorization;
- introduce composite retrieval scoring;
- combine rerank score with similarity/authority/freshness/recency;
- change ContextResolver or ContextPacket;
- change Meri reasoning.

Those composite ranking inputs belong to Phase 14.

## Acceptance checklist

- [x] NVIDIA exists only as a reranking provider, not source-of-truth.
- [x] Reranking is inside shared Retrieval V2.
- [x] Reranker can only permute already-authorized candidates.
- [x] Provenance survives unchanged.
- [x] Authority survives unchanged.
- [x] Coverage is proved before reranking and cannot be upgraded by it.
- [x] Provider/model/relevance scores are observable.
- [x] Provider failures fall back to baseline candidate order.
- [x] Provider timeout is bounded.
- [x] Candidate-count safety cap is bounded and explicit.
- [x] Hosted and self-hosted NIM use one provider contract.
- [x] Hosted and self-hosted HTTP routes are tested independently.
- [x] Provider inputs exclude provenance and internal record IDs.
- [x] No NVIDIA-specific vector store exists.
- [x] No NVIDIA-specific Capiro graph exists.
- [x] Phase 14 scoring is not mixed into Phase 13.
- [x] Dedicated tests and CI acceptance workflow are present.

## GitHub Actions caveat

This repository has previously produced repository-level `startup_failure` / `BuildFailed` events before any executable job was scheduled. If that condition occurs for Phase 13, record it as an Actions execution-layer failure — not green CI and not a Phase 13 test failure.
