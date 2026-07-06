-- MeriV2 write-tool approval store (Workstream B4). Additive: a new table only,
-- no change to any existing column. Backs the orchestrator's ApprovalStore —
-- when a compliance decision is WARN, the write is held until a human approves
-- THIS exact action (identified by its stable fingerprint). One approved row
-- per (tenant, user, fingerprint).
--
-- RLS: tenant-isolated like every other tenant-scoped apps/api table, using the
-- current_tenant_id()/rls_bypass() policy functions from migration
-- 20260501000000_init_identity_tenancy. Callers use PrismaService.withTenant.

CREATE TABLE "meri_action_approval" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID         NOT NULL,
  "user_id"     TEXT         NOT NULL,
  "fingerprint" VARCHAR(64)  NOT NULL,
  "tool"        VARCHAR(120) NOT NULL,
  "status"      TEXT         NOT NULL DEFAULT 'approved',
  "approved_by" TEXT         NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "meri_action_approval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meri_action_approval_tenant_user_fp_uniq"
  ON "meri_action_approval" ("tenant_id", "user_id", "fingerprint");
CREATE INDEX "meri_action_approval_user_created_idx"
  ON "meri_action_approval" ("tenant_id", "user_id", "created_at" DESC);

ALTER TABLE "meri_action_approval"
  ADD CONSTRAINT "meri_action_approval_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fail-closed tenant isolation (tenant_id is UUID here → no ::text cast needed,
-- unlike the intel_* tables).
ALTER TABLE "meri_action_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_action_approval" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_action_approval_isolation" ON "meri_action_approval"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_action_approval" TO capiro_app;
  END IF;
END
$$;
