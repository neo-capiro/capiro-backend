-- Strategy Planner (api-strategy) initial migration.
--
-- Structure: Prisma-generated DDL (from `prisma migrate diff --from-empty`)
-- followed by hand-written RLS + append-only SQL (mirrors apps/api's
-- migration idioms).
--
-- ⚠️ RLS CAVEAT (load-bearing): the runtime `capiro_app` role is a member of
-- the table-owner role and BYPASSES Postgres RLS, so these policies are
-- belt-and-suspenders / a forward-ready DB boundary — NOT effective enforcement
-- today. Real tenant isolation is PrismaService.withTenant's in-query
-- `where.tenant_id` injection (enforced by the tenant-scope-guard build gate).
-- The sp_activity_log append-only TRIGGER, by contrast, DOES bind every role
-- (triggers fire for owners too), so it is real enforcement.

-- CreateEnum
CREATE TYPE "sp_strategy_type" AS ENUM ('appropriations', 'authorization', 'regulatory', 'coalition', 'procurement', 'earmark');

-- CreateEnum
CREATE TYPE "sp_node_kind" AS ENUM ('action', 'decision', 'gate', 'milestone', 'risk');

-- CreateEnum
CREATE TYPE "sp_node_subject" AS ENUM ('deliverable', 'submission', 'member', 'committee', 'ask', 'agency', 'outcome', 'optics');

-- CreateEnum
CREATE TYPE "sp_node_status" AS ENUM ('draft', 'in_progress', 'internal_review', 'active', 'suggested');

-- CreateEnum
CREATE TYPE "sp_author_kind" AS ENUM ('person', 'meri');

-- CreateEnum
CREATE TYPE "sp_ref_kind" AS ENUM ('congress_milestone', 'ppbe_lane_bar', 'ppbe_current_phase');

-- CreateEnum
CREATE TYPE "sp_artifact_type" AS ENUM ('workspace_draft', 'outreach_record');

-- CreateTable
CREATE TABLE "sp_strategy" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "type" "sp_strategy_type" NOT NULL,
    "goal" TEXT,
    "meri_context" TEXT,
    "target_date" DATE,
    "owner_user_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "last_edited_by_user_id" TEXT,
    "last_edited_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_node" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "kind" "sp_node_kind" NOT NULL,
    "subject" "sp_node_subject" NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "owner_user_id" TEXT,
    "status" "sp_node_status" NOT NULL DEFAULT 'draft',
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "open_ended" BOOLEAN NOT NULL DEFAULT false,
    "meri_authored" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "author_kind" "sp_author_kind" NOT NULL,
    "author_user_id" TEXT,
    "note" TEXT NOT NULL,
    "restored_from_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sp_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_firm_phase" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "start_fy" INTEGER NOT NULL,
    "start_q" INTEGER NOT NULL,
    "end_fy" INTEGER NOT NULL,
    "end_q" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "updated_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_firm_phase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_reference_entry" (
    "id" UUID NOT NULL,
    "kind" "sp_ref_kind" NOT NULL,
    "label" TEXT NOT NULL,
    "fy" INTEGER,
    "starts_on" DATE,
    "ends_on" DATE,
    "tone" TEXT,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_reference_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_reference_override" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "sp_ref_kind" NOT NULL,
    "label" TEXT NOT NULL,
    "fy" INTEGER,
    "starts_on" DATE,
    "ends_on" DATE,
    "tone" TEXT,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sp_reference_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_node_artifact" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "artifact_type" "sp_artifact_type" NOT NULL,
    "artifact_ref" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sp_node_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sp_activity_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" TEXT,
    "author_kind" "sp_author_kind" NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sp_activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sp_strategy_tenant_id_client_id_idx" ON "sp_strategy"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "sp_strategy_tenant_id_archived_at_idx" ON "sp_strategy"("tenant_id", "archived_at");

-- CreateIndex
CREATE INDEX "sp_node_tenant_id_strategy_id_idx" ON "sp_node"("tenant_id", "strategy_id");

-- CreateIndex
CREATE INDEX "sp_version_tenant_id_strategy_id_created_at_idx" ON "sp_version"("tenant_id", "strategy_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sp_firm_phase_tenant_id_position_idx" ON "sp_firm_phase"("tenant_id", "position");

-- CreateIndex
CREATE INDEX "sp_reference_entry_kind_active_position_idx" ON "sp_reference_entry"("kind", "active", "position");

-- CreateIndex
CREATE INDEX "sp_reference_override_tenant_id_kind_position_idx" ON "sp_reference_override"("tenant_id", "kind", "position");

-- CreateIndex
CREATE INDEX "sp_node_artifact_tenant_id_strategy_id_idx" ON "sp_node_artifact"("tenant_id", "strategy_id");

-- CreateIndex
CREATE UNIQUE INDEX "sp_node_artifact_node_id_artifact_type_artifact_ref_key" ON "sp_node_artifact"("node_id", "artifact_type", "artifact_ref");

-- CreateIndex
CREATE INDEX "sp_activity_log_tenant_id_entity_type_entity_id_occurred_at_idx" ON "sp_activity_log"("tenant_id", "entity_type", "entity_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "sp_node" ADD CONSTRAINT "sp_node_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "sp_strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sp_version" ADD CONSTRAINT "sp_version_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "sp_strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sp_node_artifact" ADD CONSTRAINT "sp_node_artifact_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "sp_node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sp_node_artifact" ADD CONSTRAINT "sp_node_artifact_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "sp_strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- RLS + append-only (hand-written; mirrors apps/api idioms)
-- ============================================================================

-- GUC-reader helpers. These already exist DB-wide (created by apps/api's init
-- migrations) in the shared Aurora; CREATE OR REPLACE keeps this migration
-- self-contained and is idempotent (identical definitions).
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
DECLARE
  v_raw TEXT := current_setting('app.current_tenant', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION rls_bypass() RETURNS BOOLEAN AS $$
BEGIN
  RETURN current_setting('app.bypass_rls', true) = 'on';
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
DECLARE
  v_raw TEXT := current_setting('app.current_user', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Tenant-scoped tables: isolate by tenant_id (bypass for system work).
ALTER TABLE "sp_strategy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_strategy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_strategy_isolation" ON "sp_strategy"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_node" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_node" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_node_isolation" ON "sp_node"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_version" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_version" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_version_isolation" ON "sp_version"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_firm_phase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_firm_phase" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_firm_phase_isolation" ON "sp_firm_phase"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_reference_override" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_reference_override" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_reference_override_isolation" ON "sp_reference_override"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_node_artifact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_node_artifact" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_node_artifact_isolation" ON "sp_node_artifact"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "sp_activity_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_activity_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_activity_log_isolation" ON "sp_activity_log"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- Global reference baseline: readable by everyone, writable only by system
-- (migrate/seed/ops verb set app.bypass_rls). No tenant_id column.
-- Per-command policies (mirrors apps/api ai_run, comment W5.1): a single
-- FOR ALL USING(true) would also govern DELETE row-visibility — and since
-- Postgres consults ONLY the USING clause for DELETE (no WITH CHECK phase),
-- that would let a non-bypass session DELETE global rows. Split so the broad
-- read is SELECT-only and every write (incl. DELETE) is gated on rls_bypass().
ALTER TABLE "sp_reference_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_reference_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_reference_entry_read_all" ON "sp_reference_entry"
  FOR SELECT
  USING (true);
CREATE POLICY "sp_reference_entry_write_system" ON "sp_reference_entry"
  FOR ALL
  USING (rls_bypass())
  WITH CHECK (rls_bypass());

-- Grant the app role table privileges (guarded: capiro_app may not exist on a
-- local dev DB). RLS above still gates the rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sp_strategy" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sp_node" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sp_version" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sp_firm_phase" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sp_reference_entry" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sp_reference_override" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sp_node_artifact" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sp_activity_log" TO capiro_app;
  END IF;
END
$$;

-- Append-only enforcement for sp_activity_log. A BEFORE ROW trigger binds
-- EVERY role (including owners), unlike RLS/REVOKE — this is real enforcement.
-- The only sanctioned escape is `SET LOCAL app.allow_audit_purge = 'on'`
-- (GDPR tenant hard-delete). SQLSTATE 0A000 = feature_not_supported.
CREATE OR REPLACE FUNCTION enforce_sp_activity_log_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_audit_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'append-only: % rows cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '0A000';
  END IF;
  RAISE EXCEPTION 'append-only: % rows cannot be modified', TG_TABLE_NAME
    USING ERRCODE = '0A000';
END;
$$;

DROP TRIGGER IF EXISTS sp_activity_log_append_only ON "sp_activity_log";
CREATE TRIGGER sp_activity_log_append_only
  BEFORE UPDATE OR DELETE ON "sp_activity_log"
  FOR EACH ROW EXECUTE FUNCTION enforce_sp_activity_log_append_only();
