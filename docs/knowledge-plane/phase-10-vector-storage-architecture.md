# Knowledge Plane Phase 10 — Vector Storage Architecture

## Decision

Capiro keeps **PostgreSQL + pgvector** as the single shared vector-storage substrate for the Knowledge Plane.

Phase 10 does not introduce a database migration, a new vector database, a Meri-only index, or a feature-specific RAG store. The existing shared `ContextEmbedding` substrate remains the storage boundary, while Retrieval V2 remains the shared retrieval plane.

## Invariants

1. Postgres remains the system containing vector storage; pgvector remains the vector extension.
2. Meri must consume the shared Retrieval/Context Plane rather than own a vector store.
3. Product surfaces may not create private Pinecone, Qdrant, Weaviate, Chroma, Milvus, LanceDB, or equivalent retrieval silos without an explicit architecture exception replacing this phase decision.
4. Embedding and reranking providers are replaceable. Provider choice does **not** define the architecture.
5. Tenant authorization, ethical walls, provenance, temporal semantics, and coverage stay upstream of model reasoning and cannot be bypassed by semantic retrieval.
6. Existing live structured source systems remain authoritative for government facts; vectors are retrieval aids, not evidence or source-of-truth replacements.

## Enforcement

`apps/api/src/retrieval/vector-storage-architecture.contract.spec.ts` verifies the Prisma datasource is PostgreSQL with pgvector enabled, the shared `ContextEmbedding` model exists, forbidden external vector-database SDKs are absent from the API dependency graph, and Meri/Retrieval V2 do not import a separate vector-store client.

The Phase 10 CI workflow runs this architecture contract together with Retrieval V2 regression tests and Prisma validation.
