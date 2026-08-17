/**
 * Knowledge Plane Phase 10 vector-storage architecture contract.
 *
 * Embedding generation/reranking providers are replaceable implementation
 * details. The storage and retrieval plane is not: Capiro keeps one shared
 * Postgres + pgvector substrate and may not create a Meri-specific or
 * feature-specific vector database.
 */
export const VECTOR_STORAGE_ARCHITECTURE = Object.freeze({
  database: 'postgresql',
  vectorExtension: 'pgvector',
  sharedEmbeddingModel: 'ContextEmbedding',
  sharedRetrievalPlane: 'RetrievalV2',
  providerDefinesArchitecture: false,
  allowFeatureSpecificVectorStore: false,
  allowMeriSpecificVectorStore: false,
} as const);

export type VectorStorageArchitecture = typeof VECTOR_STORAGE_ARCHITECTURE;
