-- G4 — named-reviewer routing for held deliverables (blueprint §3.3).
--
-- The enforce flip (Phase 2.5) made the grounding auditor genuinely HOLD
-- client-facing deliverables, but a held item had NO review/release path:
-- alert-memo `held` just skipped auto-file, research `heldForReview` was
-- written and read nowhere. This table is the memory_candidate lifecycle
-- (propose → pending → approve/reject with decided stamps) generalized to
-- deliverables, plus a NAMED reviewer (`assigned_to`).
--
-- payload_jsonb carries everything approve needs to RELEASE the deliverable
-- (a held memo's rendered markdown + title + client, a held research
-- artifact's id) — the held content is otherwise transient.
--
-- Tenant-scoped + RLS-isolated per the meri_audit_ledger template.
CREATE TABLE "review_request" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "risk_tier" VARCHAR(16) NOT NULL,
    "surface" VARCHAR(24) NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" TEXT,
    "client_id" UUID,
    "title" VARCHAR(300) NOT NULL,
    -- Why it was held: the auditor finding summary shown to the reviewer.
    "reason" TEXT NOT NULL,
    "payload_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "requested_by" UUID,
    -- The NAMED reviewer (users.id). NULL until a user_admin assigns.
    "assigned_to" UUID,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "review_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "review_request_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "review_request_tier_chk"
        CHECK ("risk_tier" IN ('low', 'moderate', 'high', 'restricted')),
    CONSTRAINT "review_request_surface_chk"
        CHECK ("surface" IN ('alert-memo', 'district-brief', 'research')),
    CONSTRAINT "review_request_status_chk"
        CHECK ("status" IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX "review_request_tenant_status_idx"
    ON "review_request" ("tenant_id", "status", "created_at" DESC);
CREATE INDEX "review_request_assigned_idx"
    ON "review_request" ("tenant_id", "assigned_to", "status");
CREATE INDEX "review_request_subject_idx"
    ON "review_request" ("tenant_id", "subject_type", "subject_id");

ALTER TABLE "review_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY "review_request_select" ON "review_request"
    FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "review_request_insert" ON "review_request"
    FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "review_request_update" ON "review_request"
    FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY "review_request_delete" ON "review_request"
    FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
