-- Meri semantic reads (2026-11-02): partial HNSW indexes for the two funding
-- chunk families that semantic_search_grants and
-- semantic_search_contract_opportunities rank by cosine distance.
--
-- The table-wide context_embeddings_embedding_hnsw index serves every
-- source type, so a filtered nearest-neighbour scan over one family either
-- post-filters its candidates (dropping most of them) or falls back to an
-- exact scan of the whole table. Bills already have their partial index
-- (20281101100000_core_authority_latency_indexes); these two complete the set.
--
-- CONCURRENTLY + IF NOT EXISTS: forward-only, idempotent and non-blocking, and
-- SQL-only (a partial predicate is not expressible in schema.prisma), so
-- schema.prisma and the Prisma pins are unchanged. CONCURRENTLY must run
-- outside a transaction (Prisma applies this file as a plain script). After
-- deploy, verify no interrupted build left an INVALID index:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- and DROP INDEX CONCURRENTLY any listed name before re-running.

CREATE INDEX CONCURRENTLY IF NOT EXISTS context_embeddings_funding_grant_chunk_embedding_hnsw
  ON context_embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE source_type = 'funding_grant_chunk';

CREATE INDEX CONCURRENTLY IF NOT EXISTS context_embeddings_funding_notice_chunk_embedding_hnsw
  ON context_embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE source_type = 'funding_notice_chunk';
