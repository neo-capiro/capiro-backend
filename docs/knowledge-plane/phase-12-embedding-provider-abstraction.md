# Knowledge Plane Phase 12 — Embedding Provider Abstraction

## Status

Implemented on `agent/knowledge-plane-phase-12-embedding-provider-abstraction`.

Phase 12 changes the **shared Context Plane provider boundary only**. Titan remains the current/default implementation and `context_embeddings` remains the shared PostgreSQL + pgvector substrate.

## Objective

```text
shared retrieval / indexing / memory projection / backfills
                         ↓
                EmbeddingProvider
                         ↓
                 provider adapter
                         ↓
          current default: Titan / Bedrock
```

Provider choice is an implementation detail. It does not own authorization, source truth, provenance, retrieval scoring, context compilation, or vector storage.

## Direct-call audit

Phase 12 audited the requested runtime boundaries, including the legacy Meri path.

| Surface | Audit result |
| --- | --- |
| `apps/api/src/embeddings/embedder.ts` | Previously created Bedrock/Titan directly; now provider-neutral through `EmbeddingProvider`. |
| `apps/api/scripts/embed-backfill.ts` | Previously contained a second Bedrock/Titan implementation; duplicate removed and routed through the shared provider seam. |
| `EmbeddingsService` capability indexing | Nest now injects `EMBEDDING_PROVIDER`; persistence/security remain outside the provider. |
| `ClientKbService` | Uses the shared embedding helper/model metadata; tenant/client retrieval SQL is unchanged. |
| `MemoryIngestService` / `memory_items` projection | Already used `embedAndUpsert`; now inherits the provider abstraction while retaining owner/tenant scope. |
| Congress/LDA sync jobs | Already used the shared helper; no direct provider implementation found. |
| client-KB backfill | Delegates to production `ClientKbService`; no separate provider implementation found. |
| Meri conversation history search | Uses `context_embeddings` + shared `embedText`; provider-neutral after this phase. |
| Workspace | No shared Context-Plane embedding provider implementation found in the Workspace context boundary. |
| Meri V2 orchestrator/core | No embedding provider SDK implementation found in those package boundaries. |
| **Legacy `clio_memory.embedding` recall** | Audited compatibility island: 1536-dimension OpenAI vectors remain in the inherited Meri-only path. It is intentionally **not migrated in Phase 12** because doing so requires a dimension/model migration or corpus re-embedding and changes the default memory-recall behavior. |

### Legacy compatibility boundary

Two inherited runtime call sites still serve the old `clio_memory.embedding` compatibility path:

- `apps/api/src/meri/meri.service.ts` — semantic lookup for `clio_memory`.
- `apps/api/src/memory/memory-candidate.service.ts` — write-side refresh of the legacy vector column.

That path is not the shared Retrieval V2 / Context Plane vector architecture. The canonical projection already writes `memory_items` into the shared 1024-dimension `context_embeddings` substrate, and Meri has gated `projection` / `union` recall modes for cutover.

Phase 12 deliberately does **not** collapse the legacy 1536-dimension OpenAI vector column into the 1024-dimension shared store. The master-plan exclusions forbid changing vector dimensions, re-embedding the corpus, or changing retrieval behavior in this phase. Instead the CI gate freezes the compatibility island to those two existing runtime call sites (plus its config declaration) and fails if direct legacy OpenAI embedding coupling spreads anywhere else.

Retiring that island belongs to the memory/Context-Plane cutover, where recall parity can be evaluated explicitly rather than hidden inside a provider refactor.

## Shared contract

`apps/api/src/embeddings/embedding-provider.ts` defines a narrow provider-neutral contract:

- `embed(input)`
- `embedBatch(inputs)`
- provider identity
- model identity/version
- vector dimensions
- provider-neutral failure codes

`EmbeddingProviderError` carries provider metadata and retryability without including the source text in its public message, reducing the risk that private mailbox/client/document content is copied into provider-failure logs.

## Titan baseline adapter

`apps/api/src/embeddings/titan-embedding.provider.ts` is the sole Titan/Bedrock implementation for the shared Context Plane.

Behavior is preserved:

- default model: `amazon.titan-embed-text-v2:0`
- vector width: `1024`
- normalization request flag: `true`
- region fallback: `AWS_REGION_DEFAULT ?? us-east-1`
- existing Bedrock `InvokeModel` request shape

The Bedrock client is lazy. Importing provider/model metadata does not issue a provider call.

## One shared provider-selection seam

`embedding-provider.factory.ts` owns default provider selection for standalone jobs.

`EmbeddingsModule` registers the same process-wide provider through the `EMBEDDING_PROVIDER` Nest token. This supports both execution shapes without two shared embedding architectures:

- Nest/API write paths use dependency injection.
- standalone sync/backfill/ECS jobs use the provider-neutral default factory.

A future default-provider switch should happen at this seam, not in individual product features.

## Storage compatibility lock

Phase 12 does **not** migrate vectors.

`context_embeddings` remains the shared pgvector store at 1024 dimensions. `assertEmbeddingStorageCompatibility()` fails before provider invocation/write if the configured shared provider reports a different dimension.

Provider model identity continues to be persisted in the existing `model` column and used by semantic retrieval, so queries compare against vectors from the same model.

## Authorization and privacy invariants

Provider abstraction does not receive or decide authorization scope. Existing boundaries remain outside the adapter:

- tenant ID
- client ID
- owner user ID for private memory
- RLS / trusted-system bypass decisions
- source type/source ID
- content hashing / idempotence
- pgvector SQL

The provider receives only text that an already-authorized indexing path chose to embed. It cannot widen tenant, client, mailbox, or user-private scope.

## Backfill behavior preserved

The standalone `embed-backfill.ts` retains:

- bills, LDA, capabilities, and state bills
- state bills remaining dark from `--source all`
- page size `500`
- bounded row concurrency
- SyncRun watermarks/status
- dry-run behavior
- existing RLS behavior
- content hashes
- `context_embeddings` pgvector writes

Only the shared Titan provider selection/invocation moved behind the contract.

## Contract and regression coverage

`embedding-provider.contract.spec.ts` verifies:

- stable provider/model/version/dimension metadata
- Titan request-shape parity
- ordered batch semantics
- provider-neutral transport failures
- no source-text leakage in provider error messages
- fail-closed invalid/wrong-dimension responses

`embedder.spec.ts` verifies:

- vector production delegates to `EmbeddingProvider`
- incompatible vector dimensions fail before shared-store writes
- content-hash short-circuit still avoids provider calls/writes
- provider model metadata is persisted while tenant/client scope is preserved
- RLS bypass remains a persistence concern rather than a provider concern

The Phase 12 acceptance workflow also:

- rejects the Titan model literal outside the Titan adapter
- rejects direct Bedrock embedding SDK coupling outside the adapter across embeddings, memory, Meri, Retrieval V2, and audited jobs
- freezes the inherited OpenAI `clio_memory.embedding` compatibility island so no new direct call sites can appear
- runs existing client-KB and memory-ingest regressions
- attributes TypeScript failures in Phase 12 surfaces

## Explicit exclusions

Phase 12 does **not**:

- change PostgreSQL or pgvector
- create another vector database
- re-embed the corpus
- change vector dimensions
- migrate the legacy `clio_memory.embedding` score space
- add NVIDIA reranking
- change retrieval scoring
- change ContextResolver
- change ContextPacket
- alter Meri reasoning
- create feature-specific shared embedding services

NVIDIA reranking belongs to Phase 13 and remains a separate failure domain/PR.

## Acceptance checklist

- [x] Shared embedding/indexing paths no longer own Titan request details.
- [x] One narrow `EmbeddingProvider` contract exists for the shared Context Plane.
- [x] Titan is wrapped as the current/default adapter.
- [x] Single-input and ordered batch APIs are present.
- [x] Provider/model/version/dimension metadata are observable.
- [x] Provider failures are represented in a provider-neutral form.
- [x] Existing shared pgvector storage remains unchanged.
- [x] Existing shared 1024-dimensional storage is explicitly guarded.
- [x] Model identity continues to partition stored/query vectors.
- [x] Tenant/client/user-private persistence rules remain outside the provider.
- [x] Generic backfill no longer contains a second Titan/Bedrock implementation.
- [x] Memory, Meri, Workspace, workers/scripts/backfills were audited for provider coupling.
- [x] Inherited 1536-dimension `clio_memory.embedding` is documented and frozen rather than silently migrated.
- [x] Contract/security/storage regression tests are present.
- [x] Dedicated Phase 12 CI acceptance workflow is present.
- [x] No Phase 13 reranking/scoring work is mixed into this change.

## CI infrastructure caveat

The repository has previously exhibited a GitHub Actions execution-layer `startup_failure` where zero jobs are scheduled. If that condition recurs for this PR, it must be reported as an Actions infrastructure failure — neither green CI nor a Phase 12 test failure. The workflow remains the executable acceptance contract once runners schedule normally.
