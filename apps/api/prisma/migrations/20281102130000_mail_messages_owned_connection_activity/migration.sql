-- Meri stored-mail reads (2026-11-02): the canonical count, page and coverage
-- statements (apps/api/src/engagement/mail-query.ts) select one owned mailbox
-- and bound it by COALESCE(received_at, sent_at). The existing partial index
-- mail_messages_tenant_connection_active_idx (tenant_id, connection_id) finds
-- the mailbox; after that the date window is a heap filter, so a two-day
-- "yesterday" window over a 37k-message mailbox walked every stored message
-- three times (count, page, coverage) and, cold on the 2 ACU preview writer,
-- exceeded the 10 s shared statement budget: POST /api/clio/tools/:name took
-- 10012 ms at 2026-11-02 03:37:04Z and the read reached Meri as a 503.
--
-- This expression index turns the window into an index condition for the count
-- and the page, and lets the per-mailbox coverage aggregate (count, oldest,
-- newest) run as an Index Only Scan: thread_id rides along for the owned-thread
-- visibility join, and received_at/sent_at because min/max(COALESCE(...)) read
-- the columns, not the indexed expression (review of #415: with thread_id alone
-- coverage still fetched all 37k heap tuples, 7,479 buffers; with the three
-- columns and a set visibility map it is 0 heap fetches, 430 buffers, 16 ms).
-- The earlier two-column index stays until this one shows idx_scan use in
-- production; it is then redundant and can be dropped CONCURRENTLY in its own
-- single-statement migration.
--
-- Exactly one statement: Prisma sends a migration file as one script, which
-- Postgres runs as an implicit transaction, and CREATE INDEX CONCURRENTLY is
-- refused inside a transaction unless it is the only statement (precedent:
-- 20281102100000, 20260919010000). CONCURRENTLY + IF NOT EXISTS keeps it
-- forward-only, idempotent and non-blocking; an expression index is SQL-only,
-- so schema.prisma is unchanged. After deploy, verify no interrupted build left
-- an INVALID index:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- and DROP INDEX CONCURRENTLY any listed name before re-running. Then run
--   VACUUM (ANALYZE) mail_messages;
-- once: the Index Only Scan needs the visibility map set (a plain index build
-- does not set it), and the planner currently estimates the largest mailbox at
-- 5.9k rows against 37k stored.

CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_messages_tenant_connection_activity_idx
  ON mail_messages (tenant_id, connection_id, (COALESCE(received_at, sent_at)) DESC NULLS LAST)
  INCLUDE (thread_id, received_at, sent_at)
  WHERE removed_at IS NULL;
