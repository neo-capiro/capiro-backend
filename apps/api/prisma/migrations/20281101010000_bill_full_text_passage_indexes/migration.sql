-- Public, version-linked bill passages share the established vector store.
-- Partial indexes keep tenant content and other ingestion families out of this index.
CREATE INDEX IF NOT EXISTS context_embeddings_bill_passage_tsv_idx
ON context_embeddings USING gin (to_tsvector('english', content_text))
WHERE tenant_id IS NULL AND source_type IN ('bill_passage', 'state_bill_passage');

CREATE INDEX IF NOT EXISTS context_embeddings_bill_passage_hnsw_idx
ON context_embeddings USING hnsw (embedding vector_cosine_ops)
WHERE tenant_id IS NULL AND source_type IN ('bill_passage', 'state_bill_passage');
