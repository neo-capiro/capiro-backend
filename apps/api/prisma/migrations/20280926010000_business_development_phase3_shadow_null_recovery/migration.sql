-- Business Development Phase 3 hotfix — shadow SQL-NULL recovery.
--
-- Root cause: the shadow completion update supplied JavaScript null to the
-- Prisma Json column visible_effect_jsonb, which Prisma encodes as JSON null
-- instead of database NULL. That violates
-- business_development_jev_decisions_shadow_invisible_check (SQLSTATE 23514),
-- so successful provider calls were stranded as status = 'pending'.
--
-- This migration is NARROWLY SCOPED: it reclassifies only sufficiently old
-- (>= 10 minutes) shadow + pending rows — left stranded by this exact
-- defect — as failed with an honest recovery reason, stamps
-- completion/update timestamps, and moves their idempotency keys into a
-- deterministic unique recovery namespace so a post-hotfix open can record
-- a fresh decision. It never touches completed rows, canary rows,
-- current/in-flight rows, prompts or source text, or any other table.
--
-- Staleness threshold rationale: 10 minutes is conservative against every
-- legitimate in-flight write. The provider call itself is bounded (8s
-- timeout), and the completion UPDATE follows it in-process within
-- milliseconds; a pending shadow row older than 10 minutes can only be a
-- stranded completion (this defect, or an already-crashed worker), never a
-- live one. Meanwhile the live stranded row created during this rollout is
-- already well over 10 minutes old, so this frees its idempotency key in
-- the same deploy rather than waiting 24h. Re-running the migration is a no-op:
-- recovered rows no longer match status = 'pending'.
--
-- The recovery key embeds the row id (globally unique, deterministic) rather
-- than the old key, keeping it far under the VARCHAR(400) limit regardless of
-- how long the original key was.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'business_development_jev_decisions')
     AND EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'business_development_jev_decisions_shadow_invisible_check'
     )
  THEN
    UPDATE "business_development_jev_decisions"
    SET "status"           = 'failed',
        "operational_state" = 'not_checked',
        "reason_codes"      = ARRAY['completion_write_failed_shadow_sql_null'],
        "completed_at"      = now(),
        "updated_at"        = now(),
        "idempotency_key"   = 'shadow-null-completion-recovery-20260926010000|' || "id"::text
    WHERE "mode" = 'shadow'
      AND "status" = 'pending'
      AND "requested_at" < now() - INTERVAL '10 minutes';
  END IF;
END
$$;
