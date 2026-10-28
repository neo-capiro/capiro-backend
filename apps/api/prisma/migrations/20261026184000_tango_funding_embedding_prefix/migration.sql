-- Keep existing uniqueness and ordinary-comparison indexes. The funding worker
-- looks up/replaces one document's id:chunk prefix; a locale-aware text index
-- cannot bound that LIKE search. No source text or vectors are indexed here.
-- Must run outside a transaction so ingestion can continue during the build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS context_embeddings_public_source_prefix_idx
  ON context_embeddings (source_type, model, source_id text_pattern_ops)
  WHERE tenant_id IS NULL;
