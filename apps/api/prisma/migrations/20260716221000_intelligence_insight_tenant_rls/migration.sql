-- GAI-01 — tenant-scope intelligence_insight + FORCE RLS.
--
-- The table was GLOBAL: tenant-derived AI briefings and per-client health
-- scores were written into it and GET /api/intelligence/insights served every
-- tenant's rows to every tenant; a standard_user could publish into the global
-- feed (GAI-22). This adds tenant_id/client_id and an ai_run-style FORCE RLS
-- policy: a tenant reads its own rows + reviewed PUBLIC rows (tenant_id NULL);
-- a tenant session can only INSERT its own tenant's rows; a NULL-tenant public
-- row requires withSystem (rls_bypass).
--
-- Existing rows carry no reliable tenant column, so we backfill what we can and
-- neutralize the rest rather than leave un-attributable rows readable by all:
--   * health_score rows already stash tenant/client in data_points → backfill.
--   * every other legacy row (briefing, market/changes, lda/spending/etc.) has
--     no trustworthy tenant marker → soft-expire (expires_at = now()) so the
--     read path (which filters on expiry) stops serving it cross-tenant. Rows
--     are ephemeral/regenerable, so this is non-destructive containment.
--
-- ⚠️ RLS + backfill migration — highest risk class (clone-rehearse first). Ship
--    in the SAME deploy as the code that (a) writes tenant_id on every insert
--    via withTenant and (b) reads via withTenant. A writer left on the raw
--    client (no tenant GUC) will FAIL the WITH CHECK once FORCE RLS is on.

-- 1. Columns (nullable; NULL tenant = reviewed public global insight).
ALTER TABLE "intelligence_insight" ADD COLUMN "tenant_id" UUID;
ALTER TABLE "intelligence_insight" ADD COLUMN "client_id" UUID;

-- 2. Backfill health_score rows from the tenant/client stashed in data_points.
UPDATE "intelligence_insight"
SET
  "tenant_id" = ("data_points" ->> 'tenantId')::uuid,
  "client_id" = CASE
    WHEN ("data_points" ->> 'clientId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN ("data_points" ->> 'clientId')::uuid ELSE NULL END
WHERE "category" = 'health_score'
  AND "data_points" ? 'tenantId'
  AND ("data_points" ->> 'tenantId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- 3. Neutralize every remaining un-attributable legacy row: soft-expire so the
--    expiry-filtered read path stops returning it. (A row that just got a
--    tenant_id in step 2 is kept.)
UPDATE "intelligence_insight"
SET "expires_at" = LEAST(COALESCE("expires_at", now()), now())
WHERE "tenant_id" IS NULL;

-- 4. Tenant-scoped index (matches the new withTenant read).
CREATE INDEX IF NOT EXISTS "intelligence_insight_tenant_category_generated_idx"
  ON "intelligence_insight" ("tenant_id", "category", "generated_at");

-- 5. FORCE RLS (ai_run-style: own-tenant + public NULL-tenant reads; own-tenant
--    inserts only; per-command so the read allowance for public rows does not
--    also let a tenant session write a NULL-tenant public row).
ALTER TABLE "intelligence_insight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intelligence_insight" FORCE ROW LEVEL SECURITY;

CREATE POLICY "intelligence_insight_select" ON "intelligence_insight"
  FOR SELECT
  USING (rls_bypass() OR tenant_id = current_tenant_id() OR tenant_id IS NULL);

CREATE POLICY "intelligence_insight_insert" ON "intelligence_insight"
  FOR INSERT
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

CREATE POLICY "intelligence_insight_update" ON "intelligence_insight"
  FOR UPDATE
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

CREATE POLICY "intelligence_insight_delete" ON "intelligence_insight"
  FOR DELETE
  USING (rls_bypass() OR tenant_id = current_tenant_id());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intelligence_insight" TO capiro_app;
  END IF;
END $$;
