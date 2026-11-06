-- Public semantic coverage must inspect usable current-model vectors, not
-- embedded_at completion markers. Persist the nonzero-vector predicate in a
-- small B-tree so each count need not detoast every 1024-dimensional vector.
-- No text/vector payload, private records, data rewrite or policy change.
-- Run outside a transaction. A failed concurrent build must be inspected for
-- an invalid same-name index before retrying; do not silently accept drift.
CREATE INDEX CONCURRENTLY IF NOT EXISTS context_embeddings_public_usable_coverage_idx
  ON context_embeddings (source_type, model, (metadata_jsonb->>'parentId'), source_id)
  INCLUDE (tenant_id, client_id, owner_user_id)
  WHERE tenant_id IS NULL AND client_id IS NULL AND owner_user_id IS NULL
    AND embedding IS NOT NULL AND (embedding <#> embedding) < 0;
