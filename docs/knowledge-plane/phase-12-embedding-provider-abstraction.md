# Knowledge Plane Phase 12 — Embedding Provider Abstraction

## Status

Implemented on `agent/knowledge-plane-phase-12-embedding-provider-abstraction`.

Phase 12 changes the provider boundary only. Titan remains the current/default embedding implementation and `context_embeddings` remains the shared PostgreSQL + pgvector substrate.

## Objective

Remove architectural coupling between Capiro retrieval/indexing code and a particular embedding vendor/model:

```text
retrieval / indexing / memory / backfills
                ↓
       EmbeddingProvider
                ↓
      provider adapter
                ↓
 current default: Titan on AWS Bedrock
```

The embedding provider is an implementation detail. It does not own authorization, source truth, provenance, retrieval scoring, context compilation, or vector storage.

## Direct-call audit

Phase 12 inspected the active embedding/indexing surfaces and the dependent runtime boundaries.

| Surface | Before Phase 12 | Phase 12 result |
| --- | --- | --- |
| `apps/api/src/embeddings/embedder.ts` | Created Bedrock client and invoked Titan directly | Provider-neutral; delegates vector creation to `EmbeddingProvider` |
| `apps/api/scripts/embed-backfill.ts` | Contained a second Bedrock/Titan client and request implementation | Duplicate provider stack removed; uses shared provider seam |
| `EmbeddingsService` capability indexing | Used shared helper that was Titan-coupled | Nest receives `EMBEDDING_PROVIDER`; persistence uses injected provider |
| `ClientKbService` profile/person/facility/document indexing + semantic query | Uses shared embedding helper and shared model metadata | Provider-neutral through the shared helper/factory; tenant/client SQL unchanged |
| memory ingestion / `memory_items` semantic projection | Uses `embedAndUpsert` | Automatically routes through provider abstraction; owner/tenant scope unchanged |
| Congress and LDA sync jobs | Already used `embedAndUpsert` | No direct provider coupling found; inherit provider abstraction |
| client-KB backfill | Delegates to production `ClientKbService` | No separate provider implementation |
| Workspace | No embedding-provider SDK dependency in the Workspace package; context service is grounding/context CRUD | No Phase 12 provider code added |
| Meri V2 orchestrator / core | No embedding-provider SDK dependency in these package boundaries | Remain reasoning/context consumers; no Meri-specific embedding stack added |

The acceptance workflow also rejects the Titan embedding model literal outside the Titan adapter and rejects direct Bedrock embedding SDK coupling inside the shared embedding, memory, retrieval, and audited backfill/sync surfaces.

## Shared contract

`apps/api/src/embeddings/embedding-provider.ts` defines the narrow provider-neutral contract:

- `embed(input)`
- `embedBatch(inputs)`
- provider identity
- model identity/version
- vector dimensions
- provider-neutral failure codes

`EmbeddingProviderError` deliberately does not carry source text in its public message, reducing the risk that private mailbox/client/document content is copied into provider-failure logs.

## Titan baseline adapter

`apps/api/src/embeddings/titan-embedding.provider.ts` is the sole Titan embedding adapter in the Phase 12 architecture.

The adapter preserves the existing behavior:

- default model: `amazon.titan-embed-text-v2:0`
- vector width: `1024`
- normalization: `true`
- region fallback: `AWS_REGION_DEFAULT ?? us-east-1`
- existing Bedrock `InvokeModel` request shape

The Bedrock client is lazy. Merely importing model metadata does not make a provider call.

## One provider-selection seam

`embedding-provider.factory.ts` owns default provider selection for standalone jobs.

`EmbeddingsModule` registers the same process-wide provider through the `EMBEDDING_PROVIDER` Nest token. This supports both runtime shapes without creating two embedding architectures:

- Nest/API write paths use dependency injection.
- standalone sync/backfill/ECS jobs use the provider-neutral default factory.

Changing the default provider later should happen at this seam, not in individual features.

## Storage compatibility lock

Phase 12 does **not** migrate vectors.

`context_embeddings` remains the shared pgvector store and remains 1024-dimensional. `assertEmbeddingStorageCompatibility()` fails before provider invocation/write if a configured provider reports a different dimension.

That guard is deliberate: switching providers and changing vector dimensions/re-embedding the corpus are separate migrations and must not happen implicitly.

The provider model ID continues to be stored in the existing `model` column and used by semantic retrieval so a query is compared only with vectors from the same embedding model.

## Authorization and privacy invariants

Provider abstraction does not receive or decide authorization scope.

Existing persistence/retrieval boundaries remain outside the provider adapter:

- tenant ID
- client ID
- owner user ID for private memory
- RLS / trusted-system bypass decisions
- source type/source ID
- content hashing / idempotence
- pgvector SQL

The provider receives only the text that an already-authorized indexing path chose to embed. It cannot widen a tenant, client, mailbox, or user-private scope.

## Backfill behavior preserved

The standalone `embed-backfill.ts` continues to own its established operational behavior:

- bills, LDA, capabilities, and state bills
- page size `500`
- bounded row concurrency
- SyncRun watermarks/status
- dry-run behavior
- trusted cross-tenant RLS bypass where already required
- content hashes
- `context_embeddings` pgvector writes

Only provider selection/invocation moved behind the shared contract.

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
- incompatible vector dimensions fail before writes
- content-hash short-circuit still avoids provider calls/writes
- provider model metadata is persisted while tenant/client scope is preserved
- RLS bypass remains an explicit persistence concern rather than a provider concern

The Phase 12 CI gate also runs existing client-KB and memory-ingest helper regressions and attributes TypeScript errors in Phase 12 surfaces.

## Explicit exclusions

Phase 12 does **not**:

- change PostgreSQL or pgvector
- add a second vector database
- re-embed the corpus
- change vector dimensions
- add NVIDIA reranking
- change retrieval scoring
- change ContextResolver
- change ContextPacket
- alter Meri reasoning
- create feature-specific embedding services

NVIDIA reranking belongs to Phase 13 and remains a separate failure domain/PR.

## Acceptance checklist

- [x] Shared embedding/indexing paths no longer own Titan request details.
- [x] One narrow `EmbeddingProvider` contract exists.
- [x] Titan is wrapped as the current/default adapter.
- [x] Single-input and ordered batch APIs are present.
- [x] Provider/model/version/dimension metadata are observable.
- [x] Provider failures are represented in a provider-neutral form.
- [x] Existing pgvector storage remains unchanged.
- [x] Existing 1024-dimensional storage is explicitly guarded.
- [x] Model identity continues to partition stored/query vectors.
- [x] Tenant/client/user-private persistence rules remain outside the provider.
- [x] Generic backfill no longer contains a second Titan/Bedrock implementation.
- [x] Contract/security/storage regression tests are present.
- [x] Dedicated Phase 12 CI acceptance workflow is present.
- [x] No Phase 13 reranking/scoring work is mixed into this change.

## CI infrastructure caveat

The repository has previously exhibited a GitHub Actions execution-layer `startup_failure` where zero jobs are scheduled. If that repository-level condition recurs for this PR, it must be reported as an Actions infrastructure failure — neither green CI nor a Phase 12 test failure. The workflow remains the executable acceptance contract once runners schedule normally.
