-- Agentic Tier-1/Tier-2 run provenance (Phase 1 M5.0, agentic doc SS5.1).
--
-- ai_run: one row per agent invocation -- workflow/rail/subject envelope,
-- prompt+model+provider, tool-call trace, the GroundedJson output, the
-- deterministic validator's verdict, and the interim QA-gating state. This is
-- the proposal's per-output guardrail list (schema, source ids, evidence,
-- confidence, model + prompt version, run id, tool calls, validation status,
-- human-review status) as COLUMNS, not prose.
--
-- tenant_id is NULLABLE: a tenant-agnostic cached-L1 enrichment run (not tied
-- to one tenant's private data) writes tenant_id = NULL and is a GLOBAL row;
-- a Tier-2 targeting/rules-comparison run is tenant-scoped and RLS-isolated
-- like ai_usage_events. WITH CHECK deliberately does NOT include
-- "tenant_id IS NULL" -- only a system-principal (withSystem/rls_bypass)
-- session may insert a tenant-agnostic row; an ordinary tenant session cannot.
-- USING DOES include it, since a tenant-agnostic run is non-tenant-specific
-- provenance every tenant may read (mirrors public reference-data tables).
CREATE TABLE "ai_run" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "workflow" VARCHAR(48) NOT NULL,
    "rail" VARCHAR(16) NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_key" TEXT NOT NULL,
    "tenant_id" UUID,
    -- W3.1: the client a tenant-scoped Tier-2 run was FOR (targeting briefs are
    -- per-client). Null for client-agnostic runs. Lets the idempotency guard key
    -- on (bill, client, tenant) so a second client on the same bill still gets a brief.
    "client_id" UUID,
    "prompt_version" VARCHAR(32) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "used_tenant_key" BOOLEAN NOT NULL DEFAULT false,
    "input_refs" JSONB NOT NULL DEFAULT '[]',
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "output" JSONB,
    "confidence" DOUBLE PRECISION,
    -- W3.1: per-gate drop counts (kept / (kept + sum) = confidence). Makes
    -- "dropped and logged" (M5-B) inspectable from the row alone.
    "dropped_by_grounding" INTEGER NOT NULL DEFAULT 0,
    "dropped_by_validator" INTEGER NOT NULL DEFAULT 0,
    "dropped_off_roster" INTEGER NOT NULL DEFAULT 0,
    "validation_status" VARCHAR(16) NOT NULL,
    "qa_status" VARCHAR(16) NOT NULL DEFAULT 'none',
    "human_reviewed_by" UUID,
    "human_reviewed_at" TIMESTAMPTZ(6),
    "status" VARCHAR(16) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "ai_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_run_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ai_run_workflow_created_idx" ON "ai_run" ("workflow", "created_at");
CREATE INDEX "ai_run_subject_idx" ON "ai_run" ("subject_type", "subject_key");
CREATE INDEX "ai_run_tenant_created_idx" ON "ai_run" ("tenant_id", "created_at");
-- W3.1: covers the run-intel-workflows idempotency guard's correlated subquery
-- (workflow + subject_key + tenant_id + client_id equality, then created_at range).
CREATE INDEX "ai_run_targeting_guard_idx" ON "ai_run" ("workflow", "subject_key", "tenant_id", "client_id", "created_at");

ALTER TABLE "ai_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_run_isolation" ON "ai_run"
    USING (rls_bypass() OR tenant_id = current_tenant_id() OR tenant_id IS NULL)
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- recordAiUsageEvent tenant-agnostic path (M5.0): relax ai_usage_events.tenant_id
-- to nullable so a system-scoped (withSystem) metering call for a
-- tenant-agnostic L1 run can insert tenant_id = NULL. Application-layer
-- filtering (ai-usage.service.ts) excludes these rows from per-tenant
-- usage/billing reports; they bucket into a platform-cost rollup instead.
--
-- No RLS POLICY TEXT change is needed: the existing
-- "rls_bypass() OR tenant_id = current_tenant_id()" WITH CHECK already only
-- admits a NULL-tenant insert when rls_bypass() is true -- under a normal
-- tenant session, "NULL = current_tenant_id()" evaluates to NULL, which
-- Postgres RLS treats as "does not satisfy" (not TRUE), so an ordinary
-- tenant session can never insert (or, symmetrically, select) a null-tenant
-- row. Only a system-principal session can.
ALTER TABLE "ai_usage_events" ALTER COLUMN "tenant_id" DROP NOT NULL;
