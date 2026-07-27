-- Gate I (CG-01) — server-owned generation record makes memo/brief filing
-- fail-closed on every hold source, and scopes the audit-ledger hold lookup
-- to the client/alert it actually concerns instead of the whole tenant.
-- See I_GOVERNANCE.md phase b.
--
-- ADDITIVE ONLY: one new table (RLS per the meri_audit_ledger template) plus
-- two nullable columns on the existing meri_audit_ledger table. No DROP, no
-- type change, no NOT NULL without a default. Every statement is guarded so a
-- retry after a partial failure is a no-op.

CREATE TABLE IF NOT EXISTS "alert_generation_record" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "alert_id" VARCHAR(128) NOT NULL,
    "surface" VARCHAR(24) NOT NULL,
    "hold_source" VARCHAR(16) NOT NULL,
    "hold_reason" TEXT,
    "review_request_id" UUID,
    "filing_state" VARCHAR(32) NOT NULL,
    "content_hash" VARCHAR(80) NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "alert_generation_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alert_generation_record_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "alert_generation_record_review_fkey" FOREIGN KEY ("review_request_id")
        REFERENCES "review_request"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "alert_generation_record_surface_chk"
        CHECK ("surface" IN ('alert-memo', 'district-brief')),
    CONSTRAINT "alert_generation_record_hold_source_chk"
        CHECK ("hold_source" IN ('none', 'entailment', 'auditor', 'both')),
    CONSTRAINT "alert_generation_record_filing_state_chk"
        CHECK ("filing_state" IN ('draft', 'filed', 'blocked_pending_review'))
);

CREATE INDEX IF NOT EXISTS "alert_generation_record_tenant_client_alert_idx"
    ON "alert_generation_record" ("tenant_id", "client_id", "alert_id", "created_at" DESC);

ALTER TABLE "alert_generation_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_generation_record" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'alert_generation_record' AND policyname = 'alert_generation_record_select'
  ) THEN
    CREATE POLICY "alert_generation_record_select" ON "alert_generation_record"
        FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'alert_generation_record' AND policyname = 'alert_generation_record_insert'
  ) THEN
    CREATE POLICY "alert_generation_record_insert" ON "alert_generation_record"
        FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'alert_generation_record' AND policyname = 'alert_generation_record_update'
  ) THEN
    CREATE POLICY "alert_generation_record_update" ON "alert_generation_record"
        FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
        WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'alert_generation_record' AND policyname = 'alert_generation_record_delete'
  ) THEN
    CREATE POLICY "alert_generation_record_delete" ON "alert_generation_record"
        FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END $$;

-- Gate I phase b-8: scope the saveEdited L0 recent-hold lookup to the
-- client/alert it actually concerns, instead of any hold anywhere in the
-- tenant blocking every banner-bearing save for 24h. Nullable, no backfill:
-- existing rows predate per-client attribution and stay NULL, which the
-- scoped lookup treats as "not this alert" — never a false match — so no
-- historical hold row starts newly blocking a save.
ALTER TABLE "meri_audit_ledger"
  ADD COLUMN IF NOT EXISTS "client_id" UUID,
  ADD COLUMN IF NOT EXISTS "alert_id" VARCHAR(128);

CREATE INDEX IF NOT EXISTS "meri_audit_ledger_tenant_client_alert_idx"
    ON "meri_audit_ledger" ("tenant_id", "client_id", "alert_id", "decision", "created_at" DESC);
