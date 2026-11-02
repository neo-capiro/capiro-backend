-- Meri governed memory recall (search_memory, 2 November 2026): the semantic
-- candidate join over context_embeddings expired its transaction on preview
-- (19 identical expirations on previous builds, 180 s each). The statement
-- itself is one index probe per eligible memory item (20281029050000 predates
-- it), but the RESTRICTIVE retention policy added by that migration ran, for
-- every candidate embedding row, a memory_items subquery whose join term
-- `m.id::text = context_embeddings.source_id` cannot use the primary key: the
-- planner scanned the tenant's memory_items and evaluated memory_items' own
-- policies, including memory_retention_visible() (a non-inlinable SECURITY
-- DEFINER function), once per scanned row. Cost grew as eligible items times
-- tenant items, so a tenant with a few thousand items ran for minutes.
--
-- Same visibility rule, written so the subquery is a primary-key probe: the
-- memory_item source id is the item uuid as text, compared as uuid against
-- m.id. CASE keeps the cast off rows of other source types, whose source ids
-- are not uuids, and the uuid pattern guard refuses a malformed memory source
-- id (no row, so the embedding stays invisible) instead of raising.
--
-- Prisma runs this file as one implicit transaction. The policy swap takes a
-- brief ACCESS EXCLUSIVE lock on context_embeddings; the local lock_timeout
-- makes the deploy fail fast behind a long reader instead of queueing every
-- other caller behind the lock request (precedent: 20281031150000).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP POLICY IF EXISTS memory_embedding_owner_retention ON context_embeddings;
CREATE POLICY memory_embedding_owner_retention ON context_embeddings AS RESTRICTIVE FOR SELECT
  USING (
    rls_bypass() OR CASE
      WHEN source_type <> 'memory_item' THEN true
      WHEN source_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN false
      ELSE EXISTS (
        SELECT 1 FROM memory_items m
        WHERE m.tenant_id = context_embeddings.tenant_id
          AND m.id = context_embeddings.source_id::uuid
          AND memory_retention_visible(m.tenant_id, m.retention_subject_id))
    END
  );
