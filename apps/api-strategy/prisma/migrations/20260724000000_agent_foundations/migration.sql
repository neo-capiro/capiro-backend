-- Phase 2 Stage C — agent runtime foundations (additive only).
--
-- Context Steward / Strategy Watcher / Execution Agent substrate:
-- sp_context_document / sp_context_fact / sp_context_conflict (Stage D/E
-- corpus), sp_agent_mission / sp_agent_run (run lifecycle), sp_change_set
-- (proposals), sp_agent_permission_policy (risk knobs), sp_event_outbox
-- (transactional outbox for the F2 consumer).
--
-- DDL generated via `prisma migrate diff --from-empty` before/after delta;
-- RLS block hand-written to match 20260722000000_init_strategy's idiom. Same
-- RLS caveat as G1: capiro_app currently bypasses RLS (policies are the
-- forward-ready DB boundary; real isolation is the withTenant query hook).
--
-- ROLLBACK (manual, reverse order — additive migration, no data loss for
-- pre-existing tables):
--   DROP TABLE IF EXISTS "sp_event_outbox", "sp_agent_permission_policy",
--     "sp_change_set", "sp_agent_run", "sp_agent_mission",
--     "sp_context_conflict", "sp_context_fact", "sp_context_document" CASCADE;
--   DROP TYPE IF EXISTS "sp_change_set_risk", "sp_change_set_status",
--     "sp_run_trigger", "sp_run_state", "sp_mission_state",
--     "sp_conflict_state", "sp_fact_state", "sp_context_scope",
--     "sp_context_doc_state";

-- CreateEnum
CREATE TYPE "sp_context_doc_state" AS ENUM ('draft', 'active', 'superseded', 'archived');

-- CreateEnum
CREATE TYPE "sp_context_scope" AS ENUM ('once', 'node', 'strategy', 'client', 'firm');

-- CreateEnum
CREATE TYPE "sp_fact_state" AS ENUM ('active', 'superseded', 'stale', 'rejected');

-- CreateEnum
CREATE TYPE "sp_conflict_state" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "sp_mission_state" AS ENUM ('draft', 'active', 'paused', 'completed', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "sp_run_state" AS ENUM ('queued', 'planning', 'waiting_for_input', 'executing', 'ready_for_review', 'completed', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "sp_run_trigger" AS ENUM ('manual', 'scheduled', 'event');

-- CreateEnum
CREATE TYPE "sp_change_set_status" AS ENUM ('proposed', 'approved', 'rejected', 'applied', 'undone', 'stale');

-- CreateEnum
CREATE TYPE "sp_change_set_risk" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateTable
CREATE TABLE "sp_context_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "scope" "sp_context_scope" NOT NULL,
    "scope_ref" UUID,
    "template_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" "sp_context_doc_state" NOT NULL DEFAULT 'draft',
    "content" TEXT NOT NULL,
    "frontmatter" JSONB,
    "checksum" TEXT NOT NULL,
    "supersedes_id" UUID,
    "valid_until" DATE,
    "created_by_user_id" TEXT NOT NULL,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_context_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_context_fact" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "client_id" UUID,
    "fact" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "authority" TEXT,
    "as_of" DATE,
    "confidence" DOUBLE PRECISION,
    "state" "sp_fact_state" NOT NULL DEFAULT 'active',
    "citation" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_context_fact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_context_conflict" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fact_a_id" UUID NOT NULL,
    "fact_b_id" UUID NOT NULL,
    "material" BOOLEAN NOT NULL DEFAULT false,
    "state" "sp_conflict_state" NOT NULL DEFAULT 'open',
    "resolution_note" TEXT,
    "resolved_by_user_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_context_conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_agent_mission" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "strategy_id" UUID,
    "client_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" "sp_mission_state" NOT NULL DEFAULT 'draft',
    "cadence" TEXT,
    "next_run_at" TIMESTAMP(3),
    "created_by_user_id" TEXT NOT NULL,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_agent_mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_agent_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mission_id" UUID NOT NULL,
    "strategy_id" UUID,
    "state" "sp_run_state" NOT NULL DEFAULT 'queued',
    "trigger" "sp_run_trigger" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "findings" JSONB,
    "waiting_reason" TEXT,
    "error" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_change_set" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "run_id" UUID,
    "summary" TEXT NOT NULL,
    "ops" JSONB NOT NULL,
    "risk" "sp_change_set_risk" NOT NULL,
    "status" "sp_change_set_status" NOT NULL DEFAULT 'proposed',
    "strategy_version_id" UUID NOT NULL,
    "applied_version_id" UUID,
    "approved_by_user_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_ops" JSONB,
    "rejected_by_user_id" TEXT,
    "rejected_at" TIMESTAMP(3),
    "applied_by_user_id" TEXT,
    "applied_at" TIMESTAMP(3),
    "undone_by_user_id" TEXT,
    "undone_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_change_set_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_agent_permission_policy" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_agent_permission_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_event_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "sp_event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sp_context_document_tenant_id_client_id_state_idx" ON "sp_context_document"("tenant_id", "client_id", "state");

-- CreateIndex
CREATE INDEX "sp_context_document_tenant_id_template_key_state_idx" ON "sp_context_document"("tenant_id", "template_key", "state");

-- CreateIndex
CREATE INDEX "sp_context_fact_tenant_id_document_id_idx" ON "sp_context_fact"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "sp_context_fact_tenant_id_client_id_state_idx" ON "sp_context_fact"("tenant_id", "client_id", "state");

-- CreateIndex
CREATE INDEX "sp_context_conflict_tenant_id_state_idx" ON "sp_context_conflict"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "sp_agent_mission_tenant_id_strategy_id_idx" ON "sp_agent_mission"("tenant_id", "strategy_id");

-- CreateIndex
CREATE INDEX "sp_agent_mission_state_next_run_at_idx" ON "sp_agent_mission"("state", "next_run_at");

-- CreateIndex
CREATE INDEX "sp_agent_run_tenant_id_mission_id_created_at_idx" ON "sp_agent_run"("tenant_id", "mission_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sp_agent_run_tenant_id_idempotency_key_key" ON "sp_agent_run"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "sp_change_set_tenant_id_strategy_id_status_idx" ON "sp_change_set"("tenant_id", "strategy_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sp_agent_permission_policy_tenant_id_key_key" ON "sp_agent_permission_policy"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "sp_event_outbox_consumed_at_created_at_idx" ON "sp_event_outbox"("consumed_at", "created_at");

-- CreateIndex
CREATE INDEX "sp_event_outbox_tenant_id_created_at_idx" ON "sp_event_outbox"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "sp_context_fact" ADD CONSTRAINT "sp_context_fact_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "sp_context_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sp_agent_run" ADD CONSTRAINT "sp_agent_run_mission_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "sp_agent_mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-Level Security (same tenant-isolation policy as init_strategy; the GUC
-- helper functions current_tenant_id()/rls_bypass() already exist from G1).
-- ---------------------------------------------------------------------------

ALTER TABLE "sp_context_document" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_context_document" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_context_document_isolation" ON "sp_context_document"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_context_fact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_context_fact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_context_fact_isolation" ON "sp_context_fact"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_context_conflict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_context_conflict" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_context_conflict_isolation" ON "sp_context_conflict"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_agent_mission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_agent_mission" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_agent_mission_isolation" ON "sp_agent_mission"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_agent_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_agent_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_agent_run_isolation" ON "sp_agent_run"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_change_set" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_change_set" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_change_set_isolation" ON "sp_change_set"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_agent_permission_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_agent_permission_policy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_agent_permission_policy_isolation" ON "sp_agent_permission_policy"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_event_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_event_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_event_outbox_isolation" ON "sp_event_outbox"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
