-- GAI-13 — per-user ownership + FORCE RLS on clio_proactive_alerts.
--
-- Today the table has NO RLS and every UI read (listAlerts) is tenant-wide, so
-- every user in a tenant sees (and can dismiss) every other user's PERSONAL
-- alerts — scheduled-task research digests and per-user meeting briefings. This
-- adds an owner_user_id column and an owner-aware FORCE RLS policy mirroring the
-- memory_items pattern (20260712030000): a row is visible when it is tenant-
-- broadcast (owner_user_id IS NULL) or owned by the current user
-- (current_user_id()). NULL owner is preserved for genuinely tenant-wide alerts
-- (client_activity, stale_position, campaign_recommendation).
--
-- ⚠️ RLS + backfill migration — same risk class as the clio_memory /
--    memory_items rollouts. Clone-rehearse on an Aurora copy before prod, and
--    ship in the SAME deploy as the caller conversions (listAlerts / dismissAlert
--    -> withTenantUser; scheduled writers set owner_user_id). A serve-path
--    caller that reads under withTenant (tenant GUC only, no app.current_user)
--    will see ONLY broadcast rows — personal alerts vanish for their owner too
--    until the caller uses withTenantUser.

-- 1. Column (nullable; NULL = tenant-broadcast).
ALTER TABLE "clio_proactive_alerts" ADD COLUMN "owner_user_id" UUID;

-- 2. Backfill personal alerts from the owner already stored in metadata_jsonb
--    (guarded casts — current_user_id() swallows bad text, a plain cast would
--    not, so only convert values that are valid UUIDs).
UPDATE "clio_proactive_alerts"
SET "owner_user_id" = ("metadata_jsonb" ->> 'ownerUserId')::uuid
WHERE "alert_type" = 'scheduled_task'
  AND "metadata_jsonb" ? 'ownerUserId'
  AND ("metadata_jsonb" ->> 'ownerUserId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

UPDATE "clio_proactive_alerts"
SET "owner_user_id" = ("metadata_jsonb" ->> 'userId')::uuid
WHERE "alert_type" = 'meeting_briefing'
  AND "metadata_jsonb" ? 'userId'
  AND ("metadata_jsonb" ->> 'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- 3. Owner-aware index (matches the new listAlerts read).
CREATE INDEX IF NOT EXISTS "clio_proactive_alerts_tenant_owner_status_created_idx"
  ON "clio_proactive_alerts" ("tenant_id", "owner_user_id", "status", "created_at" DESC);

-- 4. FORCE RLS with the owner-aware policy (role-less; applies to all roles).
ALTER TABLE "clio_proactive_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_proactive_alerts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "clio_proactive_alerts_isolation" ON "clio_proactive_alerts"
  USING (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (owner_user_id IS NULL OR owner_user_id = current_user_id())
    )
  )
  WITH CHECK (
    rls_bypass() OR (
      tenant_id = current_tenant_id()
      AND (owner_user_id IS NULL OR owner_user_id = current_user_id())
    )
  );

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "clio_proactive_alerts" TO capiro_app;
  END IF;
END $$;
