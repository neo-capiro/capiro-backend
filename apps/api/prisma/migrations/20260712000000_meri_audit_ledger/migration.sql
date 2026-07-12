-- Post-hoc grounding-auditor ledger (v3 hallucination plan Wave 5).
--
-- One row per audited generation turn: the auditor's verdict (decision +
-- top severity) plus the exact findings, so the SHADOW-mode findings the
-- auditor logs are also queryable/aggregable for the lexicon tuning that must
-- precede any per-surface `enforce` flip. Findings live in `findings_jsonb`
-- (array of { check, severity, span, detail }) so the deterministic check set
-- can evolve without a migration; the scalar columns are what dashboards group by.
--
-- Tenant-scoped + RLS-isolated exactly like ai_run's tenant-scoped rows:
-- per-command policies (own-tenant-or-system), FORCE ROW LEVEL SECURITY. There
-- is NO tenant-agnostic (tenant_id IS NULL) path here — every audited turn runs
-- inside a tenant session, so tenant_id is NOT NULL and the policies never admit
-- a null-tenant row.
CREATE TABLE "meri_audit_ledger" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "surface" VARCHAR(16) NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "conversation_id" UUID,
    "model" VARCHAR(80),
    "decision" VARCHAR(24) NOT NULL,
    "top_severity" VARCHAR(12),
    "finding_count" INTEGER NOT NULL DEFAULT 0,
    "findings_jsonb" JSONB NOT NULL DEFAULT '[]',
    "output_chars" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "meri_audit_ledger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "meri_audit_ledger_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "meri_audit_ledger_tenant_created_idx"
    ON "meri_audit_ledger" ("tenant_id", "created_at" DESC);
CREATE INDEX "meri_audit_ledger_surface_severity_idx"
    ON "meri_audit_ledger" ("surface", "top_severity", "created_at" DESC);

ALTER TABLE "meri_audit_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_audit_ledger" FORCE ROW LEVEL SECURITY;

CREATE POLICY "meri_audit_ledger_select" ON "meri_audit_ledger"
    FOR SELECT
    USING (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "meri_audit_ledger_insert" ON "meri_audit_ledger"
    FOR INSERT
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "meri_audit_ledger_update" ON "meri_audit_ledger"
    FOR UPDATE
    USING (rls_bypass() OR tenant_id = current_tenant_id())
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "meri_audit_ledger_delete" ON "meri_audit_ledger"
    FOR DELETE
    USING (rls_bypass() OR tenant_id = current_tenant_id());
