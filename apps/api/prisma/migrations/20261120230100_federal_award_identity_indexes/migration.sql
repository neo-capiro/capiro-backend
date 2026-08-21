-- District Nexus Release 1 (§4/§16): make the contract rail's canonical
-- identity predicates index-driven.
--
-- Release 1 gives the contract rail a real UEI path and rewrites the
-- name-fallback predicate to `lower(contractor_name) = ANY(...)` (the same
-- case-insensitivity fix already applied to the assistance rail in
-- 20260801010000_faa_recipient_name_btree, for the identical reason:
-- USAspending returns names uppercase while ClientIntelMapping.externalName
-- is operator-entered). Neither predicate had a serving index before this:
--
--   - `recipient_uei = ANY($1)` had no index on `federal_award.recipient_uei`
--     at all — every UEI-basis contract query would sequentially scan the
--     table.
--   - `lower(contractor_name) = ANY($1)` cannot use a bare index on
--     `contractor_name` (functional predicate), and there is no existing
--     trigram/functional index on this column to fall back to.
--
-- ── PRODUCTION DEPLOYMENT — READ BEFORE RUNNING migrate deploy ─────────────
--
-- `federal_award` is a live, continuously-ingested table (unlike
-- federal_assistance_award at the time of 20260801010000, which was empty).
-- A plain CREATE INDEX takes a lock for the duration of the build, which on
-- this table's real row count is NOT an acceptable production migration
-- step to run inline.
--
-- Required procedure for capiro-dev / production:
--   1. Before running `prisma migrate deploy`, create both indexes manually,
--      out-of-band, with CONCURRENTLY (which cannot run inside Prisma's
--      migration transaction):
--        CREATE INDEX CONCURRENTLY IF NOT EXISTS "federal_award_contractor_name_lower_idx"
--          ON "federal_award" (lower("contractor_name"));
--        CREATE INDEX CONCURRENTLY IF NOT EXISTS "federal_award_recipient_uei_idx"
--          ON "federal_award" ("recipient_uei");
--   2. Verify BOTH report pg_index.indisvalid = true. A CONCURRENTLY build
--      that fails leaves an INVALID index of the same name, and the
--      IF NOT EXISTS below checks name existence, not validity — it would
--      silently skip re-creating it and leave prod on the slow seq-scan plan.
--   3. Only then run `prisma migrate deploy`, so the statements below become
--      a no-op via IF NOT EXISTS. Where an environment has NOT been
--      pre-seeded this way (a fresh/empty database), the plain CREATE INDEX
--      below takes a brief lock, which is acceptable there.
--
-- This migration is NOT applied to production as part of Release 1's
-- publication — see the PR description.
--
-- Rollback: DROP INDEX "federal_award_contractor_name_lower_idx";
--           DROP INDEX "federal_award_recipient_uei_idx";

CREATE INDEX IF NOT EXISTS "federal_award_contractor_name_lower_idx"
  ON "federal_award" (lower("contractor_name"));

CREATE INDEX IF NOT EXISTS "federal_award_recipient_uei_idx"
  ON "federal_award" ("recipient_uei");
