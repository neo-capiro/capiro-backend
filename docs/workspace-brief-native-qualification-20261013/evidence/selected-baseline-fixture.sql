CREATE EXTENSION IF NOT EXISTS "citext";
-- CreateEnum
CREATE TYPE "tenant_role" AS ENUM ('capiro_admin', 'user_admin', 'standard_user', 'client_portal_user');

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('active', 'suspended', 'pending');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('invited', 'active', 'removed');

-- CreateEnum
CREATE TYPE "billing_status" AS ENUM ('none', 'trialing', 'active', 'past_due', 'canceled', 'comped');

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
CREATE TABLE "business_development_prospects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "canonical_entity_id" UUID,
    "display_name" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "description" TEXT,
    "service_hypothesis" TEXT,
    "geography" TEXT,
    "owner_user_id" UUID,
    "stage" VARCHAR(16) NOT NULL DEFAULT 'researching',
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "dismissed_at" TIMESTAMPTZ(6),
    "conflict_excluded" BOOLEAN NOT NULL DEFAULT false,
    "conflict_reason" TEXT,
    "next_action" TEXT,
    "next_action_due_at" TIMESTAMPTZ(6),
    "linked_client_id" UUID,
    "converted_at" TIMESTAMPTZ(6),
    "watch_requested" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_development_prospects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_development_briefs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "current_version_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_development_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_development_brief_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "brief_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "sections" JSONB NOT NULL,
    "sections_hash" VARCHAR(64) NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "snapshot_hash" VARCHAR(64) NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "idempotency_key" VARCHAR(400) NOT NULL,
    "idempotency_op" VARCHAR(16) NOT NULL,
    "idempotency_fingerprint" VARCHAR(64) NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_development_brief_versions_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "business_development_prospects_tenant_status_stage_idx" ON "business_development_prospects"("tenant_id", "status", "stage");

-- CreateIndex
CREATE INDEX "business_development_prospects_tenant_updated_idx" ON "business_development_prospects"("tenant_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "business_development_prospects_tenant_owner_idx" ON "business_development_prospects"("tenant_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "business_development_prospects_tenant_client_idx" ON "business_development_prospects"("tenant_id", "linked_client_id");

-- CreateIndex
CREATE INDEX "business_development_prospects_tenant_name_idx" ON "business_development_prospects"("tenant_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "business_development_prospects_tenant_id_id_key" ON "business_development_prospects"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "business_development_briefs_tenant_updated_idx" ON "business_development_briefs"("tenant_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "business_development_briefs_tenant_prospect_key" ON "business_development_briefs"("tenant_id", "prospect_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_development_briefs_tenant_id_key" ON "business_development_briefs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "business_development_briefs_tenant_current_version_key" ON "business_development_briefs"("tenant_id", "current_version_id", "id");

-- CreateIndex
CREATE INDEX "business_development_brief_versions_brief_created_idx" ON "business_development_brief_versions"("tenant_id", "brief_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "business_development_brief_versions_tenant_id_id_brief_id_key" ON "business_development_brief_versions"("tenant_id", "id", "brief_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_development_brief_versions_brief_number_key" ON "business_development_brief_versions"("brief_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "business_development_brief_versions_tenant_idempotency_key" ON "business_development_brief_versions"("tenant_id", "brief_id", "idempotency_key");

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
ALTER TABLE "business_development_prospects" ADD CONSTRAINT "business_development_prospects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_prospects" ADD CONSTRAINT "business_development_prospects_client_fkey" FOREIGN KEY ("linked_client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_briefs" ADD CONSTRAINT "business_development_briefs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_briefs" ADD CONSTRAINT "business_development_briefs_prospect_fkey" FOREIGN KEY ("tenant_id", "prospect_id") REFERENCES "business_development_prospects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_briefs" ADD CONSTRAINT "business_development_briefs_current_version_fkey" FOREIGN KEY ("tenant_id", "current_version_id", "id") REFERENCES "business_development_brief_versions"("tenant_id", "id", "brief_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_brief_versions" ADD CONSTRAINT "business_development_brief_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_brief_versions" ADD CONSTRAINT "business_development_brief_versions_brief_fkey" FOREIGN KEY ("tenant_id", "brief_id") REFERENCES "business_development_briefs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "ws_doc_status" AS ENUM ('draft', 'complete');

-- CreateEnum
CREATE TYPE "ws_role" AS ENUM ('editor', 'reviewer', 'viewer', 'commenter');

-- CreateEnum
CREATE TYPE "ws_agent_message_role" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "ws_blueprint_scope" AS ENUM ('capiro', 'firm');

-- CreateEnum
CREATE TYPE "ws_blueprint_version_status" AS ENUM ('draft', 'published', 'retired');

-- CreateEnum
CREATE TYPE "ws_agent_proposal_status" AS ENUM ('pending', 'accepted', 'rejected', 'stale');

-- CreateEnum
CREATE TYPE "ws_approval_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "ws_collaborator_status" AS ENUM ('active', 'pending');

-- CreateEnum
CREATE TYPE "ws_notification_kind" AS ENUM ('newsletter_review', 'newsletter_comment', 'collab_invite', 'collab_accepted', 'collab_declined');

-- CreateEnum
CREATE TYPE "ws_author_kind" AS ENUM ('meri', 'person');

-- CreateEnum
CREATE TYPE "ws_theme_version_status" AS ENUM ('draft', 'published', 'retired');

-- CreateEnum
CREATE TYPE "ws_hillday_doc_status" AS ENUM ('draft', 'generating', 'generated', 'partial', 'delivered');

-- CreateTable
CREATE TABLE "ws_draft" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "last_edited_by_id" TEXT,
    "doc_title" TEXT NOT NULL,
    "industry" TEXT,
    "product" TEXT,
    "client" TEXT,
    "prospect_id" UUID,
    "status" "ws_doc_status" NOT NULL DEFAULT 'draft',
    "is_packet" BOOLEAN NOT NULL DEFAULT false,
    "doc_count" INTEGER NOT NULL DEFAULT 1,
    "ask" JSONB,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_agent_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "actor_id" TEXT,
    "role" "ws_agent_message_role" NOT NULL,
    "phase" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_agent_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_blueprint" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "scope" "ws_blueprint_scope" NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "description" TEXT,
    "owner_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_blueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_blueprint_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "blueprint_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ws_blueprint_version_status" NOT NULL DEFAULT 'draft',
    "definition" JSONB NOT NULL,
    "definition_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "ws_blueprint_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_agent_proposal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "ws_agent_proposal_status" NOT NULL DEFAULT 'pending',
    "base_revision" INTEGER NOT NULL,
    "base_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by_id" TEXT,

    CONSTRAINT "ws_agent_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_approval_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "reviewer_id" TEXT,
    "status" "ws_approval_status" NOT NULL DEFAULT 'pending',
    "version_id" UUID,
    "notes" TEXT,
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "ws_approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_share_link" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "version_id" UUID,
    "label" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_share_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_guest_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "share_link_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "guest_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_guest_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_collaborator" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "subject_id" TEXT,
    "email" TEXT,
    "name" TEXT,
    "role" "ws_role" NOT NULL,
    "status" "ws_collaborator_status" NOT NULL DEFAULT 'active',
    "invited_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_collaborator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_notification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "kind" "ws_notification_kind" NOT NULL,
    "draft_id" UUID,
    "collaborator_id" UUID,
    "actor_name" TEXT,
    "draft_title" TEXT,
    "role" "ws_role",
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "actionable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "newsletter_id" UUID,

    CONSTRAINT "ws_notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "body" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "description" TEXT,
    "product" TEXT NOT NULL,
    "style" TEXT,
    "font_family" TEXT,
    "accent_color" TEXT,
    "meri_primary" BOOLEAN NOT NULL DEFAULT false,
    "meri_secondary" BOOLEAN NOT NULL DEFAULT false,
    "elements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "role" "ws_role" NOT NULL DEFAULT 'editor',
    "quote" TEXT,
    "anchor" JSONB,
    "body" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "parent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_doc_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "label" TEXT,
    "author_id" TEXT NOT NULL,
    "author_kind" "ws_author_kind" NOT NULL DEFAULT 'person',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_doc_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_edit_lock" (
    "draft_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "holder_id" TEXT NOT NULL,
    "holder_name" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by_id" TEXT,
    "requested_by_name" TEXT,
    "requested_at" TIMESTAMP(3),

    CONSTRAINT "ws_edit_lock_pkey" PRIMARY KEY ("draft_id")
);

-- CreateTable
CREATE TABLE "ws_context_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_context_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_intake" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "draft_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "blueprint_version_id" UUID NOT NULL,
    "intake_snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_intake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_generation_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT NOT NULL DEFAULT 'queued',
    "agent_revision" INTEGER NOT NULL DEFAULT 0,
    "lease_holder" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "model" TEXT,
    "reasoning_level" TEXT,
    "section_states" JSONB NOT NULL DEFAULT '{}',
    "stages" JSONB NOT NULL DEFAULT '[]',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_generation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_theme" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_theme_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "theme_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ws_theme_version_status" NOT NULL DEFAULT 'draft',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "settings_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "ws_theme_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_brand_asset" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_brand_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_hillday_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "blueprint_slug" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "client_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ws_hillday_doc_status" NOT NULL DEFAULT 'draft',
    "lookback_days" INTEGER NOT NULL DEFAULT 90,
    "time_zone" TEXT NOT NULL DEFAULT 'America/New_York',
    "week_start" DATE,
    "resolution_status" TEXT,
    "provenance" JSONB,
    "first_page" JSONB,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_hillday_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_hillday_meeting" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "event" JSONB NOT NULL DEFAULT '{}',
    "resolution" JSONB,
    "context" JSONB,
    "section" JSONB,
    "source_set" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_hillday_meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_hillday_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "units" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "quality" DOUBLE PRECISION,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_hillday_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_hillday_export" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "page_size" TEXT NOT NULL DEFAULT 'letter',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "filename" TEXT,
    "file" BYTEA,
    "size_bytes" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "ws_hillday_export_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_prospect_draft_receipt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "request_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "draft_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_prospect_draft_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "config" JSONB NOT NULL,
    "design" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_newsletter_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_brand_kit" (
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_newsletter_brand_kit_pkey" PRIMARY KEY ("tenant_id","owner_id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_reviewer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'commenter',
    "notifications" TEXT NOT NULL DEFAULT 'mentions',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_reviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_library_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_newsletter_library_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_invitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "request_key" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "role" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "account_role" TEXT NOT NULL DEFAULT 'member',
    "source_client_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "recipient_id" TEXT,
    "activated_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "block_id" TEXT,
    "parent_id" UUID,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_thread_watcher" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "root_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_thread_watcher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_review_email_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "root_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "source_client_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_review_email_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_asset" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "revision_root_id" UUID,
    "revision_parent_id" UUID,
    "revision_number" INTEGER NOT NULL DEFAULT 1,
    "current_revision" BOOLEAN NOT NULL DEFAULT true,
    "folder_id" UUID,

    CONSTRAINT "ws_newsletter_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_asset_folder" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_asset_folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_stage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "design" JSONB NOT NULL,
    "html" TEXT NOT NULL,
    "plain_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_stage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ws_draft_tenant_id_idx" ON "ws_draft"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_draft_prospect_idx" ON "ws_draft"("tenant_id", "prospect_id", "updated_at");

-- CreateIndex
CREATE INDEX "ws_draft_tenant_id_owner_id_idx" ON "ws_draft"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "ws_draft_tenant_id_updated_at_idx" ON "ws_draft"("tenant_id", "updated_at");

-- CreateIndex
CREATE INDEX "ws_agent_message_tenant_id_draft_id_created_at_idx" ON "ws_agent_message"("tenant_id", "draft_id", "created_at");

-- CreateIndex
CREATE INDEX "ws_blueprint_tenant_id_product_idx" ON "ws_blueprint"("tenant_id", "product");

-- CreateIndex
CREATE UNIQUE INDEX "ws_blueprint_tenant_id_slug_key" ON "ws_blueprint"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "ws_blueprint_version_tenant_id_status_idx" ON "ws_blueprint_version"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ws_blueprint_version_blueprint_id_version_key" ON "ws_blueprint_version"("blueprint_id", "version");

-- CreateIndex
CREATE INDEX "ws_agent_proposal_tenant_id_draft_id_created_at_idx" ON "ws_agent_proposal"("tenant_id", "draft_id", "created_at");

-- CreateIndex
CREATE INDEX "ws_approval_request_tenant_id_draft_id_created_at_idx" ON "ws_approval_request"("tenant_id", "draft_id", "created_at");

-- CreateIndex
CREATE INDEX "ws_share_link_tenant_id_draft_id_idx" ON "ws_share_link"("tenant_id", "draft_id");

-- CreateIndex
CREATE INDEX "ws_share_link_token_hash_idx" ON "ws_share_link"("token_hash");

-- CreateIndex
CREATE INDEX "ws_guest_comment_tenant_id_draft_id_idx" ON "ws_guest_comment"("tenant_id", "draft_id");

-- CreateIndex
CREATE INDEX "ws_guest_comment_share_link_id_idx" ON "ws_guest_comment"("share_link_id");

-- CreateIndex
CREATE INDEX "ws_collaborator_draft_id_idx" ON "ws_collaborator"("draft_id");

-- CreateIndex
CREATE INDEX "ws_collaborator_tenant_id_idx" ON "ws_collaborator"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_collaborator_draft_id_subject_id_key" ON "ws_collaborator"("draft_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_collaborator_draft_id_email_key" ON "ws_collaborator"("draft_id", "email");

-- CreateIndex
CREATE INDEX "ws_notification_tenant_id_recipient_id_idx" ON "ws_notification"("tenant_id", "recipient_id");

-- CreateIndex
CREATE INDEX "ws_notification_recipient_id_read_idx" ON "ws_notification"("recipient_id", "read");

-- CreateIndex
CREATE INDEX "ws_document_tenant_id_idx" ON "ws_document"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_document_draft_id_idx" ON "ws_document"("draft_id");

-- CreateIndex
CREATE INDEX "ws_template_product_idx" ON "ws_template"("product");

-- CreateIndex
CREATE INDEX "ws_template_tenant_id_idx" ON "ws_template"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_comment_tenant_id_idx" ON "ws_comment"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_comment_document_id_idx" ON "ws_comment"("document_id");

-- CreateIndex
CREATE INDEX "ws_comment_parent_id_idx" ON "ws_comment"("parent_id");

-- CreateIndex
CREATE INDEX "ws_doc_version_tenant_id_idx" ON "ws_doc_version"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_doc_version_draft_id_idx" ON "ws_doc_version"("draft_id");

-- CreateIndex
CREATE INDEX "ws_doc_version_draft_id_created_at_idx" ON "ws_doc_version"("draft_id", "created_at");

-- CreateIndex
CREATE INDEX "ws_edit_lock_tenant_id_idx" ON "ws_edit_lock"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_context_item_tenant_id_idx" ON "ws_context_item"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_context_item_draft_id_idx" ON "ws_context_item"("draft_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_intake_run_id_key" ON "ws_intake"("run_id");

-- CreateIndex
CREATE INDEX "ws_intake_draft_id_idx" ON "ws_intake"("draft_id");

-- CreateIndex
CREATE INDEX "ws_intake_run_id_idx" ON "ws_intake"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_intake_tenant_id_actor_id_idempotency_key_key" ON "ws_intake"("tenant_id", "actor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ws_generation_run_tenant_id_status_idx" ON "ws_generation_run"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ws_generation_run_draft_id_idx" ON "ws_generation_run"("draft_id");

-- CreateIndex
CREATE INDEX "ws_generation_run_status_lease_expires_at_idx" ON "ws_generation_run"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "ws_theme_tenant_id_idx" ON "ws_theme"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_theme_tenant_id_slug_key" ON "ws_theme"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "ws_theme_version_tenant_id_status_idx" ON "ws_theme_version"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ws_theme_version_theme_id_version_key" ON "ws_theme_version"("theme_id", "version");

-- CreateIndex
CREATE INDEX "ws_brand_asset_tenant_id_idx" ON "ws_brand_asset"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_hillday_document_tenant_id_updated_at_idx" ON "ws_hillday_document"("tenant_id", "updated_at");

-- CreateIndex
CREATE INDEX "ws_hillday_document_tenant_id_client_id_idx" ON "ws_hillday_document"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "ws_hillday_meeting_tenant_id_document_id_idx" ON "ws_hillday_meeting"("tenant_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_hillday_meeting_document_id_event_id_key" ON "ws_hillday_meeting"("document_id", "event_id");

-- CreateIndex
CREATE INDEX "ws_hillday_job_tenant_id_document_id_created_at_idx" ON "ws_hillday_job"("tenant_id", "document_id", "created_at");

-- CreateIndex
CREATE INDEX "ws_hillday_export_tenant_id_document_id_idx" ON "ws_hillday_export"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "ws_prospect_draft_receipt_prospect_idx" ON "ws_prospect_draft_receipt"("tenant_id", "prospect_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_prospect_draft_receipt_request_key" ON "ws_prospect_draft_receipt"("tenant_id", "owner_id", "request_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_document_tenant_id_owner_id_updated_at_idx" ON "ws_newsletter_document"("tenant_id", "owner_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_document_tenant_key" ON "ws_newsletter_document"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_reviewer_tenant_id_user_id_idx" ON "ws_newsletter_reviewer"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_reviewer_document_id_user_id_key" ON "ws_newsletter_reviewer"("document_id", "user_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_library_item_tenant_id_owner_id_kind_idx" ON "ws_newsletter_library_item"("tenant_id", "owner_id", "kind");

-- CreateIndex
CREATE INDEX "ws_newsletter_invitation_tenant_id_document_id_email_idx" ON "ws_newsletter_invitation"("tenant_id", "document_id", "email");

-- CreateIndex
CREATE INDEX "ws_newsletter_invitation_activated_at_created_at_idx" ON "ws_newsletter_invitation"("activated_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_invitation_request_key" ON "ws_newsletter_invitation"("tenant_id", "author_id", "request_key");

-- CreateIndex
CREATE INDEX "ws_newsletter_comment_tenant_id_document_id_created_at_idx" ON "ws_newsletter_comment"("tenant_id", "document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_comment_scope_key" ON "ws_newsletter_comment"("id", "tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_thread_watcher_tenant_id_document_id_idx" ON "ws_newsletter_thread_watcher"("tenant_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_thread_watcher_root_id_user_id_key" ON "ws_newsletter_thread_watcher"("root_id", "user_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_review_email_request_created_at_idx" ON "ws_newsletter_review_email_request"("created_at");

-- CreateIndex
CREATE INDEX "ws_newsletter_review_email_request_tenant_id_document_id_idx" ON "ws_newsletter_review_email_request"("tenant_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_review_email_request_comment_id_recipient_id_key" ON "ws_newsletter_review_email_request"("comment_id", "recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_asset_token_key" ON "ws_newsletter_asset"("token");

-- CreateIndex
CREATE INDEX "ws_newsletter_asset_tenant_id_owner_id_idx" ON "ws_newsletter_asset"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_asset_tenant_id_owner_id_folder_id_idx" ON "ws_newsletter_asset"("tenant_id", "owner_id", "folder_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_asset_tenant_id_owner_id_current_revision_del_idx" ON "ws_newsletter_asset"("tenant_id", "owner_id", "current_revision", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_asset_scope_key" ON "ws_newsletter_asset"("id", "tenant_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_asset_revision_number_key" ON "ws_newsletter_asset"("revision_root_id", "revision_number");

-- CreateIndex
CREATE INDEX "ws_newsletter_asset_folder_tenant_id_owner_id_idx" ON "ws_newsletter_asset_folder"("tenant_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_asset_folder_scope_key" ON "ws_newsletter_asset_folder"("id", "tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_stage_tenant_id_owner_id_created_at_idx" ON "ws_newsletter_stage"("tenant_id", "owner_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_stage_document_id_revision_owner_id_key" ON "ws_newsletter_stage"("document_id", "revision", "owner_id");

-- AddForeignKey
ALTER TABLE "ws_agent_message" ADD CONSTRAINT "ws_agent_message_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_blueprint_version" ADD CONSTRAINT "ws_blueprint_version_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "ws_blueprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_agent_proposal" ADD CONSTRAINT "ws_agent_proposal_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_approval_request" ADD CONSTRAINT "ws_approval_request_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_share_link" ADD CONSTRAINT "ws_share_link_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_guest_comment" ADD CONSTRAINT "ws_guest_comment_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_guest_comment" ADD CONSTRAINT "ws_guest_comment_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "ws_share_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_collaborator" ADD CONSTRAINT "ws_collaborator_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_document" ADD CONSTRAINT "ws_document_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_comment" ADD CONSTRAINT "ws_comment_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_comment" ADD CONSTRAINT "ws_comment_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ws_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_doc_version" ADD CONSTRAINT "ws_doc_version_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_edit_lock" ADD CONSTRAINT "ws_edit_lock_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_context_item" ADD CONSTRAINT "ws_context_item_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_intake" ADD CONSTRAINT "ws_intake_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_intake" ADD CONSTRAINT "ws_intake_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ws_generation_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_generation_run" ADD CONSTRAINT "ws_generation_run_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_theme_version" ADD CONSTRAINT "ws_theme_version_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "ws_theme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_hillday_meeting" ADD CONSTRAINT "ws_hillday_meeting_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_hillday_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_hillday_job" ADD CONSTRAINT "ws_hillday_job_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_hillday_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_hillday_export" ADD CONSTRAINT "ws_hillday_export_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_hillday_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_reviewer" ADD CONSTRAINT "ws_newsletter_reviewer_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_newsletter_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_invitation" ADD CONSTRAINT "ws_newsletter_invitation_document_scope_fkey" FOREIGN KEY ("document_id", "tenant_id") REFERENCES "ws_newsletter_document"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_comment" ADD CONSTRAINT "ws_newsletter_comment_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_newsletter_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_thread_watcher" ADD CONSTRAINT "ws_newsletter_thread_watcher_root_scope_fkey" FOREIGN KEY ("root_id", "tenant_id", "document_id") REFERENCES "ws_newsletter_comment"("id", "tenant_id", "document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_review_email_request" ADD CONSTRAINT "ws_newsletter_review_email_request_comment_scope_fkey" FOREIGN KEY ("comment_id", "tenant_id", "document_id") REFERENCES "ws_newsletter_comment"("id", "tenant_id", "document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_review_email_request" ADD CONSTRAINT "ws_newsletter_review_email_request_root_scope_fkey" FOREIGN KEY ("root_id", "tenant_id", "document_id") REFERENCES "ws_newsletter_comment"("id", "tenant_id", "document_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_asset" ADD CONSTRAINT "ws_newsletter_asset_revision_root_scope_fkey" FOREIGN KEY ("revision_root_id", "tenant_id", "owner_id") REFERENCES "ws_newsletter_asset"("id", "tenant_id", "owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ws_newsletter_asset" ADD CONSTRAINT "ws_newsletter_asset_revision_parent_scope_fkey" FOREIGN KEY ("revision_parent_id", "tenant_id", "owner_id") REFERENCES "ws_newsletter_asset"("id", "tenant_id", "owner_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ws_newsletter_asset" ADD CONSTRAINT "ws_newsletter_asset_folder_scope_fkey" FOREIGN KEY ("folder_id", "tenant_id", "owner_id") REFERENCES "ws_newsletter_asset_folder"("id", "tenant_id", "owner_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_stage" ADD CONSTRAINT "ws_newsletter_stage_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_newsletter_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE FUNCTION ws_preserve_prospect_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.prospect_id IS DISTINCT FROM OLD.prospect_id OR
   (OLD.prospect_id IS NOT NULL AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id)) THEN
   RAISE EXCEPTION 'workspace prospect origin is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ws_draft_preserve_prospect_origin BEFORE UPDATE ON ws_draft
 FOR EACH ROW EXECUTE FUNCTION ws_preserve_prospect_origin();
CREATE FUNCTION ws_preserve_prospect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'workspace prospect receipt is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER ws_prospect_draft_receipt_immutable BEFORE UPDATE ON ws_prospect_draft_receipt
 FOR EACH ROW EXECUTE FUNCTION ws_preserve_prospect_receipt();
-- No data copy/backfill, free-text matching, public token grant or new Core FK.

-- SOURCE ONLY. Not executed. Saved revision identity/content must not be rewritten.
CREATE FUNCTION ws_preserve_saved_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'workspace saved version is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ws_doc_version_immutable BEFORE UPDATE ON ws_doc_version
 FOR EACH ROW EXECUTE FUNCTION ws_preserve_saved_version();
-- Existing delete/cascade semantics remain. A deleted source cannot be restaged.
