-- Meri semantic reads (2026-11-02): partial HNSW index for the funding chunk
-- family that semantic_search_contract_opportunities ranks by cosine distance. The table-wide
-- context_embeddings_embedding_hnsw index serves every source type, so a
-- filtered nearest-neighbour scan over one family either post-filters its
-- candidates or falls back to an exact scan. Bills already have their partial
-- index (20281101100000_core_authority_latency_indexes); the grant index precedes in 20281102100000.
--
-- Exactly one statement: Prisma sends a migration file as one script, which
-- Postgres runs as an implicit transaction, and CREATE INDEX CONCURRENTLY is
-- refused inside a transaction unless it is the only statement (precedent:
-- 20260919010000, 20260801010000). CONCURRENTLY + IF NOT EXISTS keeps it
-- forward-only, idempotent and non-blocking; SQL-only, so schema.prisma and
-- the Prisma pins are unchanged. After deploy, verify no interrupted build left
-- an INVALID index:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- and DROP INDEX CONCURRENTLY any listed name before re-running.

CREATE INDEX CONCURRENTLY IF NOT EXISTS context_embeddings_funding_notice_chunk_embedding_hnsw
  ON context_embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE source_type = 'funding_notice_chunk';
