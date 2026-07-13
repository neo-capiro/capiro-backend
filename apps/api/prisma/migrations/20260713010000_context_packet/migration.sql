-- Context Compiler v1 packet trace (G1, blueprint §4.6.4).
--
-- One row per compiled steering-context packet: WHICH memory files reached a
-- generation prompt (items_jsonb: [{layer,id,type,slug,chars,rationale}]) and
-- which were deliberately withheld and why (exclusions_jsonb:
-- [{layer,id,type,slug,reason}], reason ∈ revoked|superseded|empty|
-- over-budget|unauthorized). The scalar columns are what dashboards and the
-- §12.6 context-parity metric group by; the jsonb payloads let the item shape
-- evolve without a migration (same doctrine as meri_audit_ledger's
-- findings_jsonb). `ref_jsonb` carries the surface-local anchor
-- (conversationId / draftId / outreachId / alertId).
--
-- Written FIRE-AND-FORGET by the compiler adapters in apps/api, the
-- orchestrator (shared Prisma client), and apps/workspace (raw INSERT) — a
-- trace failure must never cost a user their draft, so no caller awaits this.
--
-- Tenant-scoped + RLS-isolated exactly like meri_audit_ledger: per-command
-- policies, FORCE ROW LEVEL SECURITY, no null-tenant path (every compile runs
-- inside a tenant session).
CREATE TABLE "context_packet" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "surface" VARCHAR(24) NOT NULL,
    "user_id" UUID,
    "client_id" UUID,
    "ref_jsonb" JSONB NOT NULL DEFAULT '{}',
    "items_jsonb" JSONB NOT NULL DEFAULT '[]',
    "exclusions_jsonb" JSONB NOT NULL DEFAULT '[]',
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "exclusion_count" INTEGER NOT NULL DEFAULT 0,
    "block_chars" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "context_packet_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "context_packet_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "context_packet_tenant_created_idx"
    ON "context_packet" ("tenant_id", "created_at" DESC);
CREATE INDEX "context_packet_tenant_surface_idx"
    ON "context_packet" ("tenant_id", "surface", "created_at" DESC);

ALTER TABLE "context_packet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "context_packet" FORCE ROW LEVEL SECURITY;

CREATE POLICY "context_packet_select" ON "context_packet"
    FOR SELECT
    USING (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "context_packet_insert" ON "context_packet"
    FOR INSERT
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "context_packet_update" ON "context_packet"
    FOR UPDATE
    USING (rls_bypass() OR tenant_id = current_tenant_id())
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "context_packet_delete" ON "context_packet"
    FOR DELETE
    USING (rls_bypass() OR tenant_id = current_tenant_id());
