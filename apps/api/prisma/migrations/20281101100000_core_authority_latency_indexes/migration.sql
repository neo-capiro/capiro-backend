-- Core authority latency (2026-11-01): indexes for the reads that were
-- being cancelled by statement_timeout (SQLSTATE 57014) while the serving
-- Aurora cluster was saturated, starving Meri's conversation-authority calls.
--
-- Every statement is CONCURRENTLY + IF NOT EXISTS, so the migration is
-- forward-only and idempotent and keeps serving traffic while each index
-- builds. CONCURRENTLY must run outside a transaction (Prisma applies this
-- file as a plain script; precedent 20261026184000_tango_funding_embedding_prefix).
-- If a build is interrupted it leaves an INVALID index that IF NOT EXISTS
-- would then skip: after deploy, verify with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- and DROP INDEX CONCURRENTLY any listed name before re-running.
--
-- These are SQL-only (partial predicates, operator classes and NULLS ordering
-- are not expressible in schema.prisma), so schema.prisma and the qualification
-- Prisma pins are unchanged, as with the precedent above.

-- IntelligenceService tracked bills (intelligence-tracked-bill-discovery.ts):
-- nearest-neighbour search over bill embeddings only. The table-wide HNSW
-- index serves every source type, so the planner either post-filters its
-- candidates (dropping bills) or falls back to an exact scan of the whole
-- table (the 4-7 s statements in the incident). A partial index over bills
-- makes the filtered ANN scan use the index directly.
CREATE INDEX CONCURRENTLY IF NOT EXISTS context_embeddings_bill_embedding_hnsw
  ON context_embeddings USING hnsw (embedding vector_cosine_ops)
  WHERE source_type = 'bill';

-- IntelligenceService bill-regulation links (intelligence-bill-enrichment.ts):
-- `topics && $subjects` (array overlap) over federal_register_document had no
-- index; the identifier branch is now bounded by publication_date, which had
-- no single-column index either (only (type, publication_date)).
CREATE INDEX CONCURRENTLY IF NOT EXISTS federal_register_document_topics_gin_idx
  ON federal_register_document USING gin (topics);
CREATE INDEX CONCURRENTLY IF NOT EXISTS federal_register_document_publication_date_idx
  ON federal_register_document (publication_date DESC);

-- getHearingAlerts and the profile-v1 calendar feed read the next-21-day
-- federal window ordered by (date, time). The existing (date) index still
-- has to filter every state hearing and alias row on the heap; this partial
-- index matches federalHearingWhere() exactly and returns rows in order.
CREATE INDEX CONCURRENTLY IF NOT EXISTS committee_hearing_federal_date_time_idx
  ON committee_hearing (date, time)
  WHERE canonical_hearing_id IS NULL
    AND (geographic_jurisdiction = 'US' OR geographic_jurisdiction IS NULL);

-- EngagementService.listMailThreads (mail-thread-list.ts) selects the caller's
-- mailboxes' threads by (tenant_id, connection_id) in live-activity order.
-- The only (tenant_id, ...) indexes were the external-id unique key and the
-- (tenant_id, client_id, last_message_at) index, so a user's page scanned
-- every thread in the tenant. This index matches the join and the ORDER BY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_threads_tenant_connection_activity_idx
  ON mail_threads (tenant_id, connection_id, last_message_at DESC NULLS LAST, updated_at DESC, id DESC);
