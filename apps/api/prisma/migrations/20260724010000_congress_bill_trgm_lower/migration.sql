-- Functional pg_trgm GIN indexes on LOWER(...) for congress_bill keyword matching.
--
-- These make the whole-word-regex / equality / ILIKE bill-relevance queries
-- index-backed. Previously those queries were two sequential scans plus a
-- ~160k-row cross-table join filter (~2s per call), run once per client in the
-- portfolio roll-up fan-out -- the dominant Aurora writer-CPU consumer during
-- business hours. The query rewrite that USES these indexes lives in
-- apps/api/src/intelligence/bill-keyword-match.helpers.ts (UNION of per-table
-- branches + explicit per-pattern OR; `~ ANY(array)` cannot use a GIN index).
--
-- A functional gin_trgm_ops index on LOWER(col) serves the `= ANY`, `~`, and
-- `ILIKE` operators used against that column. Validated on the live DB: the
-- rewrite returns an identical result set and uses these indexes even under a
-- forced generic (bind-parameter) plan.
--
-- On prod these are created out-of-band with CREATE INDEX CONCURRENTLY before
-- this migration runs, so IF NOT EXISTS makes the statements below a no-op with
-- no lock. Where not pre-created, plain CREATE INDEX takes a brief lock on these
-- sync-only (not user-write-hot) tables.
--
-- IMPORTANT (deploy runbook): a CREATE INDEX CONCURRENTLY that FAILS leaves an
-- INVALID index of the same name, and IF NOT EXISTS below would then silently
-- skip it (it checks name existence, not validity) -- leaving prod on the slow
-- seq-scan plan. Before running migrate deploy, verify all three indexes report
-- pg_index.indisvalid = true; REINDEX (or DROP + recreate CONCURRENTLY) any that
-- are invalid.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "congress_bill_title_lower_trgm_idx"
  ON "congress_bill" USING gin (lower(title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "congress_bill_policy_area_lower_trgm_idx"
  ON "congress_bill" USING gin (lower(policy_area) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "congress_bill_subject_name_lower_trgm_idx"
  ON "congress_bill_subject" USING gin (lower(name) gin_trgm_ops);
