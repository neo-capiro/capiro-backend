-- A capability is stored only as a SHA-256 hash. Anonymous requests are scoped
-- to the tenant embedded in the capability, without cross-tenant RLS bypass.
ALTER TABLE "sp_planner_resources" ADD COLUMN "share_token_hash" TEXT;
CREATE UNIQUE INDEX "sp_planner_resources_tenant_share_token_key"
  ON "sp_planner_resources" ("tenant_id", "share_token_hash")
  WHERE "share_token_hash" IS NOT NULL;
