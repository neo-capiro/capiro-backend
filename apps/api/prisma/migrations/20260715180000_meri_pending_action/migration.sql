-- Fix for the "approving a WARN-held write never actually runs it" bug.
-- Additive: a new table only, no change to any existing column.
--
-- The compliance gate's WARN decision was only ever tracked by an opaque
-- fingerprint (meri_action_approval) — the exact tool name + input behind
-- that fingerprint was never persisted anywhere. So "approve" could only
-- re-run the WHOLE chat turn and hope the model re-derived byte-identical
-- input on its own (it never reliably does — it re-researches/rewords), which
-- silently produced a NEW fingerprint that was never approved, forever.
--
-- This table captures the exact {tool, input} the moment the gate WARNs,
-- keyed by the SAME fingerprint the approval row uses, so approval can
-- directly execute the cached input instead of re-asking the model.
--
-- RLS: tenant-isolated like every other tenant-scoped apps/api table, using the
-- current_tenant_id()/rls_bypass() policy functions from migration
-- 20260501000000_init_identity_tenancy. Callers use PrismaService.withTenant.

CREATE TABLE "meri_pending_action" (
  "id"           UUID          NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    UUID          NOT NULL,
  "user_id"      TEXT          NOT NULL,
  "fingerprint"  VARCHAR(64)   NOT NULL,
  "tool"         VARCHAR(120)  NOT NULL,
  "input_jsonb"  JSONB         NOT NULL,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "consumed_at"  TIMESTAMPTZ(6),
  CONSTRAINT "meri_pending_action_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meri_pending_action_tenant_user_fp_uniq"
  ON "meri_pending_action" ("tenant_id", "user_id", "fingerprint");
CREATE INDEX "meri_pending_action_user_created_idx"
  ON "meri_pending_action" ("tenant_id", "user_id", "created_at" DESC);

ALTER TABLE "meri_pending_action"
  ADD CONSTRAINT "meri_pending_action_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fail-closed tenant isolation (tenant_id is UUID here → no ::text cast needed,
-- unlike the intel_* tables).
ALTER TABLE "meri_pending_action" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_pending_action" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_pending_action_isolation" ON "meri_pending_action"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_pending_action" TO capiro_app;
  END IF;
END
$$;
