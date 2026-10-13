-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "tenant_role" AS ENUM ('capiro_admin', 'user_admin', 'standard_user', 'client_portal_user');

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('active', 'suspended', 'pending');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('invited', 'active', 'removed');

-- CreateEnum
CREATE TYPE "engagement_provider" AS ENUM ('microsoft_365', 'google_workspace', 'imap_caldav', 'manual');

-- CreateEnum
CREATE TYPE "engagement_connection_status" AS ENUM ('needs_configuration', 'connected', 'error', 'disabled');

-- CreateEnum
CREATE TYPE "engagement_source" AS ENUM ('outlook', 'google', 'imap_caldav', 'manual');

-- CreateEnum
CREATE TYPE "association_entity_type" AS ENUM ('meeting', 'mail_thread', 'mail_message', 'contact', 'task');

-- CreateEnum
CREATE TYPE "meeting_prep_status" AS ENUM ('generated', 'edited', 'reviewed', 'approved', 'stale', 'failed');

-- CreateEnum
CREATE TYPE "meeting_visibility" AS ENUM ('private', 'shared');

-- CreateEnum
CREATE TYPE "meeting_debrief_status" AS ENUM ('generated', 'edited', 'approved');

-- CreateEnum
CREATE TYPE "engagement_task_status" AS ENUM ('todo', 'in_progress', 'done', 'blocked', 'canceled');

-- CreateEnum
CREATE TYPE "billing_status" AS ENUM ('none', 'trialing', 'active', 'past_due', 'canceled', 'comped');

-- CreateEnum
CREATE TYPE "admin_broadcast_audience" AS ENUM ('all_users', 'selected_users');

-- CreateEnum
CREATE TYPE "research_portfolio_mode" AS ENUM ('manual', 'rules', 'hybrid');

-- CreateEnum
CREATE TYPE "research_portfolio_lifecycle" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "research_portfolio_grant_role" AS ENUM ('owner', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "research_portfolio_member_kind" AS ENUM ('program', 'program_element', 'project', 'budget_line', 'award');

-- CreateEnum
CREATE TYPE "research_portfolio_member_disposition" AS ENUM ('included', 'candidate', 'withdrawn', 'excluded', 'unresolved');

-- CreateEnum
CREATE TYPE "research_portfolio_member_origin" AS ENUM ('manual', 'rule', 'import');

-- CreateEnum
CREATE TYPE "research_portfolio_event_kind" AS ENUM ('created', 'updated', 'archived', 'restored', 'grant_upserted', 'grant_removed', 'client_linked', 'client_unlinked', 'member_added', 'member_decided', 'member_excluded', 'member_reinstated', 'member_resolved', 'rule_published', 'review_updated', 'annual_reopened', 'import_created', 'import_action', 'review_note_added');

-- CreateEnum
CREATE TYPE "research_portfolio_recompute_status" AS ENUM ('queued', 'running', 'partial', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "research_portfolio_review_status" AS ENUM ('open', 'assigned', 'deferred', 'resolved', 'cancelled');

-- CreateEnum
CREATE TYPE "research_portfolio_review_trigger" AS ENUM ('rule_change', 'annual_continuity', 'import', 'dispute', 'manual');

-- CreateEnum
CREATE TYPE "research_portfolio_review_target_kind" AS ENUM ('program', 'program_element', 'project', 'budget_line', 'award', 'rule', 'portfolio');

-- CreateEnum
CREATE TYPE "research_portfolio_decision_type" AS ENUM ('include', 'exclude', 'defer', 'reopen', 'dispute');

-- CreateEnum
CREATE TYPE "research_portfolio_continuity_status" AS ENUM ('unchanged', 'changed', 'expired', 'renamed', 'renumbered', 'split', 'merged', 'unresolved', 'new');

-- CreateEnum
CREATE TYPE "research_portfolio_import_job_status" AS ENUM ('created', 'mapped', 'previewed', 'applying', 'paused', 'completed', 'partial', 'failed', 'cancelled', 'unknown', 'needs_reconciliation', 'compensated');

-- CreateEnum
CREATE TYPE "research_portfolio_import_worksheet_kind" AS ENUM ('membership', 'rules', 'reviews');

-- CreateEnum
CREATE TYPE "research_portfolio_import_row_outcome" AS ENUM ('applied', 'skipped', 'conflict', 'failed', 'unknown');

-- CreateEnum
CREATE TYPE "research_portfolio_import_row_preview_classification" AS ENUM ('resolved', 'duplicate', 'invalid', 'ambiguous', 'unresolved', 'inaccessible');

-- CreateEnum
CREATE TYPE "research_portfolio_output_status" AS ENUM ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'outcome_unknown');

-- CreateEnum
CREATE TYPE "research_portfolio_delivery_status" AS ENUM ('queued', 'delivered', 'partial', 'failed', 'withheld', 'cancelled', 'outcome_unknown');

-- CreateEnum
CREATE TYPE "research_portfolio_client_filing_status" AS ENUM ('pending', 'outcome_unknown', 'completed');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'pending',
    "plan" TEXT,
    "settings_jsonb" JSONB NOT NULL DEFAULT '{}',
    "kms_key_arn" TEXT,
    "soc2_audit_window" JSONB,
    "clerk_org_id" TEXT,
    "logo_s3_key" TEXT,
    "logo_content_type" TEXT,
    "logo_uploaded_at" TIMESTAMPTZ(6),
    "account_type" TEXT,
    "plan_tier" TEXT NOT NULL DEFAULT 'FOUNDATION',
    "lda_registrant_id" INTEGER,
    "lda_registrant_name" TEXT,
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "billing_status" "billing_status" NOT NULL DEFAULT 'none',
    "client_slots" INTEGER NOT NULL DEFAULT 0,
    "llm_allowance_usd_per_slot" DECIMAL(12,2) NOT NULL DEFAULT 20,
    "llm_hard_cap_usd" DECIMAL(12,2),
    "current_period_end" TIMESTAMPTZ(6),
    "onboarding_flow_version" INTEGER,
    "trial_ends_at" TIMESTAMPTZ(6),
    "price_lock_expires_at" TIMESTAMPTZ(6),
    "import_mode" TEXT,
    "courtesy_swap_used" BOOLEAN NOT NULL DEFAULT false,
    "deletion_hold" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "title" TEXT,
    "email_signature_html" TEXT,
    "email_signature_enabled" BOOLEAN NOT NULL DEFAULT false,
    "tour_completed_at" TIMESTAMPTZ(6),
    "legiwatch_intro_seen_at" TIMESTAMPTZ(6),
    "legiwatch_prefs" JSONB,
    "last_seen_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "tenant_role" NOT NULL,
    "status" "membership_status" NOT NULL DEFAULT 'invited',
    "billing_admin" BOOLEAN NOT NULL DEFAULT false,
    "invited_by" UUID,
    "joined_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "description" TEXT,
    "product_description" TEXT,
    "primary_contact_name" TEXT,
    "primary_contact_email" CITEXT,
    "primary_contact_phone" TEXT,
    "logo_s3_key" TEXT,
    "logo_content_type" TEXT,
    "logo_uploaded_at" TIMESTAMPTZ(6),
    "intake_data_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "sector_tag" TEXT,
    "profile_type" TEXT DEFAULT 'CLIENT',
    "profile_status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "submission_tracks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "issue_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uei" VARCHAR(12),
    "cage_code" VARCHAR(5),
    "naics_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "psc_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tango_entity_last_synced_at" TIMESTAMPTZ(6),
    "tango_entity_last_attempt_at" TIMESTAMPTZ(6),
    "tango_entity_last_error" TEXT,
    "applicant_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "set_aside_certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lda_client_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "memory_wall" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "account_owner_version" INTEGER NOT NULL DEFAULT 0,
    "canonical_entity_id" UUID,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_memory_access" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "granted_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_memory_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "ended_reason" TEXT,

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_conversations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID,
    "workspace_id" UUID,
    "workspace_key" TEXT NOT NULL DEFAULT 'workspace',
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "nanoclaw_platform_id" TEXT,
    "nanoclaw_agent_group_id" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "summary_up_to_message_id" UUID,
    "summary_tokens" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "clio_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "before_jsonb" JSONB,
    "after_jsonb" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_clerk_org_id_key" ON "tenants"("clerk_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_stripe_customer_id_key" ON "tenants"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_stripe_subscription_id_key" ON "tenants"("stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_user_id_key" ON "users"("clerk_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "tenant_memberships_tenant_role_idx" ON "tenant_memberships"("tenant_id", "role");

-- CreateIndex
CREATE INDEX "tenant_memberships_user_idx" ON "tenant_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_tenant_user_unique" ON "tenant_memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "clients_tenant_idx" ON "clients"("tenant_id");

-- CreateIndex
CREATE INDEX "clients_tenant_name_idx" ON "clients"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenant_id_key" ON "clients"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "client_memory_access_user_idx" ON "client_memory_access"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_memory_access_uniq" ON "client_memory_access"("tenant_id", "client_id", "user_id");

-- CreateIndex
CREATE INDEX "impersonation_sessions_actor_active_idx" ON "impersonation_sessions"("actor_user_id", "expires_at");

-- CreateIndex
CREATE INDEX "clio_conversations_tenant_user_updated_idx" ON "clio_conversations"("tenant_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "clio_conversations_tenant_client_updated_idx" ON "clio_conversations"("tenant_id", "client_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "clio_conversations_tenant_user_workspace_updated_idx" ON "clio_conversations"("tenant_id", "user_id", "workspace_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_occurred_idx" ON "audit_logs"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_action_idx" ON "audit_logs"("tenant_id", "action");

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memory_access" ADD CONSTRAINT "client_memory_access_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memory_access" ADD CONSTRAINT "client_memory_access_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memory_access" ADD CONSTRAINT "client_memory_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_conversations" ADD CONSTRAINT "clio_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_conversations" ADD CONSTRAINT "clio_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_conversations" ADD CONSTRAINT "clio_conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Exact existing selected RLS statements; full migrations are not replayed.
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

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;

ALTER TABLE "tenant_memberships" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "tenant_memberships" FORCE ROW LEVEL SECURITY;

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenants_isolation" ON "tenants"
  USING (rls_bypass() OR id = current_tenant_id())
  WITH CHECK (rls_bypass() OR id = current_tenant_id());

CREATE POLICY "tenant_memberships_isolation" ON "tenant_memberships"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

CREATE POLICY "audit_logs_isolation" ON "audit_logs"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;

CREATE POLICY "clients_isolation" ON "clients"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "clio_conversations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "clio_conversations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "clio_conversations_isolation" ON "clio_conversations"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "client_memory_access" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "client_memory_access" FORCE ROW LEVEL SECURITY;

CREATE POLICY "client_memory_access_isolation" ON "client_memory_access"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
