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
CREATE TABLE "canonical_entities" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID,
    "identity_scope" VARCHAR(24) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'active',
    "resolution_confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0,
    "resolution_method" VARCHAR(64) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "merged_into_entity_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_aliases" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "entity_id" UUID NOT NULL,
    "tenant_id" UUID,
    "identity_scope" VARCHAR(24) NOT NULL,
    "alias" TEXT NOT NULL,
    "normalized_alias" TEXT NOT NULL,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" VARCHAR(512),
    "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0,
    "verified_at" TIMESTAMPTZ(6),
    "status" VARCHAR(24) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_identifiers" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "entity_id" UUID NOT NULL,
    "tenant_id" UUID,
    "identity_scope" VARCHAR(24) NOT NULL,
    "identifier_type" VARCHAR(64) NOT NULL,
    "identifier_value" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "source_type" VARCHAR(64) NOT NULL,
    "source_id" VARCHAR(512),
    "confidence" DECIMAL(5,4) NOT NULL DEFAULT 1.0,
    "verified_at" TIMESTAMPTZ(6),
    "status" VARCHAR(24) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_resolutions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "actor_user_id" UUID,
    "raw_input" TEXT NOT NULL,
    "normalized_input" TEXT NOT NULL,
    "entity_type_hint" VARCHAR(64),
    "candidate_entity_ids" JSONB NOT NULL DEFAULT '[]',
    "selected_entity_id" UUID,
    "status" VARCHAR(24) NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "resolution_method" VARCHAR(64) NOT NULL,
    "provenance" JSONB NOT NULL DEFAULT '[]',
    "correction_of_resolution_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_entity_merges" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "source_entity_id" UUID NOT NULL,
    "target_entity_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "reason_code" VARCHAR(64) NOT NULL,
    "reason" TEXT,
    "provenance" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canonical_entity_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_identity_governance_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "action_type" VARCHAR(40) NOT NULL,
    "subject_type" VARCHAR(24) NOT NULL,
    "subject_id" UUID NOT NULL,
    "entity_id" UUID,
    "actor_user_id" UUID NOT NULL,
    "reason_code" VARCHAR(64) NOT NULL,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_identity_governance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_entity_backfill_checkpoints" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID,
    "source" VARCHAR(64) NOT NULL,
    "source_cursor" TEXT,
    "status" VARCHAR(24) NOT NULL DEFAULT 'running',
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "linked" INTEGER NOT NULL DEFAULT 0,
    "ambiguous" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "canonical_entity_backfill_checkpoints_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "admin_broadcasts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "admin_broadcast_audience" NOT NULL,
    "created_by_user_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_broadcast_recipients" (
    "id" UUID NOT NULL,
    "broadcast_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identity_conflict" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "incoming_clerk_user_id" TEXT NOT NULL,
    "existing_user_id" UUID NOT NULL,
    "previous_clerk_user_id" TEXT,
    "membership_count" INTEGER NOT NULL DEFAULT 0,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(6),
    "resolution" TEXT,

    CONSTRAINT "user_identity_conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "identity_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clerk_events" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_jsonb" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,

    CONSTRAINT "clerk_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_jsonb" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_usage_meters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "reported_overage_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_usage_meters_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "client_objectives" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "client_request_id" UUID NOT NULL,
    "create_request_hash" CHAR(64) NOT NULL,
    "outcome" VARCHAR(2000) NOT NULL DEFAULT '',
    "government_problem" VARCHAR(4000) NOT NULL DEFAULT '',
    "ask_type" VARCHAR(32),
    "minimum_win" VARCHAR(2000) NOT NULL DEFAULT '',
    "limits" VARCHAR(4000) NOT NULL DEFAULT '',
    "owner_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "ready_at" TIMESTAMPTZ(6),
    "review_requested_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_objective_revisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "objective_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "operation" VARCHAR(32) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_objective_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_ordered_owners" (
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "client_ordered_owners_pkey" PRIMARY KEY ("tenant_id","client_id","rank")
);

-- CreateTable
CREATE TABLE "client_team_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT,
    "added_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_opportunity_searches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "is_tenant_wide" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "opportunity_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "query" TEXT NOT NULL,
    "criteria_json" JSONB NOT NULL,
    "sort" TEXT NOT NULL,
    "page_size" INTEGER NOT NULL,
    "match_mode" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "visibility" TEXT NOT NULL,
    "alerts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "alert_cadence" TEXT,
    "alert_channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alert_deadline_threshold" INTEGER,
    "alert_new_vs_changed" BOOLEAN NOT NULL DEFAULT false,
    "last_evaluated_at" TIMESTAMPTZ(6),
    "last_notified_at" TIMESTAMPTZ(6),
    "last_applied_at" TIMESTAMPTZ(6),
    "last_run_result_count" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 2,
    "archived_at" TIMESTAMPTZ(6),
    "original_criteria_json" JSONB,
    "migration_warnings" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "saved_opportunity_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_contact_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "directory_contact_id" TEXT NOT NULL,
    "directory_contact_name" TEXT,
    "body" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "directory_contact_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_contact_favorites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "directory_contact_id" TEXT NOT NULL,
    "directory_contact_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "directory_contact_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "engagement_provider" NOT NULL,
    "account_email" CITEXT,
    "display_name" TEXT,
    "status" "engagement_connection_status" NOT NULL DEFAULT 'needs_configuration',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sync_state_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_sync_at" TIMESTAMPTZ(6),
    "next_sync_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "engagement_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_connection_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "access_token_ciphertext" TEXT NOT NULL,
    "access_token_iv" TEXT NOT NULL,
    "access_token_auth_tag" TEXT NOT NULL,
    "refresh_token_ciphertext" TEXT,
    "refresh_token_iv" TEXT,
    "refresh_token_auth_tag" TEXT,
    "key_version" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "home_account_id" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "engagement_connection_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "directory_entry_id" TEXT,
    "acquisition_personnel_id" UUID,
    "full_name" TEXT,
    "email" CITEXT,
    "phone" TEXT,
    "organization" TEXT,
    "title" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "engagement_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "connection_id" UUID,
    "source" "engagement_source" NOT NULL DEFAULT 'manual',
    "external_id" TEXT,
    "ical_uid" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "organizer_email" CITEXT,
    "organizer_name" TEXT,
    "time_zone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "is_virtual" BOOLEAN NOT NULL DEFAULT false,
    "join_link" TEXT,
    "provider" TEXT,
    "visibility" "meeting_visibility" NOT NULL DEFAULT 'private',
    "shared_at" TIMESTAMPTZ(6),
    "shared_by_user_id" UUID,
    "transcript_s3_key" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "raw_jsonb" JSONB,
    "association_score" DOUBLE PRECISION,
    "association_reason" TEXT,
    "association_signals_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_attendees" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "contact_id" UUID,
    "email" CITEXT,
    "name" TEXT,
    "role" TEXT,
    "response_status" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_threads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "connection_id" UUID,
    "source" "engagement_source" NOT NULL DEFAULT 'manual',
    "external_id" TEXT,
    "subject" TEXT NOT NULL,
    "snippet" TEXT,
    "participants_jsonb" JSONB NOT NULL DEFAULT '[]',
    "last_message_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'open',
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "raw_jsonb" JSONB,
    "association_score" DOUBLE PRECISION,
    "association_reason" TEXT,
    "association_signals_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mail_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "connection_id" UUID,
    "source" "engagement_source" NOT NULL DEFAULT 'manual',
    "external_id" TEXT,
    "subject" TEXT,
    "from_email" CITEXT,
    "from_name" TEXT,
    "to_recipients_jsonb" JSONB NOT NULL DEFAULT '[]',
    "cc_recipients_jsonb" JSONB NOT NULL DEFAULT '[]',
    "bcc_recipients_jsonb" JSONB NOT NULL DEFAULT '[]',
    "sent_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "body_text" TEXT,
    "body_html_s3_key" TEXT,
    "has_attachments" BOOLEAN NOT NULL DEFAULT false,
    "removed_at" TIMESTAMPTZ(6),
    "removed_reason" VARCHAR(32),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "raw_jsonb" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mail_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_device_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" VARCHAR(128) NOT NULL,
    "environment" VARCHAR(16) NOT NULL,
    "token" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "app_version" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "mobile_device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "prospect_id" UUID,
    "client_id" UUID,
    "meeting_id" UUID,
    "mail_message_id" UUID,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER,
    "bucket" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "checksum_sha256" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "folder" VARCHAR(120),
    "viewer_mode" VARCHAR(16) NOT NULL DEFAULT 'all',
    "viewer_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_entity_type" VARCHAR(64),
    "source_entity_id" VARCHAR(128),
    "source_version" INTEGER,
    "source_content_hash" VARCHAR(64),
    "uploaded_by_user_id" UUID,
    "indexed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifecycle_status" VARCHAR(32) NOT NULL DEFAULT 'legacy_ready',
    "verified_content_type" VARCHAR(255),
    "calculated_sha256" VARCHAR(128),
    "scan_provider" VARCHAR(64),
    "scan_status" VARCHAR(32),
    "scan_result_at" TIMESTAMPTZ(6),
    "extraction_status" VARCHAR(32),
    "extraction_metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "shared_at" TIMESTAMPTZ(6),
    "shared_by_user_id" UUID,
    "superseded_by_attachment_id" UUID,

    CONSTRAINT "engagement_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "client_id" UUID,
    "author_user_id" UUID,
    "body_ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "key_version" TEXT,
    "confidential" BOOLEAN NOT NULL DEFAULT true,
    "access_level" TEXT NOT NULL DEFAULT 'tenant_admins_and_author',
    "status" VARCHAR(24) NOT NULL DEFAULT 'draft',
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "shared_at" TIMESTAMPTZ(6),
    "shared_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meeting_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_prep_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "request_key" VARCHAR(128) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "stage" VARCHAR(48) NOT NULL DEFAULT 'queued',
    "depth" VARCHAR(16) NOT NULL DEFAULT 'standard',
    "input" JSONB NOT NULL,
    "checkpoints" JSONB NOT NULL DEFAULT '{}',
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "prep_id" UUID,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_prep_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_prep_monday_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "board_ids" TEXT[],
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_prep_monday_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_preps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "client_id" UUID,
    "status" "meeting_prep_status" NOT NULL DEFAULT 'generated',
    "agenda_jsonb" JSONB NOT NULL DEFAULT '[]',
    "talking_points_jsonb" JSONB NOT NULL DEFAULT '[]',
    "risks_jsonb" JSONB NOT NULL DEFAULT '[]',
    "follow_ups_jsonb" JSONB NOT NULL DEFAULT '[]',
    "email_evidence_jsonb" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "prompt_hash" TEXT,
    "generated_from_jsonb" JSONB NOT NULL DEFAULT '{}',
    "edited_by_user_id" UUID,
    "shared_at" TIMESTAMPTZ(6),
    "shared_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meeting_preps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_debriefs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "client_id" UUID,
    "author_user_id" UUID,
    "body_ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "key_version" TEXT,
    "confidential" BOOLEAN NOT NULL DEFAULT true,
    "access_level" TEXT NOT NULL DEFAULT 'tenant_members',
    "status" "meeting_debrief_status" NOT NULL DEFAULT 'generated',
    "shared_at" TIMESTAMPTZ(6),
    "shared_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meeting_debriefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_notetaker_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "consent_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_notetaker_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_bot_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meeting_id" UUID NOT NULL,
    "client_id" UUID,
    "requested_by_user_id" UUID,
    "provider" TEXT NOT NULL DEFAULT 'recall',
    "region" TEXT,
    "external_bot_id" TEXT,
    "recording_id" TEXT,
    "transcript_id" TEXT,
    "platform" TEXT,
    "join_url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "recording_policy" TEXT NOT NULL DEFAULT 'transcript_only',
    "consent_jsonb" JSONB NOT NULL DEFAULT '{}',
    "transcript_s3_key" TEXT,
    "debrief_id" UUID,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "raw_jsonb" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meeting_bot_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "meeting_id" UUID,
    "contact_id" UUID,
    "mail_thread_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "owner_user_id" UUID,
    "due_date" DATE,
    "status" "engagement_task_status" NOT NULL DEFAULT 'todo',
    "source_type" TEXT,
    "source_id" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "engagement_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_report_target_offices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "scope_key" TEXT NOT NULL,
    "office_key" TEXT NOT NULL,
    "member_principal" TEXT NOT NULL,
    "committee" TEXT,
    "staffer" TEXT,
    "building" TEXT,
    "lead_owner" TEXT,
    "prep_status" TEXT NOT NULL DEFAULT 'auto',
    "outreach_status" TEXT NOT NULL DEFAULT 'auto',
    "submission_status" TEXT NOT NULL DEFAULT 'auto',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "first_report_year" INTEGER NOT NULL DEFAULT EXTRACT(year FROM CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::integer,
    "display_overrides" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archived_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "engagement_report_target_offices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_report_target_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "report_year" INTEGER NOT NULL,
    "prep_status" TEXT NOT NULL DEFAULT 'auto',
    "outreach_status" TEXT NOT NULL DEFAULT 'auto',
    "submission_status" TEXT NOT NULL DEFAULT 'auto',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "engagement_report_target_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "meeting_id" UUID,
    "created_by_user_id" UUID,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "recipients_jsonb" JSONB NOT NULL DEFAULT '[]',
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "stats_jsonb" JSONB NOT NULL DEFAULT '{}',
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_step" INTEGER NOT NULL DEFAULT 1,
    "sent_at" TIMESTAMPTZ(6),
    "opened_in_email_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "type" TEXT NOT NULL DEFAULT 'outbound_campaign',
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_audiences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_audience_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "audience_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_ref_id" TEXT,
    "name" TEXT,
    "email" CITEXT NOT NULL,
    "title" TEXT,
    "office" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_audience_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_ai_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "prompt" TEXT NOT NULL,
    "description" TEXT,
    "sample_preview" TEXT,
    "tone" TEXT NOT NULL DEFAULT 'professional',
    "metadata_jsonb" JSONB,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_ai_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_association_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" "association_entity_type" NOT NULL,
    "entity_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "previous_client_id" UUID,
    "confidence_before" DOUBLE PRECISION,
    "reason" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_association_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_embeddings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "client_id" UUID,
    "owner_user_id" UUID,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "content_text" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_embeddings_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "demo_requests" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT,
    "message" TEXT,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "meri_saved_prompts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meri_saved_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meri_workspaces" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meri_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meri_vnext_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "window_chrome" VARCHAR(16) NOT NULL DEFAULT 'undocked',
    "rail_collapsed" BOOLEAN NOT NULL DEFAULT false,
    "open_section" VARCHAR(16),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meri_vnext_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "nanoclaw_id" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clio_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_artifacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID,
    "parent_artifact_id" UUID,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content_type" TEXT,
    "body_text" TEXT,
    "s3_key" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "message_id" UUID,
    "filename" VARCHAR(300) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "media_type" VARCHAR(100),
    "byte_size" INTEGER NOT NULL,
    "pages" INTEGER,
    "text_content" TEXT,
    "reason" VARCHAR(300),
    "data" BYTEA,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clio_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_research_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID,
    "title" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'plan',
    "kind" TEXT NOT NULL DEFAULT 'research',
    "goal_revision" INTEGER NOT NULL DEFAULT 0,
    "deliverables_jsonb" JSONB NOT NULL DEFAULT '[]',
    "clarifying_questions_jsonb" JSONB NOT NULL DEFAULT '[]',
    "clarifying_answers_jsonb" JSONB NOT NULL DEFAULT '{}',
    "plan" JSONB NOT NULL DEFAULT '[]',
    "sources" JSONB NOT NULL DEFAULT '[]',
    "report_artifact_id" UUID,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_research_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID,
    "conversation_id" UUID,
    "meeting_id" UUID,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'clio',
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_memory" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'firm',
    "owner_user_id" UUID,
    "client_id" UUID,
    "key" VARCHAR(200) NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'conversation',
    "expires_at" TIMESTAMPTZ(6),
    "embedding" vector,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meri_action_approval" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "tool" VARCHAR(120) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "approved_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meri_action_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meri_pending_action" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "tool" VARCHAR(120) NOT NULL,
    "input_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "meri_pending_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meri_action_proposals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "impersonation_session_id" VARCHAR(160),
    "conversation_id" UUID,
    "surface" VARCHAR(40) NOT NULL,
    "tool" VARCHAR(120) NOT NULL,
    "input_jsonb" JSONB NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "policy_version" VARCHAR(80) NOT NULL,
    "policy_pack_id" UUID,
    "policy_pack_key" VARCHAR(120) NOT NULL,
    "policy_pack_version" VARCHAR(80) NOT NULL,
    "policy_binding" VARCHAR(280) NOT NULL,
    "policy_decision_hash" VARCHAR(64) NOT NULL,
    "policy_context_hash" VARCHAR(64) NOT NULL,
    "policy_source" VARCHAR(24) NOT NULL,
    "policy_mode" VARCHAR(16) NOT NULL,
    "policy_jurisdiction" VARCHAR(32) NOT NULL,
    "policy_channel" VARCHAR(24) NOT NULL,
    "policy_recipient_type" VARCHAR(24),
    "policy_client_id" UUID,
    "policy_effective_user_id" UUID NOT NULL,
    "policy_effective_at" TIMESTAMPTZ(6) NOT NULL,
    "policy_rule_id" VARCHAR(160),
    "policy_decision" VARCHAR(20) NOT NULL,
    "policy_code" VARCHAR(120),
    "risk_tier" VARCHAR(40),
    "preview_jsonb" JSONB NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by" UUID,
    "execution_started_at" TIMESTAMPTZ(6),
    "executed_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(120),
    "last_error_message" VARCHAR(1000),
    "result_summary_jsonb" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "meri_action_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_scheduled_task" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'user_private',
    "name" VARCHAR(200) NOT NULL,
    "prompt" TEXT NOT NULL,
    "interval_minutes" INTEGER NOT NULL,
    "tool_allow_list" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMPTZ(6),
    "next_run_at" TIMESTAMPTZ(6) NOT NULL,
    "last_status" VARCHAR(20),
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" VARCHAR(40) NOT NULL DEFAULT 'clio',
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_scheduled_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_mcp_servers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "transport" VARCHAR(10) NOT NULL,
    "endpoint" VARCHAR(500),
    "command" VARCHAR(500),
    "args" JSONB NOT NULL DEFAULT '[]',
    "env_jsonb" JSONB NOT NULL DEFAULT '{}',
    "scope" VARCHAR(10) NOT NULL DEFAULT 'tenant',
    "owner_user_id" UUID,
    "catalog_id" VARCHAR(64),
    "auth_type" VARCHAR(10) NOT NULL DEFAULT 'token',
    "connection_status" VARCHAR(16) NOT NULL DEFAULT 'connected',
    "auth_token_ciphertext" TEXT,
    "auth_token_iv" TEXT,
    "auth_token_auth_tag" TEXT,
    "auth_key_version" TEXT,
    "tool_allowlist" JSONB NOT NULL DEFAULT '[]',
    "read_only_tools" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_sync_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_mcp_oauth_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "client_id" TEXT,
    "client_secret_ciphertext" TEXT,
    "client_secret_iv" TEXT,
    "client_secret_auth_tag" TEXT,
    "registration_jsonb" JSONB,
    "access_token_ciphertext" TEXT,
    "access_token_iv" TEXT,
    "access_token_auth_tag" TEXT,
    "refresh_token_ciphertext" TEXT,
    "refresh_token_iv" TEXT,
    "refresh_token_auth_tag" TEXT,
    "token_type" TEXT,
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "token_expires_at" TIMESTAMPTZ(6),
    "code_verifier_ciphertext" TEXT,
    "code_verifier_iv" TEXT,
    "code_verifier_auth_tag" TEXT,
    "state_nonce" TEXT,
    "key_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_mcp_oauth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_firm_skills" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "skill_id" VARCHAR(48) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "skill_jsonb" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "versions_jsonb" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_firm_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID,
    "workflow" VARCHAR(48) NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_creation_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL,
    "used_tenant_key" BOOLEAN NOT NULL DEFAULT false,
    "prompt_spec_version" VARCHAR(8),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_run" (
    "id" UUID NOT NULL,
    "workflow" VARCHAR(48) NOT NULL,
    "rail" VARCHAR(16) NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_key" TEXT NOT NULL,
    "tenant_id" UUID,
    "client_id" UUID,
    "prompt_version" VARCHAR(32) NOT NULL,
    "model" VARCHAR(80) NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "used_tenant_key" BOOLEAN NOT NULL DEFAULT false,
    "input_refs" JSONB NOT NULL DEFAULT '[]',
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "output" JSONB,
    "confidence" DOUBLE PRECISION,
    "dropped_by_grounding" INTEGER NOT NULL DEFAULT 0,
    "dropped_by_validator" INTEGER NOT NULL DEFAULT 0,
    "dropped_off_roster" INTEGER NOT NULL DEFAULT 0,
    "validation_status" VARCHAR(16) NOT NULL,
    "qa_status" VARCHAR(16) NOT NULL DEFAULT 'none',
    "human_reviewed_by" UUID,
    "human_reviewed_at" TIMESTAMPTZ(6),
    "status" VARCHAR(16) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meri_audit_ledger" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "surface" VARCHAR(16) NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "conversation_id" UUID,
    "subject_type" VARCHAR(32),
    "subject_id" TEXT,
    "client_id" UUID,
    "alert_id" VARCHAR(128),
    "model" VARCHAR(80),
    "decision" VARCHAR(24) NOT NULL,
    "top_severity" VARCHAR(12),
    "finding_count" INTEGER NOT NULL DEFAULT 0,
    "findings_jsonb" JSONB NOT NULL DEFAULT '[]',
    "output_chars" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meri_audit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "risk_tier" VARCHAR(16) NOT NULL,
    "surface" VARCHAR(24) NOT NULL,
    "subject_type" VARCHAR(32) NOT NULL,
    "subject_id" TEXT,
    "client_id" UUID,
    "title" VARCHAR(300) NOT NULL,
    "reason" TEXT NOT NULL,
    "payload_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "requested_by" UUID,
    "assigned_to" UUID,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_generation_record" (
    "id" UUID NOT NULL,
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
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_generation_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcome_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "kind" VARCHAR(32) NOT NULL,
    "source_type" VARCHAR(24) NOT NULL,
    "source_id" TEXT,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "recorded_by" UUID,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outcome_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "packet_version" INTEGER NOT NULL DEFAULT 2,
    "directives_jsonb" JSONB NOT NULL DEFAULT '[]',
    "evidence_jsonb" JSONB NOT NULL DEFAULT '[]',
    "source_failures_jsonb" JSONB NOT NULL DEFAULT '[]',
    "policy_jsonb" JSONB NOT NULL DEFAULT '{}',
    "model_policy_jsonb" JSONB NOT NULL DEFAULT '{}',
    "packet_hash" VARCHAR(80),
    "critical_failure_count" INTEGER NOT NULL DEFAULT 0,
    "freshest_source_at" TIMESTAMPTZ(6),
    "stalest_source_at" TIMESTAMPTZ(6),
    "effective_tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "trace_id" VARCHAR(160),
    "prompt_version" VARCHAR(80),
    "policy_version" VARCHAR(80),
    "compiler_version" VARCHAR(80),
    "required_layers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "health_jsonb" JSONB NOT NULL DEFAULT '{}',
    "total_token_budget" INTEGER,
    "used_tokens" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "incomplete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "context_packet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "kind" VARCHAR(16) NOT NULL,
    "outreach_record_id" UUID,
    "params_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "totals_jsonb" JSONB NOT NULL DEFAULT '{}',
    "request_key" VARCHAR(128) NOT NULL,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_job_items" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_key" VARCHAR(256) NOT NULL,
    "payload_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "result_jsonb" JSONB,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "claimed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_job_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_draft_artifacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "outreach_record_id" UUID NOT NULL,
    "generation_key" VARCHAR(512) NOT NULL,
    "recipient_key" VARCHAR(256) NOT NULL,
    "audience_kind" VARCHAR(16) NOT NULL,
    "recipient_snapshot_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID NOT NULL,
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_draft_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_draft_versions" (
    "content_format" VARCHAR(32) NOT NULL DEFAULT 'outreach',
    "newsletter_stage_id" UUID,
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source_version_id" UUID,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "content_hash" VARCHAR(80) NOT NULL,
    "generation_status" VARCHAR(32) NOT NULL,
    "audit_status" VARCHAR(32) NOT NULL,
    "approval_status" VARCHAR(32) NOT NULL,
    "audit_mode" VARCHAR(16),
    "audit_decision" VARCHAR(32),
    "audit_findings_jsonb" JSONB,
    "audit_ledger_jsonb" JSONB NOT NULL DEFAULT '[]',
    "review_request_id" UUID,
    "context_packet_id" UUID,
    "provider" VARCHAR(32),
    "model" VARCHAR(160),
    "prompt_spec_version" VARCHAR(32),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_draft_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_send_intents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "outreach_record_id" UUID NOT NULL,
    "sender_connection_id" UUID NOT NULL,
    "request_key" VARCHAR(128) NOT NULL,
    "request_fingerprint" VARCHAR(160) NOT NULL,
    "append_signature" BOOLEAN NOT NULL DEFAULT true,
    "attachment_ids_jsonb" JSONB NOT NULL DEFAULT '[]',
    "test_mode" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "totals_jsonb" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_send_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "send_intent_id" UUID NOT NULL,
    "draft_version_id" UUID NOT NULL,
    "generation_key" VARCHAR(512) NOT NULL,
    "recipient_key" VARCHAR(256) NOT NULL,
    "recipient_envelope_jsonb" JSONB NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "correlation_id" UUID NOT NULL,
    "rendered_subject" TEXT NOT NULL,
    "rendered_body" TEXT NOT NULL,
    "attachment_manifest_jsonb" JSONB NOT NULL DEFAULT '[]',
    "provider" VARCHAR(32) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" TEXT,
    "provider_thread_id" TEXT,
    "provider_draft_id" TEXT,
    "provider_internet_message_id" TEXT,
    "error_code" VARCHAR(120),
    "error_message" TEXT,
    "claimed_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outreach_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_ai_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "key_ciphertext" TEXT NOT NULL,
    "key_iv" TEXT NOT NULL,
    "key_auth_tag" TEXT NOT NULL,
    "key_version" TEXT NOT NULL DEFAULT 'v1',
    "key_last4" VARCHAR(4) NOT NULL,
    "model_override" VARCHAR(80),
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "last_validated_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_ai_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clio_proactive_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "owner_user_id" UUID,
    "alert_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source_type" TEXT,
    "source_id" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),

    CONSTRAINT "clio_proactive_alerts_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "client_capabilities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'product',
    "description" TEXT,
    "sector" TEXT,
    "tags_jsonb" JSONB NOT NULL DEFAULT '[]',
    "issue_codes_jsonb" JSONB NOT NULL DEFAULT '[]',
    "trl" INTEGER,
    "mrl" INTEGER,
    "pe_number" TEXT,
    "pe_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appropriation_account" TEXT,
    "service_branch" TEXT,
    "target_subcommittee" TEXT,
    "funding_ask" INTEGER,
    "funding_ask_label" TEXT,
    "justification" TEXT,
    "district_nexus" TEXT,
    "existing_contracts" TEXT,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_submission_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "capability_id" UUID,
    "fiscal_year" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "meta" TEXT,
    "outcome" TEXT,
    "outcome_type" TEXT NOT NULL DEFAULT 'in_progress',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_submission_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_people" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "email" CITEXT,
    "phone" TEXT,
    "role" TEXT,
    "last_contact" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "hierarchy_level" VARCHAR(24),
    "reports_to_person_id" UUID,
    "placement_source" VARCHAR(16) NOT NULL DEFAULT 'auto_title',
    "placement_confidence" DECIMAL(4,3),
    "review_required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "client_people_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_activity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "actor_user_id" UUID,
    "person_id" UUID,
    "source_type" VARCHAR(32),
    "source_id" VARCHAR(128),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "due_at" TIMESTAMPTZ(6),
    "settled_at" TIMESTAMPTZ(6),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_facilities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address_line" TEXT,
    "city" TEXT,
    "state" VARCHAR(2),
    "zip" VARCHAR(10),
    "congressional_district" VARCHAR(2),
    "congressional_district_congress" INTEGER,
    "district_source" VARCHAR(16),
    "employee_count" INTEGER,
    "notes" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "state_house_district" VARCHAR(64),
    "state_senate_district" VARCHAR(64),
    "geocoded_at" TIMESTAMPTZ(6),
    "geocode_status" VARCHAR(16),
    "geocode_input_hash" TEXT,
    "geocode_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "geocode_next_attempt_at" TIMESTAMPTZ(6),
    "geocode_last_error" TEXT,
    "geocode_matched_address" TEXT,
    "geocode_candidates_jsonb" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_targets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "member_id" TEXT NOT NULL,
    "member_name" TEXT,
    "source_directory" VARCHAR(16) NOT NULL DEFAULT 'congress',
    "party" VARCHAR(32),
    "state" TEXT,
    "chamber" VARCHAR(24),
    "committee" TEXT,
    "staff_kind" VARCHAR(16),
    "tier" SMALLINT,
    "source" VARCHAR(8) NOT NULL DEFAULT 'manual',
    "added_by_user_id" UUID,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_target_recommendations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "recommendations_jsonb" JSONB NOT NULL DEFAULT '[]',
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_target_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_capability_fit_recommendations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "matches_jsonb" JSONB NOT NULL DEFAULT '[]',
    "input_fingerprint" TEXT,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_capability_fit_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_recommendation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "district_key" VARCHAR(8),
    "pe_code" VARCHAR(16),
    "program_id" UUID,
    "delta_id" UUID,
    "action_type" VARCHAR(40) NOT NULL,
    "issue_title" TEXT NOT NULL,
    "what_changed" TEXT NOT NULL,
    "why_it_matters" TEXT NOT NULL,
    "recommended_action" TEXT NOT NULL,
    "target_audience_jsonb" JSONB NOT NULL DEFAULT '[]',
    "suggested_artifact_type" VARCHAR(40),
    "deadline" DATE,
    "deadline_source" VARCHAR(24),
    "owner_user_id" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "confidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "uncertainty" TEXT,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(24) NOT NULL DEFAULT 'new',
    "dismissal_reason" TEXT,
    "outcome" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "action_recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_campaigns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'custom',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "subject" TEXT,
    "body" TEXT,
    "source_context_jsonb" JSONB NOT NULL DEFAULT '{}',
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "engagement_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_campaign_recipients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "title" TEXT,
    "office" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ(6),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engagement_campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lobby_intel" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT,
    "total_spending" DECIMAL(18,2),
    "filings" INTEGER,
    "issues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "years" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "trajectory" TEXT,
    "growth_rate" DOUBLE PRECISION,
    "yearly_spend_jsonb" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'openlobby',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "lobby_intel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lobby_issue_ref" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "total_spending" DECIMAL(18,2),
    "total_filings" INTEGER,
    "surge_trend" TEXT,
    "surge_pct" DOUBLE PRECISION,
    "latest_quarter" TEXT,
    "latest_income" DECIMAL(18,2),
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lobby_issue_ref_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "lobby_trending_topics" (
    "id" UUID NOT NULL,
    "word" TEXT NOT NULL,
    "latest_count" INTEGER NOT NULL,
    "avg_prior" DOUBLE PRECISION,
    "growth_pct" DOUBLE PRECISION,
    "kind" TEXT NOT NULL DEFAULT 'trending',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lobby_trending_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_contractor" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "uei" TEXT,
    "recipient_id" TEXT,
    "total_contracts" DECIMAL(18,2),
    "pct_of_all_contracts" DOUBLE PRECISION,
    "cost_per_taxpayer" DOUBLE PRECISION,
    "category" TEXT,
    "subsidiaries" INTEGER,
    "yearly_spend_jsonb" JSONB NOT NULL DEFAULT '[]',
    "top_agencies_jsonb" JSONB NOT NULL DEFAULT '[]',
    "top_awards_jsonb" JSONB NOT NULL DEFAULT '[]',
    "no_bid_awards_jsonb" JSONB NOT NULL DEFAULT '[]',
    "no_bid_total" DECIMAL(18,2),
    "rank_by_contracts" INTEGER,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "federal_contractor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_agency" (
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT,
    "code" TEXT,
    "display_name" TEXT,
    "budget_authority" DECIMAL(18,2),
    "obligated" DECIMAL(18,2),
    "outlays" DECIMAL(18,2),
    "pct_of_total" DOUBLE PRECISION,
    "pct_of_budget" DOUBLE PRECISION,
    "pct_contracts" DOUBLE PRECISION,
    "cost_per_american" DOUBLE PRECISION,
    "rank_by_spending" INTEGER,
    "contracts_total" DECIMAL(18,2),
    "grants_total" DECIMAL(18,2),
    "yearly_budget_jsonb" JSONB NOT NULL DEFAULT '[]',
    "top_contractors_jsonb" JSONB NOT NULL DEFAULT '[]',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_agency_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "federal_industry" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "total_spending" DECIMAL(18,2),
    "rank" INTEGER,
    "pct_of_total" DOUBLE PRECISION,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_industry_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "lda_filing" (
    "id" UUID NOT NULL,
    "filing_uuid" TEXT NOT NULL,
    "filing_type" TEXT NOT NULL,
    "filing_year" INTEGER NOT NULL,
    "filing_period" TEXT,
    "income" DECIMAL(18,2),
    "expenses" DECIMAL(18,2),
    "dt_posted" TIMESTAMPTZ(6),
    "registrant_id" INTEGER,
    "registrant_name" TEXT NOT NULL DEFAULT '',
    "client_id" INTEGER,
    "client_name" TEXT NOT NULL DEFAULT '',
    "client_state" TEXT,
    "client_country" TEXT NOT NULL DEFAULT 'US',
    "client_description" TEXT,
    "issue_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "government_entities" JSONB NOT NULL DEFAULT '[]',
    "lobbyists" JSONB NOT NULL DEFAULT '[]',
    "lobbying_activities" JSONB NOT NULL DEFAULT '[]',
    "filing_document_url" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lda_filing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lda_client" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "general_description" TEXT,
    "state" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "effective_date" DATE,
    "total_filings" INTEGER NOT NULL DEFAULT 0,
    "total_spending" DECIMAL(18,2),
    "latest_filing_year" INTEGER,
    "issue_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lda_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lda_registrant" (
    "id" INTEGER NOT NULL,
    "house_registrant_id" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "total_filings" INTEGER NOT NULL DEFAULT 0,
    "total_clients" INTEGER NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lda_registrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lda_lobbyist" (
    "id" INTEGER NOT NULL,
    "first_name" TEXT NOT NULL DEFAULT '',
    "last_name" TEXT NOT NULL DEFAULT '',
    "prefix" TEXT,
    "suffix" TEXT,
    "covered_positions" JSONB NOT NULL DEFAULT '[]',
    "registrant_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "active_years" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lda_lobbyist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lda_contribution" (
    "id" UUID NOT NULL,
    "filing_uuid" TEXT NOT NULL,
    "filing_type" TEXT NOT NULL,
    "filing_year" INTEGER NOT NULL,
    "filing_period" TEXT,
    "filer_type" TEXT NOT NULL DEFAULT 'registrant',
    "dt_posted" TIMESTAMPTZ(6),
    "registrant_id" INTEGER,
    "registrant_name" TEXT,
    "lobbyist_id" INTEGER,
    "lobbyist_name" TEXT,
    "no_contributions" BOOLEAN NOT NULL DEFAULT false,
    "pacs" JSONB NOT NULL DEFAULT '[]',
    "contribution_items" JSONB NOT NULL DEFAULT '[]',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lda_contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lda_issue_code" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "total_filings_5y" INTEGER NOT NULL DEFAULT 0,
    "total_spending_5y" DECIMAL(18,2),
    "quarterly_trend" JSONB NOT NULL DEFAULT '[]',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lda_issue_code_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "lda_government_entity" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "total_filings_5y" INTEGER NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lda_government_entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meri_analytics_query_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID,
    "dataset_key" TEXT NOT NULL,
    "sql" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '[]',
    "row_count" INTEGER,
    "duration_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meri_analytics_query_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fec_committee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "committee_type" TEXT,
    "designation" TEXT,
    "party" TEXT,
    "state" TEXT,
    "treasurer_name" TEXT,
    "total_receipts" DECIMAL(18,2),
    "total_disbursements" DECIMAL(18,2),
    "cash_on_hand" DECIMAL(18,2),
    "cycles" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fec_committee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fec_contribution" (
    "id" UUID NOT NULL,
    "committee_id" TEXT NOT NULL,
    "committee_name" TEXT,
    "candidate_id" TEXT,
    "candidate_name" TEXT,
    "contributor_name" TEXT,
    "contributor_employer" TEXT,
    "contributor_occupation" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "contribution_date" DATE,
    "receipt_type" TEXT,
    "memo_text" TEXT,
    "state" TEXT,
    "cycle" INTEGER NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fec_contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fec_pac_contribution" (
    "id" UUID NOT NULL,
    "committee_id" TEXT NOT NULL,
    "committee_name" TEXT,
    "recipient_name" TEXT,
    "recipient_committee_id" TEXT,
    "candidate_id" TEXT,
    "candidate_name" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "disbursement_date" DATE,
    "disbursement_type" TEXT,
    "memo_text" TEXT,
    "source_sub_id" TEXT,
    "source_transaction_id" TEXT,
    "source_file_number" TEXT,
    "cycle" INTEGER NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fec_pac_contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fec_pac_sync_state" (
    "committee_id" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "source_row_count" INTEGER NOT NULL DEFAULT 0,
    "contribution_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fec_pac_sync_state_pkey" PRIMARY KEY ("committee_id","cycle")
);

-- CreateTable
CREATE TABLE "congress_bill" (
    "id" TEXT NOT NULL,
    "congress" INTEGER NOT NULL,
    "bill_type" TEXT NOT NULL,
    "bill_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "introduced_date" DATE,
    "sponsor_name" TEXT,
    "sponsor_state" TEXT,
    "sponsor_party" TEXT,
    "sponsor_bioguide_id" TEXT,
    "latest_action_text" TEXT,
    "latest_action_date" DATE,
    "policy_area" TEXT,
    "subjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pe_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "committees" JSONB NOT NULL DEFAULT '[]',
    "cosponsors_count" INTEGER NOT NULL DEFAULT 0,
    "origin_chamber" TEXT,
    "update_date" TIMESTAMPTZ(6),
    "update_date_including_text" TIMESTAMPTZ(6),
    "status" TEXT,
    "status_at" TIMESTAMPTZ(6),
    "url" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "congress_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cbo_cost_estimate" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT,
    "congress" INTEGER NOT NULL,
    "bill_type" TEXT NOT NULL,
    "bill_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "pub_date" TIMESTAMPTZ(6) NOT NULL,
    "cbo_url" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'congress-api',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cbo_cost_estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "congress_member" (
    "bioguide_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "party" TEXT,
    "state" TEXT,
    "district" INTEGER,
    "chamber" TEXT NOT NULL,
    "lis_id" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "congresses" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "ids_jsonb" JSONB NOT NULL DEFAULT '{}',
    "update_date" TIMESTAMPTZ(6),
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "congress_member_pkey" PRIMARY KEY ("bioguide_id")
);

-- CreateTable
CREATE TABLE "congress_bill_cosponsor" (
    "id" UUID NOT NULL,
    "bill_id" TEXT NOT NULL,
    "bioguide_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "party" TEXT,
    "state" TEXT,
    "district" INTEGER,
    "sponsorship_date" DATE,
    "is_original" BOOLEAN NOT NULL DEFAULT false,
    "withdrawn_date" DATE,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "congress_bill_cosponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "congress_committee" (
    "system_code" TEXT NOT NULL,
    "thomas_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chamber" TEXT NOT NULL,
    "parent_system_code" TEXT,
    "url" TEXT,
    "url_source" TEXT,
    "url_verified_at" TIMESTAMPTZ(6),
    "jurisdiction" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "congress_committee_pkey" PRIMARY KEY ("system_code")
);

-- CreateTable
CREATE TABLE "congress_committee_membership" (
    "id" UUID NOT NULL,
    "system_code" TEXT NOT NULL,
    "bioguide_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "rank" INTEGER,
    "title" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "congress_committee_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_crosswalk" (
    "id" UUID NOT NULL,
    "id_type" TEXT NOT NULL,
    "id_value" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_crosswalk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roll_call_vote" (
    "id" TEXT NOT NULL,
    "chamber" TEXT NOT NULL,
    "congress" INTEGER NOT NULL,
    "session" INTEGER NOT NULL,
    "roll_number" INTEGER NOT NULL,
    "bill_id" TEXT,
    "question" TEXT,
    "result" TEXT,
    "vote_type" TEXT,
    "vote_date" TIMESTAMPTZ(6) NOT NULL,
    "yeas" INTEGER NOT NULL DEFAULT 0,
    "nays" INTEGER NOT NULL DEFAULT 0,
    "present" INTEGER NOT NULL DEFAULT 0,
    "not_voting" INTEGER NOT NULL DEFAULT 0,
    "party_totals" JSONB NOT NULL DEFAULT '{}',
    "title" TEXT,
    "source_url" TEXT,
    "source" TEXT NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roll_call_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_vote" (
    "id" UUID NOT NULL,
    "vote_id" TEXT NOT NULL,
    "member_key" TEXT NOT NULL,
    "bioguide_id" TEXT,
    "lis_id" TEXT,
    "vote_cast" TEXT NOT NULL,
    "party" TEXT,
    "state" TEXT,

    CONSTRAINT "member_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_rule_link" (
    "id" UUID NOT NULL,
    "rule_bill_id" TEXT NOT NULL,
    "target_bill_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_rule_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_text" (
    "id" UUID NOT NULL,
    "bill_id" TEXT NOT NULL,
    "source_url" TEXT,
    "text_content" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_text_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_evidence_revision" (
    "id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "provider" VARCHAR(24) NOT NULL,
    "collection" VARCHAR(16) NOT NULL,
    "package_id" TEXT NOT NULL,
    "bill_id" TEXT,
    "version_code" VARCHAR(32),
    "lineage_key" TEXT NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "extraction_hash" CHAR(64) NOT NULL,
    "parser_version" VARCHAR(64) NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_modified_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_content" TEXT NOT NULL,
    "extracted_text" TEXT NOT NULL,
    "completeness" VARCHAR(16) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "federal_evidence_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_evidence_passage" (
    "revision_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "tsv" tsvector NOT NULL,

    CONSTRAINT "federal_evidence_passage_pkey" PRIMARY KEY ("revision_id","ordinal")
);

-- CreateTable
CREATE TABLE "federal_evidence_observation" (
    "id" BIGSERIAL NOT NULL,
    "observation_key" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "revision_id" UUID,
    "state" VARCHAR(16) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_modified_at" TIMESTAMPTZ(6),
    "inventory_window_end" TIMESTAMPTZ(6) NOT NULL,
    "historical" BOOLEAN NOT NULL DEFAULT false,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "federal_evidence_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_evidence_mention" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "candidate_key" TEXT NOT NULL,
    "raw_mention" TEXT NOT NULL,
    "canonical_pe_code" VARCHAR(16),
    "match_type" VARCHAR(24) NOT NULL,
    "qualification_state" VARCHAR(16) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "locator" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "language_hash" CHAR(64) NOT NULL,
    "matcher_version" VARCHAR(64) NOT NULL,
    "qualified_by" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "federal_evidence_mention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_evidence_mention_event" (
    "id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "bill_id" TEXT,
    "event_type" VARCHAR(24) NOT NULL,
    "candidate_key" TEXT NOT NULL,
    "raw_mention" TEXT NOT NULL,
    "canonical_pe_code" VARCHAR(16),
    "previous_revision_id" UUID,
    "current_revision_id" UUID,
    "before_jsonb" JSONB,
    "after_jsonb" JSONB,
    "historical" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_evidence_mention_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_evidence_change_outbox" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload_jsonb" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "federal_evidence_change_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_evidence_checkpoint" (
    "source" TEXT NOT NULL,
    "cursor_jsonb" JSONB,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "status" VARCHAR(16) NOT NULL DEFAULT 'idle',
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "federal_evidence_checkpoint_pkey" PRIMARY KEY ("source")
);

-- CreateTable
CREATE TABLE "federal_evidence_inventory_member" (
    "inventory_source" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "last_seen_window_end" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "federal_evidence_inventory_member_pkey" PRIMARY KEY ("inventory_source","source_key")
);

-- CreateTable
CREATE TABLE "federal_evidence_coverage_gap" (
    "source_key" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "collection" VARCHAR(16) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "detail" TEXT,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "federal_evidence_coverage_gap_pkey" PRIMARY KEY ("source_key","reason")
);

-- CreateTable
CREATE TABLE "congress_bill_action" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "type" TEXT,
    "chamber" TEXT,

    CONSTRAINT "congress_bill_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "congress_bill_committee" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "committee_name" TEXT NOT NULL,
    "committee_code" TEXT,
    "chamber" TEXT,

    CONSTRAINT "congress_bill_committee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "congress_bill_subject" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "congress_bill_subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element" (
    "pe_code" VARCHAR(16) NOT NULL,
    "service" TEXT,
    "service_code" TEXT,
    "appropriation_type" TEXT,
    "budget_activity" TEXT,
    "budget_activity_name" TEXT,
    "line_number" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "acat_level" TEXT,
    "program_of_record" TEXT,
    "status" TEXT,
    "r_doc_url" TEXT,
    "p_doc_url" TEXT,
    "o_doc_url" TEXT,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL,
    "source_confidence" DOUBLE PRECISION,
    "first_seen_fy" INTEGER,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),
    "retired_reason" TEXT,

    CONSTRAINT "program_element_pkey" PRIMARY KEY ("pe_code")
);

-- CreateTable
CREATE TABLE "program_element_source" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "doc_type" VARCHAR(8) NOT NULL,
    "exhibit_type" VARCHAR(16),
    "fy" INTEGER,
    "source_url" TEXT NOT NULL,
    "page_number" INTEGER,
    "page_end" INTEGER,
    "snippet" TEXT,
    "publisher" VARCHAR(64),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "source_document_id" UUID,

    CONSTRAINT "program_element_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_project" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "project_code" VARCHAR(32) NOT NULL,
    "title" TEXT NOT NULL,
    "mission" TEXT,
    "budget_activity" TEXT,
    "fy" INTEGER,
    "source_url" TEXT,
    "page_number" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'comptroller_jbook_r2a',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "source_document_id" UUID,

    CONSTRAINT "program_element_project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_year" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "fy" INTEGER NOT NULL,
    "request" DECIMAL(14,2),
    "hasc_mark" DECIMAL(14,2),
    "sasc_mark" DECIMAL(14,2),
    "hac_d_mark" DECIMAL(14,2),
    "sac_d_mark" DECIMAL(14,2),
    "conference" DECIMAL(14,2),
    "ndaa_conference" DECIMAL(14,2),
    "enacted" DECIMAL(14,2),
    "reprogrammed" DECIMAL(14,2),
    "executed" DECIMAL(14,2),
    "notes" TEXT,
    "r_doc_section" TEXT,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_line" (
    "id" UUID NOT NULL,
    "appropriation_code" VARCHAR(16) NOT NULL,
    "appropriation_title" TEXT,
    "component" TEXT,
    "budget_activity" TEXT,
    "budget_sub_activity" TEXT,
    "p1_line_number" INTEGER,
    "line_item_number" VARCHAR(32) NOT NULL,
    "title" TEXT NOT NULL,
    "related_pe_code" VARCHAR(16),
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procurement_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_line_year" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "fy" INTEGER NOT NULL,
    "subline_key" VARCHAR(32) NOT NULL DEFAULT '',
    "subline_title" TEXT,
    "p1_line_number" INTEGER,
    "request" DECIMAL(18,6),
    "hasc_mark" DECIMAL(18,6),
    "sasc_mark" DECIMAL(18,6),
    "hac_d_mark" DECIMAL(18,6),
    "sac_d_mark" DECIMAL(18,6),
    "conference" DECIMAL(18,6),
    "enacted" DECIMAL(18,6),
    "actuals" DECIMAL(18,6),
    "quantity" INTEGER,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procurement_line_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_line_source" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "year_id" UUID,
    "doc_type" VARCHAR(8) NOT NULL,
    "exhibit_type" VARCHAR(16),
    "fy" INTEGER,
    "source_url" TEXT NOT NULL,
    "page_number" INTEGER,
    "page_end" INTEGER,
    "snippet" TEXT,
    "publisher" VARCHAR(64),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "extractor_version" TEXT,
    "source_span_hash" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "source_document_id" UUID,

    CONSTRAINT "procurement_line_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_budget_position" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "position_cycle" TEXT NOT NULL,
    "asserted_fy" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "quantity" DECIMAL(14,2),
    "value_kind" TEXT NOT NULL,
    "source_url" TEXT,
    "page_number" INTEGER,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_document_id" UUID,

    CONSTRAINT "program_element_budget_position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_project_budget_position" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "project_code" VARCHAR(32) NOT NULL,
    "position_cycle" TEXT NOT NULL,
    "asserted_fy" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "quantity" DECIMAL(14,2),
    "value_kind" TEXT NOT NULL,
    "source_url" TEXT,
    "page_number" INTEGER,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_document_id" UUID,

    CONSTRAINT "program_element_project_budget_position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_delta" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "asserted_fy" INTEGER NOT NULL,
    "delta_type" TEXT NOT NULL,
    "from_ref" TEXT,
    "to_ref" TEXT,
    "amount_from" DECIMAL(14,2),
    "amount_to" DECIMAL(14,2),
    "delta_abs" DECIMAL(14,2),
    "delta_pct" DOUBLE PRECISION,
    "explanation" TEXT,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "materiality_score" DOUBLE PRECISION NOT NULL,
    "materiality_factors_jsonb" JSONB NOT NULL DEFAULT '{}',
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMPTZ(6),

    CONSTRAINT "program_element_delta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_milestone" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "milestone_type" TEXT NOT NULL,
    "planned_date" DATE,
    "actual_date" DATE,
    "status" TEXT,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_milestone_schedule_period" (
    "id" UUID NOT NULL,
    "milestone_id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "milestone_type" TEXT NOT NULL,
    "period_role" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "period_kind" TEXT NOT NULL,
    "fiscal_year" INTEGER,
    "fiscal_quarter" INTEGER,
    "calendar_year" INTEGER,
    "calendar_quarter" INTEGER,
    "calendar_month" INTEGER,
    "exact_date" DATE,
    "range_start" DATE,
    "range_end" DATE,
    "source_url" TEXT,
    "page_number" INTEGER,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_document_id" UUID,

    CONSTRAINT "program_element_milestone_schedule_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_quarantine" (
    "id" UUID NOT NULL,
    "raw_record" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "quarantined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_ingest_run" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "fy" INTEGER,
    "artifact_path" TEXT,
    "artifact_sha256" TEXT,
    "rows_emitted" INTEGER NOT NULL DEFAULT 0,
    "upserted" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "quarantined" INTEGER NOT NULL DEFAULT 0,
    "pe_codes_distinct" INTEGER NOT NULL DEFAULT 0,
    "title_truncated" INTEGER NOT NULL DEFAULT 0,
    "units_anomalies" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "notes" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_ingest_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_year_source_value" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "fy" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observation_key" TEXT,
    "parse_job_id" UUID,
    "page_number" INTEGER,
    "source_span_hash" TEXT,
    "extractor_version" TEXT,
    "value_jsonb" JSONB NOT NULL DEFAULT 'null',
    "value_decimal" DECIMAL(18,2),
    "original_value_decimal" DECIMAL(20,6),
    "original_unit" TEXT,
    "canonical_value_m" DECIMAL(18,6),
    "value_text" TEXT,
    "written_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_winner" BOOLEAN NOT NULL DEFAULT false,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observation_count" INTEGER NOT NULL DEFAULT 1,
    "source_document_id" UUID,

    CONSTRAINT "program_element_year_source_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_change_outbox" (
    "id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_jsonb" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "program_element_change_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_document" (
    "id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "fiscal_year" INTEGER,
    "budget_cycle" TEXT NOT NULL,
    "component" TEXT,
    "document_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "sha256" CHAR(64),
    "byte_size" INTEGER,
    "page_count" INTEGER,
    "downloaded_at" TIMESTAMPTZ(6),
    "artifact_path" TEXT,
    "extraction_method" TEXT NOT NULL,
    "extraction_tool_version" TEXT,
    "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_by_document_id" UUID,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "archive_bucket" TEXT,
    "archive_s3_key" TEXT,
    "archive_version_id" TEXT,
    "archive_kms_key_arn" TEXT,
    "retain_until" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "source_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_funding_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identity_hash" CHAR(64) NOT NULL,
    "chamber" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "congress" INTEGER,
    "fiscal_year" INTEGER NOT NULL,
    "requester_name" TEXT NOT NULL,
    "requester_state" CHAR(2),
    "requester_district" TEXT,
    "recipient_name" TEXT NOT NULL,
    "recipient_normalized" TEXT NOT NULL,
    "recipient_address" TEXT,
    "city" TEXT,
    "state" CHAR(2),
    "zip" TEXT,
    "project_title" TEXT NOT NULL,
    "project_description" TEXT,
    "requested_amount_usd" DECIMAL(18,2) NOT NULL,
    "final_amount_usd" DECIMAL(18,2),
    "amount_stage_raw" TEXT NOT NULL,
    "appropriations_account_raw" TEXT,
    "appropriations_account_normalized" TEXT,
    "subcommittee" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_funding_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_funding_request_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_page" INTEGER,
    "source_row" INTEGER NOT NULL,
    "source_hash" CHAR(64) NOT NULL,
    "retrieved_at" TIMESTAMPTZ(6) NOT NULL,
    "requester_name_raw" TEXT NOT NULL,
    "amount_stage_raw" TEXT NOT NULL,
    "requested_amount_usd" DECIMAL(18,2) NOT NULL,
    "final_amount_usd" DECIMAL(18,2),
    "appropriations_account_raw" TEXT,
    "subcommittee" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_funding_request_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_funding_discovery_crawl" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adapter_id" TEXT NOT NULL,
    "run_key" TEXT NOT NULL,
    "request_url" TEXT NOT NULL,
    "status_code" INTEGER,
    "status" TEXT NOT NULL,
    "content_sha256" CHAR(64),
    "byte_size" INTEGER,
    "items_seen" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_funding_discovery_crawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_funding_discovery_candidate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "crawl_id" UUID NOT NULL,
    "adapter_id" TEXT NOT NULL,
    "run_key" TEXT NOT NULL,
    "candidate_url" TEXT NOT NULL,
    "title" TEXT,
    "resolution" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "emitted" BOOLEAN NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_funding_discovery_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_funding_ingest_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source" TEXT NOT NULL,
    "chamber" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "subcommittee" TEXT,
    "artifact_path" TEXT,
    "artifact_sha256" CHAR(64),
    "rows_emitted" INTEGER NOT NULL DEFAULT 0,
    "upserted" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_funding_ingest_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_parse_job" (
    "id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_job_id" TEXT,
    "mode" TEXT NOT NULL,
    "result_type" TEXT NOT NULL,
    "page_start" INTEGER,
    "page_end" INTEGER,
    "input_sha256" CHAR(64) NOT NULL,
    "output_markdown_s3_key" TEXT,
    "output_json_s3_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "credits_used" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "document_parse_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_review_queue" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "fy" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "conflict_type" TEXT NOT NULL DEFAULT 'value_conflict',
    "current_value" TEXT,
    "current_source" TEXT,
    "current_source_document_id" UUID,
    "conflicting_source" TEXT NOT NULL,
    "conflicting_value" TEXT,
    "conflicting_source_document_id" UUID,
    "delta_pct" DOUBLE PRECISION,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observation_count" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_notes" TEXT,
    "proposed_override_id" UUID,

    CONSTRAINT "reconciliation_review_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_watch" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_watch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_client_watch" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "target_type" VARCHAR(20) NOT NULL,
    "target_key" VARCHAR(160) NOT NULL,
    "client_reason" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_client_watch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_client_watch_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "watch_id" UUID NOT NULL,
    "event_type" VARCHAR(24) NOT NULL,
    "logical_event_key" VARCHAR(200) NOT NULL,
    "update_event_id" UUID,
    "actor_user_id" UUID,
    "material_reason" TEXT,
    "evidence" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_client_watch_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_data_issue" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reported_by_user_id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "fy" INTEGER,
    "field_name" TEXT,
    "issue_type" VARCHAR(40) NOT NULL,
    "description" TEXT NOT NULL,
    "suggested_source_url" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "resolution_notes" TEXT,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "program_element_data_issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pe_alert_email_pref" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" VARCHAR(24) NOT NULL DEFAULT 'daily',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pe_alert_email_pref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_personnel" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "service" VARCHAR(8),
    "organization" TEXT,
    "title" TEXT,
    "role" TEXT,
    "program_of_record" TEXT,
    "pe_primary" VARCHAR(16),
    "pe_secondary" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email_domain" TEXT,
    "email" TEXT,
    "public_profile_url" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "superseded_at" TIMESTAMPTZ(6),
    "superseded_reason" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "acquisition_personnel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_personnel_source" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "source_url" TEXT,
    "snippet" TEXT,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acquisition_personnel_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_personnel_quarantine" (
    "id" UUID NOT NULL,
    "raw_record_jsonb" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "quarantined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acquisition_personnel_quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_personnel_merge_candidate" (
    "id" UUID NOT NULL,
    "primary_person_id" UUID NOT NULL,
    "secondary_person_id" UUID NOT NULL,
    "similarity_score" DOUBLE PRECISION NOT NULL,
    "score_breakdown_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "decision_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acquisition_personnel_merge_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_person_candidate" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "match_basis" TEXT,
    "score_breakdown_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "decision_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_person_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conference_probability" (
    "pe_code" VARCHAR(16) NOT NULL,
    "fy" INTEGER NOT NULL,
    "predicted" DECIMAL(14,4) NOT NULL,
    "ci_low" DECIMAL(14,4) NOT NULL,
    "ci_high" DECIMAL(14,4) NOT NULL,
    "confidence" DECIMAL(6,4) NOT NULL,
    "model_version" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conference_probability_pkey" PRIMARY KEY ("pe_code","fy")
);

-- CreateTable
CREATE TABLE "federal_register_document" (
    "id" TEXT NOT NULL,
    "document_number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "abstract" TEXT,
    "agency_names" TEXT[],
    "publication_date" TIMESTAMP(3) NOT NULL,
    "comment_end_date" TIMESTAMP(3),
    "effective_date" TIMESTAMP(3),
    "effective_date_evidence" JSONB,
    "effective_date_observed_at" TIMESTAMPTZ(6),
    "docket_ids" TEXT[],
    "cfr_references" TEXT[],
    "html_url" TEXT,
    "pdf_url" TEXT,
    "topics" TEXT[],
    "significant_rule" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_register_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence_insight" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID,
    "client_id" UUID,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "data_points" JSONB,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "intelligence_insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_intel_mapping" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_name" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "match_basis" VARCHAR(40),
    "match_tier" INTEGER,
    "match_evidence_jsonb" JSONB,
    "relationship_type" VARCHAR(24),
    "roll_up_awards" BOOLEAN,
    "review_status" VARCHAR(16) NOT NULL DEFAULT 'candidate',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_intel_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_bill" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "bill_id" TEXT NOT NULL,
    "note" TEXT,
    "source" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_action_text" TEXT,
    "last_seen_action_date" DATE,
    "last_seen_at" TIMESTAMPTZ(6),

    CONSTRAINT "tracked_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_state" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "alert_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "snoozed_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_brief" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "created_by" TEXT,
    "source_alert_id" TEXT,
    "source_type" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_brief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_watchlist" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "issue_areas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" JSONB NOT NULL DEFAULT '[]',
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_preference" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "triggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "materiality" TEXT NOT NULL DEFAULT 'medium',
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_address" TEXT,
    "email_cadence" TEXT NOT NULL DEFAULT 'realtime',
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_phone" TEXT,
    "sms_phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "sms_cadence" TEXT NOT NULL DEFAULT 'realtime',
    "quiet_hours_start" TEXT,
    "quiet_hours_end" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracker_feedback" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" TEXT,
    "bill_id" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracker_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "district_nexus_alert_payload" (
    "notification_log_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "state_code" VARCHAR(2) NOT NULL,
    "district_code" VARCHAR(8),
    "payload" JSONB NOT NULL,

    CONSTRAINT "district_nexus_alert_payload_pkey" PRIMARY KEY ("notification_log_id")
);

-- CreateTable
CREATE TABLE "alert_digest_queue" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "flushed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_digest_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_verification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" UUID,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence_change" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "change_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "related_client_ids" UUID[],
    "related_issues" TEXT[],
    "related_pe_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "data" JSONB NOT NULL DEFAULT '{}',
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "dedupe_key" TEXT,

    CONSTRAINT "intelligence_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_docket" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "docket_id" TEXT,
    "document_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "posted_date" TIMESTAMP(3),
    "comment_start_date" TIMESTAMP(3),
    "comment_end_date" TIMESTAMP(3),
    "fr_doc_num" TEXT,
    "subtype" TEXT,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "last_modified" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regulatory_docket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sec_filing" (
    "id" TEXT NOT NULL,
    "cik" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "form_type" TEXT NOT NULL,
    "accession_number" TEXT NOT NULL,
    "filing_date" DATE NOT NULL,
    "report_date" DATE,
    "primary_doc" TEXT,
    "description" TEXT,
    "sic" TEXT,
    "state_of_incorp" TEXT,
    "fiscal_year_end" TEXT,
    "url" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sec_filing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fara_registration" (
    "id" TEXT NOT NULL,
    "registration_number" TEXT NOT NULL,
    "registrant_name" TEXT NOT NULL,
    "foreign_principal" TEXT NOT NULL,
    "country" TEXT,
    "status" TEXT,
    "registration_date" DATE,
    "termination_date" DATE,
    "address" TEXT,
    "state" TEXT,
    "description" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fara_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_comment" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "docket_id" TEXT,
    "agency_id" TEXT,
    "title" TEXT NOT NULL,
    "comment_text" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "organization" TEXT,
    "city" TEXT,
    "state_province" TEXT,
    "country" TEXT,
    "posted_date" TIMESTAMP(3),
    "source_url" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regulatory_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bls_series" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "survey_name" TEXT,
    "area" TEXT,
    "industry" TEXT,
    "period_type" TEXT NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bls_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bls_data_point" (
    "id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "footnotes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "bls_data_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "census_district" (
    "id" TEXT NOT NULL,
    "congress" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "state_fips" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "total_population" INTEGER,
    "median_household_income" INTEGER,
    "median_age" DOUBLE PRECISION,
    "percent_bachelor_plus" DOUBLE PRECISION,
    "percent_poverty" DOUBLE PRECISION,
    "percent_veteran" DOUBLE PRECISION,
    "percent_uninsured" DOUBLE PRECISION,
    "labor_force_size" INTEGER,
    "unemployment_rate" DOUBLE PRECISION,
    "top_industries" JSONB NOT NULL DEFAULT '[]',
    "data_year" INTEGER NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "census_district_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legislative_district" (
    "id" TEXT NOT NULL,
    "legistorm_district_id" INTEGER NOT NULL,
    "chamber" TEXT NOT NULL,
    "state" VARCHAR(2) NOT NULL,
    "district_no" TEXT,
    "senate_class" INTEGER,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "effective_date" DATE,
    "enacted_date" DATE,
    "current_member_bioguides" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kml_s3_key" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "geojson_s3_key" TEXT,
    "boundary_bbox_json" JSONB,
    "boundary_centroid_json" JSONB,
    "boundary_source" TEXT,
    "boundary_built_at" TIMESTAMPTZ(6),
    "boundary_hash" TEXT,

    CONSTRAINT "legislative_district_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legistorm_trip" (
    "id" INTEGER NOT NULL,
    "approver_member_id" INTEGER,
    "approver_name" TEXT,
    "traveler_member_id" INTEGER,
    "traveler_staff_id" INTEGER,
    "traveler_name" TEXT,
    "companion_name" TEXT,
    "companion_status" TEXT,
    "start_date" DATE,
    "end_date" DATE,
    "duration_days" INTEGER,
    "purpose" TEXT,
    "comment" TEXT,
    "total_cost" DOUBLE PRECISION,
    "transportation_expenses" DOUBLE PRECISION,
    "lodging_expenses" DOUBLE PRECISION,
    "meal_expenses" DOUBLE PRECISION,
    "other_expenses" DOUBLE PRECISION,
    "companion_transportation_expenses" DOUBLE PRECISION,
    "companion_lodging_expenses" DOUBLE PRECISION,
    "companion_other_expenses" DOUBLE PRECISION,
    "destinations" JSONB NOT NULL DEFAULT '[]',
    "sponsors" JSONB NOT NULL DEFAULT '[]',
    "filed_date" DATE,
    "amended_date" DATE,
    "vendor_updated_at" TIMESTAMPTZ(6),
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legistorm_trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committee_membership_watch" (
    "committee_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "person_name" TEXT,
    "role" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "committee_membership_watch_pkey" PRIMARY KEY ("committee_id","person_id")
);

-- CreateTable
CREATE TABLE "bea_data" (
    "id" TEXT NOT NULL,
    "dataset_name" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "line_number" INTEGER,
    "series_code" TEXT,
    "description" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "units" TEXT,
    "geo_fips" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bea_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "california_grant_opportunity" (
    "portal_id" TEXT NOT NULL,
    "grant_id" TEXT,
    "status" TEXT,
    "last_updated_raw" TEXT,
    "last_updated_calendar_date" DATE,
    "change_notes" TEXT,
    "agency_dept" TEXT,
    "title" TEXT,
    "type" TEXT,
    "loi" TEXT,
    "categories_raw" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category_suggestion" TEXT,
    "purpose" TEXT,
    "description" TEXT,
    "applicant_type_raw" TEXT,
    "applicant_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "applicant_type_notes" TEXT,
    "geography" TEXT,
    "funding_source" TEXT,
    "funding_source_notes" TEXT,
    "matching_funds_raw" TEXT,
    "matching_funds_percent" DECIMAL(7,4),
    "matching_funds_notes" TEXT,
    "estimated_available_funds_raw" TEXT,
    "estimated_available_funds_amount" DECIMAL(18,2),
    "estimated_awards_raw" TEXT,
    "estimated_awards_count" INTEGER,
    "estimated_amounts_raw" TEXT,
    "estimated_amount_min" DECIMAL(18,2),
    "estimated_amount_max" DECIMAL(18,2),
    "funding_method" TEXT,
    "funding_method_notes" TEXT,
    "open_date_raw" TEXT,
    "open_date_calendar_date" DATE,
    "application_deadline_raw" TEXT,
    "application_deadline_calendar_date" DATE,
    "award_period" TEXT,
    "expected_award_date" TEXT,
    "electronic_submission_raw" TEXT,
    "electronic_submission_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "electronic_submission_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grant_url" TEXT,
    "agency_url" TEXT,
    "agency_subscribe_url" TEXT,
    "grant_events_url" TEXT,
    "contact_info" TEXT,
    "award_stats" TEXT,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "california_grant_opportunity_pkey" PRIMARY KEY ("portal_id")
);

-- CreateTable
CREATE TABLE "federal_grant" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "sub_agency" TEXT,
    "opportunity_number" TEXT,
    "category" TEXT,
    "funding_instrument" TEXT,
    "eligibility" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cfda_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "award_ceiling" DOUBLE PRECISION,
    "award_floor" DOUBLE PRECISION,
    "estimated_funding" DOUBLE PRECISION,
    "expected_awards" INTEGER,
    "open_date" DATE,
    "close_date" DATE,
    "status" TEXT,
    "description" TEXT,
    "url" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eligibility_text" TEXT,
    "cost_sharing" BOOLEAN,
    "doc_type" TEXT,
    "revision" INTEGER,
    "response_date_desc" TEXT,
    "amendment_count" INTEGER,
    "last_updated_at" TIMESTAMPTZ(6),
    "raw" JSONB,
    "detail_synced_at" TIMESTAMPTZ(6),

    CONSTRAINT "federal_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gao_report" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "publish_date" DATE,
    "report_type" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "recommendations" INTEGER,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gao_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "bill_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "chamber" TEXT,
    "classification" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "sponsor_name" TEXT,
    "sponsor_party" TEXT,
    "sponsor_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT,
    "status_at" TIMESTAMPTZ(6),
    "status_source" TEXT,
    "status_derived_at" TIMESTAMPTZ(6),
    "legiscan_status" INTEGER,
    "legiscan_progress" JSONB NOT NULL DEFAULT '[]',
    "text_date" TIMESTAMPTZ(6),
    "latest_action_date" DATE,
    "latest_action_text" TEXT,
    "url" TEXT,
    "state_url" TEXT,
    "legiscan_bill_id" INTEGER,
    "legiscan_change_hash" TEXT,
    "source_checked_at" TIMESTAMPTZ(6),
    "source_check_attempted_at" TIMESTAMPTZ(6),
    "source_check_status" TEXT,
    "report_source_facts" JSONB,
    "source_check_error" TEXT,
    "openstates_id" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_committee_id" TEXT,

    CONSTRAINT "state_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_legislator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "chamber" TEXT,
    "district" TEXT,
    "party" TEXT,
    "email" TEXT,
    "image" TEXT,
    "url" TEXT,
    "source_evidence" JSONB,
    "committees" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "legiscan_people_id" INTEGER,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_legislator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill_published_record" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source_identity" TEXT NOT NULL,
    "revision_hash" TEXT NOT NULL,
    "event_date" TEXT,
    "source_order" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_published_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill_action" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "chamber" TEXT,
    "importance" INTEGER,
    "order_key" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill_sponsor" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "legiscan_people_id" INTEGER,
    "legislator_id" TEXT,
    "name" TEXT NOT NULL,
    "party" TEXT,
    "sponsor_type" TEXT NOT NULL,
    "sponsor_order" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_sponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_roll_call_vote" (
    "id" TEXT NOT NULL,
    "bill_key" TEXT,
    "legiscan_roll_call_id" INTEGER NOT NULL,
    "chamber" TEXT,
    "date" DATE,
    "motion" TEXT,
    "yeas" INTEGER NOT NULL DEFAULT 0,
    "nays" INTEGER NOT NULL DEFAULT 0,
    "nv" INTEGER NOT NULL DEFAULT 0,
    "absent" INTEGER NOT NULL DEFAULT 0,
    "passed" BOOLEAN,
    "source_url" TEXT,
    "current_revision_hash" TEXT,
    "provider_bill_hash" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_roll_call_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_member_vote" (
    "id" UUID NOT NULL,
    "vote_id" TEXT NOT NULL,
    "legiscan_people_id" INTEGER NOT NULL,
    "legislator_id" TEXT,
    "vote_cast" TEXT NOT NULL,

    CONSTRAINT "state_member_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill_version" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "legiscan_doc_id" INTEGER NOT NULL,
    "version_type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "state_url" TEXT,
    "mime" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill_link" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "related_bill_key" TEXT,
    "legiscan_related_bill_id" INTEGER NOT NULL,
    "link_type" TEXT NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill_calendar_event" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "time" TEXT,
    "location" TEXT,
    "description" TEXT,
    "raw" JSONB,
    "present" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_key" TEXT NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_calendar_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_session" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "legiscan_session_id" INTEGER NOT NULL,
    "session_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year_start" INTEGER NOT NULL,
    "year_end" INTEGER NOT NULL,
    "special" BOOLEAN NOT NULL DEFAULT false,
    "sine_die" DATE,
    "prior" BOOLEAN NOT NULL DEFAULT false,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "convene" DATE,
    "crossover_date" DATE,
    "committee_cutoff_date" DATE,
    "second_committee_cutoff_date" DATE,
    "calendar_source" TEXT,
    "calendar_confidence" TEXT,

    CONSTRAINT "state_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_committee" (
    "official_source_key" TEXT,
    "legislative_session" TEXT,
    "source_url" TEXT,
    "source_evidence" JSONB,
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "chamber" TEXT,
    "name" TEXT NOT NULL,
    "legiscan_committee_id" INTEGER,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_committee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_committee_membership" (
    "id" UUID NOT NULL,
    "committee_id" TEXT NOT NULL,
    "legislator_id" TEXT NOT NULL,
    "role" TEXT,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_committee_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_sync_cursor" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "session_id" INTEGER NOT NULL,
    "session_key" TEXT NOT NULL,
    "bill_hashes" JSONB NOT NULL DEFAULT '{}',
    "pending_bills" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "queries_used" INTEGER NOT NULL DEFAULT 0,
    "quota_month" TEXT,
    "last_list_at" TIMESTAMPTZ(6),
    "last_drain_at" TIMESTAMPTZ(6),

    CONSTRAINT "state_sync_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_rule" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "abstract" TEXT,
    "rule_type" TEXT NOT NULL,
    "docket_id" TEXT,
    "register_citation" TEXT,
    "publication_date" DATE,
    "comment_start_date" DATE,
    "comment_end_date" DATE,
    "effective_date" DATE,
    "source_url" TEXT NOT NULL,
    "linked_bill_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "filing_date" DATE,
    "linked_rule_numbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_revision" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crs_report" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" DATE,
    "authors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "pdf_url" TEXT,
    "html_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crs_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_article" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "feed_url" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "author" TEXT,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "summary" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_press_item" (
    "id" UUID NOT NULL,
    "bioguide_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "link" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "summary" TEXT,
    "source" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_press_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committee_hearing" (
    "id" TEXT NOT NULL,
    "canonical_hearing_id" TEXT,
    "alias_evidence" JSONB,
    "aliased_at" TIMESTAMPTZ(6),
    "geographic_jurisdiction" TEXT,
    "legislative_session" TEXT,
    "state_committee_id" TEXT,
    "body_source_key" TEXT,
    "calendar_revision" INTEGER NOT NULL DEFAULT 0,
    "calendar_snapshot" JSONB,
    "calendar_provenance" JSONB,
    "calendar_checked_at" TIMESTAMPTZ(6),
    "calendar_check_state" TEXT NOT NULL DEFAULT 'unknown',
    "time_precision" TEXT,
    "scheduled_end" TIMESTAMPTZ(6),
    "chamber" TEXT NOT NULL,
    "committee_name" TEXT NOT NULL,
    "committee_code" TEXT,
    "title" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "time" TEXT,
    "starts_at" TIMESTAMPTZ(6),
    "location" TEXT,
    "type" TEXT,
    "witnesses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "url" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "congress" INTEGER,
    "committee_system_code" TEXT,
    "subcommittee_system_code" TEXT,
    "actual_start" TIMESTAMPTZ(6),
    "actual_end" TIMESTAMPTZ(6),
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "event_status" TEXT NOT NULL DEFAULT 'scheduled',
    "source_revision" INTEGER NOT NULL DEFAULT 1,
    "last_official_update_at" TIMESTAMPTZ(6),
    "stream_availability" TEXT NOT NULL DEFAULT 'unknown',
    "coverage_status" TEXT NOT NULL DEFAULT 'not_covered',

    CONSTRAINT "committee_hearing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legislative_agenda_item" (
    "id" UUID NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bill_scope" TEXT,
    "state_bill_key" TEXT,
    "federal_bill_id" TEXT,
    "source_url" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legislative_agenda_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legislative_calendar_transition" (
    "id" UUID NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "changed_fields" TEXT[],
    "source_id" UUID,
    "source_url" TEXT NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legislative_calendar_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legislative_observation_revision" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legislative_observation_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legislative_calendar_coverage" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "chamber" TEXT NOT NULL,
    "session" TEXT,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "items" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legislative_calendar_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_bill_calendar_snapshot" (
    "id" UUID NOT NULL,
    "bill_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "completeness" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_bill_calendar_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committee_hearing_bill" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "congress" INTEGER NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "committee_hearing_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "official_hearing_transcript" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'govinfo',
    "congress" INTEGER NOT NULL,
    "chamber" TEXT NOT NULL,
    "committee_name" TEXT,
    "title" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "source_url" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'txt',
    "text" TEXT NOT NULL,
    "char_count" INTEGER NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "official_hearing_transcript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committee_source" (
    "id" TEXT NOT NULL,
    "committee_system_code" TEXT,
    "chamber" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "adapter_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "last_checked_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_error_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "source_health" TEXT NOT NULL DEFAULT 'unknown',
    "parser_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "committee_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committee_source_exception" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "exception_type" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "reviewed_by" TEXT NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "committee_source_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hearing_source_observation" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT,
    "source_id" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "raw_content_hash" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_updated_at" TIMESTAMPTZ(6),
    "source_metadata" JSONB NOT NULL DEFAULT '{}',
    "observed_title" TEXT,
    "observed_date" DATE,
    "observed_status" TEXT,
    "observed_location" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hearing_source_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hearing_stream_candidate" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "official_page_url" TEXT NOT NULL,
    "media_url" TEXT,
    "media_type" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "resolution_state" TEXT NOT NULL DEFAULT 'NOT_CHECKED',
    "capture_policy" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "source_id" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_probe_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hearing_stream_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_hearing_capture" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "selected_stream_candidate_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduled_start" TIMESTAMPTZ(6),
    "actual_start" TIMESTAMPTZ(6),
    "actual_end" TIMESTAMPTZ(6),
    "worker_lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "deepgram_session_ref" TEXT,
    "reconnect_count" INTEGER NOT NULL DEFAULT 0,
    "captured_seconds" INTEGER NOT NULL DEFAULT 0,
    "transcript_gap_seconds" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "lease_acquired_at" TIMESTAMP(3),
    "resolution_state" TEXT NOT NULL DEFAULT 'NOT_CHECKED',
    "last_resolution_at" TIMESTAMP(3),
    "consecutive_source_errors" INTEGER NOT NULL DEFAULT 0,
    "next_preflight_at" TIMESTAMP(3),
    "captured_ms" INTEGER NOT NULL DEFAULT 0,
    "gaps" JSONB NOT NULL DEFAULT '[]',
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "speakers_resolved_at" TIMESTAMPTZ(6),
    "speakers_resolved_through_sequence" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "public_hearing_capture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_hearing_capture_attempt" (
    "id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "worker_lease_owner" TEXT,
    "deepgram_session_ref" TEXT,
    "outcome" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_hearing_capture_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_hearing_transcript_segment" (
    "id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "speaker_label" TEXT,
    "speaker_confidence" DOUBLE PRECISION,
    "transcription_confidence" DOUBLE PRECISION,
    "is_final" BOOLEAN NOT NULL DEFAULT true,
    "has_gap_before" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_hearing_transcript_segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_hearing_speaker" (
    "id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "speaker_label" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" TEXT,
    "person_ref" TEXT,
    "confidence" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_hearing_speaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committee_site_update" (
    "id" TEXT NOT NULL,
    "committee_system_code" TEXT NOT NULL,
    "hearing_id" TEXT,
    "update_type" TEXT NOT NULL,
    "normalized_title" TEXT NOT NULL,
    "normalized_summary" TEXT,
    "source_url" TEXT NOT NULL,
    "official_published_at" TIMESTAMPTZ(6),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content_hash" TEXT NOT NULL,
    "previous_value" TEXT,
    "new_value" TEXT,
    "source_id" TEXT,
    "parser_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "committee_site_update_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hearing_subscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "notify_on_start" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_mention" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_by_user" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_by_rule_id" TEXT,
    "client_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "watchlist_id" TEXT,
    "attendance_mode" TEXT NOT NULL DEFAULT 'automatic',
    "consent_acknowledged_at" TIMESTAMPTZ(6),
    "notify_on_transcript_ready" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_intelligence_ready" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hearing_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hearing_follow" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "client_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "notify_on_start" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_updates" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_schedule_change" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_hearing_starting" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_transcript_ready" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_high_priority_match" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hearing_follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legiwatch_committee_follow" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "committee_system_code" TEXT NOT NULL,
    "client_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "notify_on_new_hearing" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_schedule_change" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_transcript_ready" BOOLEAN NOT NULL DEFAULT false,
    "notify_on_high_priority_match" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_publication" BOOLEAN NOT NULL DEFAULT true,
    "alert_started_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legiwatch_committee_follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legiwatch_saved_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "segment_id" TEXT,
    "insight_id" TEXT,
    "client_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legiwatch_saved_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legiwatch_notification_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "hearing_id" TEXT,
    "bill_id" TEXT,
    "committee_system_code" TEXT,
    "client_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "deep_link" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_delivery_status" TEXT,
    "email_delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "email_delivery_next_attempt_at" TIMESTAMPTZ(6),
    "email_delivery_lease_until" TIMESTAMPTZ(6),
    "email_delivery_lease_id" TEXT,
    "email_delivery_last_error" TEXT,
    "email_delivery_sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "legiwatch_notification_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legiwatch_committee_email_preference" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "committee_email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_address" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legiwatch_committee_email_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hearing_auto_record_rule" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "committee_filters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subcommittee_filters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "event_type_filters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keyword_filters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "client_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "watchlist_id" TEXT,
    "public_only" BOOLEAN NOT NULL DEFAULT true,
    "notify_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notify_in_app" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hearing_auto_record_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_hearing_insight" (
    "id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "segment_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "insight_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence_text" TEXT,
    "speaker_name" TEXT,
    "confidence" DOUBLE PRECISION,
    "preliminary" BOOLEAN NOT NULL DEFAULT false,
    "entities" JSONB NOT NULL DEFAULT '[]',
    "extractor" TEXT NOT NULL,
    "extractor_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "public_hearing_insight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_hearing_intelligence_job" (
    "id" UUID NOT NULL,
    "segment_id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "segment_revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "public_hearing_intelligence_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_hearing_relevance" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "client_name" TEXT,
    "hearing_id" TEXT NOT NULL,
    "insight_id" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "matched_on" JSONB NOT NULL DEFAULT '[]',
    "rationale" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_hearing_relevance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_hearing_relevance_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "hearing_id" TEXT NOT NULL,
    "public_insight_ids" TEXT[],
    "batch_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_hearing_relevance_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "rows_inserted" INTEGER NOT NULL DEFAULT 0,
    "rows_updated" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error_message" TEXT,
    "stats_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "govinfo_cache" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "response_jsonb" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "govinfo_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_procurement_line" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "line_description" TEXT NOT NULL,
    "fy" INTEGER NOT NULL,
    "quantity" DECIMAL(14,2),
    "dollars" DECIMAL(18,2),
    "unit_cost" DECIMAL(18,2),
    "source" TEXT,
    "source_url" TEXT,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_procurement_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_award" (
    "id" UUID NOT NULL,
    "award_unique_id" TEXT NOT NULL,
    "piid" TEXT,
    "fain" TEXT,
    "awarding_agency" TEXT,
    "awarding_sub_tier" TEXT,
    "contractor_name" TEXT,
    "recipient_uei" TEXT,
    "amount" DECIMAL(18,2),
    "description" TEXT,
    "pe_code" VARCHAR(16),
    "pe_code_source" TEXT,
    "funding_tas" TEXT,
    "funding_tas_title" TEXT,
    "program_activity_code" TEXT,
    "program_activity_name" TEXT,
    "funding_fy" INTEGER,
    "pe_code_confidence" DOUBLE PRECISION,
    "pe_code_candidate_count" INTEGER,
    "matched_performer_id" UUID,
    "dod_acq_program_code" TEXT,
    "dod_acq_program_name" TEXT,
    "pop_state" TEXT,
    "pop_congressional_district" TEXT,
    "recipient_state" TEXT,
    "recipient_congressional_district" TEXT,
    "action_date" DATE,
    "awarded_at" TIMESTAMPTZ(6),
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "base_award_signed_date" DATE,
    "latest_action_date" DATE,
    "source_last_modified_date" TIMESTAMPTZ(6),
    "pop_start_date" DATE,
    "pop_end_date" DATE,
    "date_semantics_version" INTEGER,
    "source_record_jsonb" JSONB,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_assistance_award" (
    "id" UUID NOT NULL,
    "award_unique_id" TEXT NOT NULL,
    "fain" TEXT,
    "uri" TEXT,
    "award_type_code" TEXT,
    "award_type_label" TEXT,
    "recipient_name" TEXT,
    "recipient_uei" TEXT,
    "parent_recipient_name" TEXT,
    "parent_recipient_uei" TEXT,
    "assistance_listings" JSONB,
    "assistance_listing_number" TEXT,
    "assistance_listing_title" TEXT,
    "funding_opportunity_number" TEXT,
    "sai_number" TEXT,
    "awarding_agency" TEXT,
    "awarding_sub_tier" TEXT,
    "funding_agency" TEXT,
    "funding_sub_tier" TEXT,
    "total_obligated_amount" DECIMAL(18,2),
    "total_outlayed_amount" DECIMAL(18,2),
    "non_federal_funding_amount" DECIMAL(18,2),
    "description" TEXT,
    "start_date" DATE,
    "end_date" DATE,
    "last_modified_date" TIMESTAMPTZ(6),
    "pop_state" TEXT,
    "pop_congressional_district_raw" TEXT,
    "pop_congressional_district" TEXT,
    "pop_cd_vintage" TEXT,
    "pop_city" TEXT,
    "pop_zip" TEXT,
    "pop_country" TEXT,
    "recipient_state" TEXT,
    "recipient_congressional_district_raw" TEXT,
    "recipient_congressional_district" TEXT,
    "recipient_city" TEXT,
    "recipient_zip" TEXT,
    "subaward_count" INTEGER,
    "detail_enriched_at" TIMESTAMPTZ(6),
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "federal_assistance_award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_grant_nexus" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "assistance_award_id" UUID,
    "grant_opportunity_id" TEXT,
    "facility_id" UUID,
    "relationship_type" TEXT NOT NULL,
    "relationship_description" TEXT,
    "attributable_amount" DECIMAL(18,2),
    "beneficiary_count" INTEGER,
    "evidence_source_type" TEXT NOT NULL,
    "evidence_source_ref" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "verification_status" TEXT NOT NULL DEFAULT 'unverified',
    "external_use_approved" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_user_id" UUID,
    "effective_start" DATE,
    "effective_end" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_grant_nexus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_funding_opportunity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "grant_opportunity_id" TEXT,
    "sam_opportunity_id" UUID,
    "source_record_type" VARCHAR(48),
    "source_record_key" TEXT,
    "workflow_status" VARCHAR(16) NOT NULL DEFAULT 'suggested',
    "owner_user_id" UUID,
    "facility_id" UUID,
    "notes" TEXT,
    "relevance_score" INTEGER,
    "match_signals_jsonb" JSONB NOT NULL DEFAULT '[]',
    "eligibility_state" VARCHAR(16),
    "eligibility_reason" TEXT,
    "evidence_source_type" VARCHAR(48) NOT NULL,
    "user_created" BOOLEAN NOT NULL DEFAULT false,
    "stale_at" TIMESTAMPTZ(6),
    "source_status_snapshot" VARCHAR(64),
    "response_deadline_snapshot" TIMESTAMPTZ(6),
    "source_updated_at_snapshot" TIMESTAMPTZ(6),
    "source_fingerprint" TEXT,
    "source_active_snapshot" BOOLEAN,
    "alert_state_jsonb" JSONB NOT NULL DEFAULT '{}',
    "human_decision" VARCHAR(16),
    "decision_reason" TEXT,
    "decision_at" TIMESTAMPTZ(6),
    "decision_by_user_id" UUID,
    "next_action" TEXT,
    "next_action_due_at" TIMESTAMPTZ(6),
    "dismissed_reason" TEXT,
    "outcome_note" TEXT,
    "pipeline_stage" VARCHAR(16),
    "pipeline_stage_version" INTEGER NOT NULL DEFAULT 0,
    "pipeline_stage_at" TIMESTAMPTZ(6),
    "pipeline_stage_by_user_id" UUID,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_funding_opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_bookmarks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "source" VARCHAR(32) NOT NULL,
    "source_record_type" VARCHAR(64) NOT NULL,
    "source_record_key" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opportunity_bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_resource_snapshot" (
    "id" UUID NOT NULL,
    "resource_type" VARCHAR(32) NOT NULL,
    "external_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "source_updated_at" TIMESTAMPTZ(6),
    "provider_fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "source_url" TEXT,
    "content_sha256" VARCHAR(64) NOT NULL,
    "normalized_jsonb" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tango_resource_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_resource_link" (
    "id" UUID NOT NULL,
    "local_resource_type" VARCHAR(32) NOT NULL,
    "local_resource_id" TEXT NOT NULL,
    "tango_resource_type" VARCHAR(32) NOT NULL,
    "tango_external_id" TEXT NOT NULL,
    "basis" VARCHAR(24) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "confidence_band" VARCHAR(8) NOT NULL,
    "conflict_state" VARCHAR(24) NOT NULL DEFAULT 'none',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_resource_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_sync_checkpoint" (
    "id" UUID NOT NULL,
    "sync_verb" VARCHAR(64) NOT NULL,
    "resource_type" VARCHAR(32) NOT NULL,
    "filter_fingerprint" VARCHAR(64) NOT NULL,
    "cursor" TEXT,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "completeness" VARCHAR(16) NOT NULL DEFAULT 'in_progress',
    "rows_processed" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_sync_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_api_usage" (
    "id" UUID NOT NULL,
    "call_family" VARCHAR(64) NOT NULL,
    "timestamp_bucket" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "row_count" INTEGER,
    "rate_limit_remaining" INTEGER,
    "rate_limit_limit" INTEGER,
    "rate_limit_reset_in" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tango_api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_webhook_delivery" (
    "id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_id" TEXT,
    "payload_sha256" TEXT NOT NULL,
    "payload_bytes" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "provider_event_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "process_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tango_webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_event_outbox" (
    "id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event_index" INTEGER NOT NULL DEFAULT 0,
    "event_type" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "lease_until" TIMESTAMPTZ(6),
    "last_attempted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "tango_event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_event_alert" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_record_key" TEXT NOT NULL,
    "change_dimension" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "change_fingerprint" TEXT NOT NULL,
    "evidence_jsonb" JSONB NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "pipeline_stage_at_alert" TEXT,
    "source_observed_at" TIMESTAMPTZ(6),
    "delivery_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tango_event_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_profile_enrichment_candidate" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'tango',
    "field" VARCHAR(32) NOT NULL,
    "current_value_jsonb" JSONB,
    "proposed_value_jsonb" JSONB NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_profile_enrichment_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_relevant_vehicle" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "tango_vehicle_id" TEXT NOT NULL,
    "vehicle_name" TEXT,
    "vehicle_type" VARCHAR(64),
    "relationship" VARCHAR(16) NOT NULL,
    "recipient_uei" VARCHAR(12) NOT NULL,
    "order_count" INTEGER,
    "idv_obligations" DOUBLE PRECISION,
    "idv_contracts_value" DOUBLE PRECISION,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_relevant_vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_procurement_forecast" (
    "id" UUID NOT NULL,
    "tango_forecast_id" TEXT NOT NULL,
    "external_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "agency" TEXT,
    "department_code" TEXT,
    "department_name" TEXT,
    "organization_agency_code" TEXT,
    "organization_agency_name" TEXT,
    "office_code" TEXT,
    "office_name" TEXT,
    "organization_id" TEXT,
    "anticipated_award_date" DATE,
    "estimated_period" TEXT,
    "fiscal_year" INTEGER,
    "naics_code" TEXT,
    "psc_code" TEXT,
    "set_aside" TEXT,
    "contract_vehicle" TEXT,
    "place_of_performance" TEXT,
    "primary_contact_name" TEXT,
    "primary_contact_email" TEXT,
    "primary_contact_phone" TEXT,
    "primary_contact_title" TEXT,
    "status" TEXT,
    "is_active" BOOLEAN,
    "source_system" TEXT,
    "source_url" TEXT,
    "provider_modified_at" TIMESTAMPTZ(6),
    "snapshot" JSONB NOT NULL,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_procurement_forecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_budget_account" (
    "id" UUID NOT NULL,
    "tango_account_row_id" INTEGER NOT NULL,
    "federal_account_symbol" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "account_title" TEXT NOT NULL,
    "agency_code" TEXT,
    "agency_name" TEXT,
    "bureau_name" TEXT,
    "bea_category" TEXT,
    "on_off_budget" TEXT,
    "subfunction_code" TEXT,
    "requested_ba" DECIMAL(20,2),
    "enacted_ba" DECIMAL(20,2),
    "apportioned" DECIMAL(20,2),
    "obligated_total" DECIMAL(20,2),
    "outlayed_total" DECIMAL(20,2),
    "unobligated_balance" DECIMAL(20,2),
    "contract_obligated" DECIMAL(20,2),
    "assistance_obligated" DECIMAL(20,2),
    "attribution_status" TEXT,
    "attribution_confidence" TEXT,
    "snapshot" JSONB NOT NULL,
    "source_url" TEXT,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_budget_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_budget_vendor_flow" (
    "id" UUID NOT NULL,
    "budget_account_id" UUID NOT NULL,
    "recipient_uei" TEXT NOT NULL,
    "recipient_name" TEXT,
    "funding_organization_id" TEXT,
    "funding_office_code" TEXT,
    "funding_office_name" TEXT,
    "funding_agency_code" TEXT,
    "funding_agency_name" TEXT,
    "contract_obligated" DECIMAL(20,2),
    "contract_outlayed" DECIMAL(20,2),
    "contract_count" INTEGER,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_budget_vendor_flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_procurement_protest" (
    "id" UUID NOT NULL,
    "tango_case_id" TEXT NOT NULL,
    "case_number" TEXT,
    "source_system" TEXT,
    "outcome" TEXT,
    "case_type" TEXT,
    "filed_date" DATE,
    "decision_date" DATE,
    "agency_name" TEXT,
    "protester_name" TEXT,
    "protester_uei" TEXT,
    "docket" JSONB,
    "sam_opportunity_id" UUID,
    "snapshot" JSONB NOT NULL,
    "source_url" TEXT,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_procurement_protest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_entity_exclusion" (
    "id" UUID NOT NULL,
    "uei" TEXT NOT NULL,
    "exclusion_status_flag" TEXT,
    "exclusion_url" TEXT,
    "exclusion_start_date" DATE,
    "exclusion_end_date" DATE,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_entity_exclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_dibbs_solicitation" (
    "id" UUID NOT NULL,
    "tango_dibbs_id" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "solicitation" TEXT NOT NULL,
    "solicitation_formatted" TEXT,
    "purchase_request" TEXT,
    "nsn" TEXT,
    "part_number" TEXT,
    "nomenclature" TEXT,
    "quantity" DECIMAL(18,4),
    "unit_of_issue" TEXT,
    "set_aside" TEXT,
    "status_code" TEXT,
    "buyer_code" TEXT,
    "issued_date" DATE,
    "closes_date" DATE,
    "is_open" BOOLEAN,
    "document_url" TEXT,
    "tech_docs_url" TEXT,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_dibbs_solicitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_dibbs_award" (
    "id" UUID NOT NULL,
    "tango_dibbs_id" TEXT NOT NULL,
    "award_number" TEXT NOT NULL,
    "delivery_order_number" TEXT,
    "delivery_order_counter" INTEGER,
    "solicitation" TEXT,
    "purchase_request" TEXT,
    "nsn" TEXT,
    "part_number" TEXT,
    "nomenclature" TEXT,
    "total_contract_price" DECIMAL(18,2),
    "total_contract_price_text" TEXT,
    "awardee_cage" TEXT,
    "awardee_uei" TEXT,
    "awardee_cage_code" TEXT,
    "awardee_legal_business_name" TEXT,
    "award_date" DATE,
    "posted_date" DATE,
    "last_mod_posting_date" DATE,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_dibbs_award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_sbir_solicitation" (
    "id" UUID NOT NULL,
    "tango_sbir_id" TEXT NOT NULL,
    "solicitation_number" TEXT NOT NULL,
    "title" TEXT,
    "program" TEXT,
    "cycle_name" TEXT,
    "year" INTEGER,
    "start_date" DATE,
    "end_date" DATE,
    "out_of_cycle" BOOLEAN,
    "activity" TEXT,
    "solicitation_status" TEXT,
    "sol_download_url" TEXT,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_sbir_solicitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_sbir_topic" (
    "id" UUID NOT NULL,
    "tango_sbir_id" TEXT NOT NULL,
    "topic_number" TEXT,
    "title" TEXT,
    "agency" TEXT,
    "year" INTEGER,
    "solicitation_number" TEXT,
    "release_date" DATE,
    "open_date" DATE,
    "close_date" DATE,
    "activity" TEXT,
    "solicitation_status" TEXT,
    "topic_url" TEXT,
    "official_solicitation_url" TEXT,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_sbir_topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_opportunity_parity" (
    "id" UUID NOT NULL,
    "tango_opportunity_id" TEXT NOT NULL,
    "sam_opportunity_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "local_value" TEXT,
    "provider_value" TEXT,
    "agreement" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT 'unreviewed',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_notes" TEXT,
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_opportunity_parity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_opportunity_notice" (
    "id" UUID NOT NULL,
    "tango_notice_id" TEXT NOT NULL,
    "tango_opportunity_id" TEXT,
    "sam_opportunity_id" UUID,
    "solicitation_number" TEXT,
    "title" TEXT,
    "description" TEXT,
    "description_sha256" TEXT,
    "posted_date" TIMESTAMPTZ(6),
    "provider_updated_at" TIMESTAMPTZ(6),
    "response_deadline" TIMESTAMPTZ(6),
    "active" BOOLEAN,
    "set_aside" TEXT,
    "naics_code" TEXT,
    "psc_code" TEXT,
    "attachment_count" INTEGER,
    "source_url" TEXT,
    "content_hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tango_opportunity_notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_attachment" (
    "id" UUID NOT NULL,
    "sam_opportunity_id" UUID,
    "tango_notice_id" TEXT,
    "source_url" TEXT NOT NULL,
    "file_name" TEXT,
    "declared_mime_type" TEXT,
    "declared_size_bytes" BIGINT,
    "posted_date" TIMESTAMPTZ(6),
    "observed_mime_type" TEXT,
    "observed_size_bytes" BIGINT,
    "content_sha256" TEXT,
    "archive_bucket" TEXT,
    "archive_key" TEXT,
    "archive_version_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'metadata_only',
    "failure_reason" TEXT,
    "failure_detail" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opportunity_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_document_text" (
    "id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "attachment_content_sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "extraction_method" TEXT,
    "provider_tier" TEXT,
    "text" TEXT,
    "char_count" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "failure_reason" TEXT,
    "fetched_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opportunity_document_text_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_requirement" (
    "id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "attachment_content_sha256" TEXT NOT NULL,
    "sam_opportunity_id" UUID,
    "requirement_type" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "source_excerpt" TEXT NOT NULL,
    "excerpt_start" INTEGER NOT NULL,
    "excerpt_end" INTEGER NOT NULL,
    "source_page" INTEGER,
    "extraction_method" TEXT NOT NULL,
    "extraction_model" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opportunity_requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_requirement_review" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opportunity_requirement_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_opportunity_stage_transition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_funding_opportunity_id" UUID NOT NULL,
    "from_stage" VARCHAR(16),
    "to_stage" VARCHAR(16) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funding_opportunity_stage_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_acquisition_program" (
    "id" UUID NOT NULL,
    "acq_program_code" TEXT NOT NULL,
    "acq_program_name" TEXT,
    "pe_code" VARCHAR(16) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'seed_curated_v1',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_acquisition_program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_performer" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "performer" TEXT NOT NULL,
    "performer_normalized" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "contract_method" TEXT NOT NULL DEFAULT '',
    "cost_category" TEXT NOT NULL DEFAULT '',
    "total_cost_m" DECIMAL(18,3),
    "table_type" TEXT,
    "project_code" TEXT,
    "project_name" TEXT,
    "fy" INTEGER NOT NULL,
    "source_url" TEXT NOT NULL,
    "page_number" INTEGER NOT NULL,
    "publisher" TEXT,
    "is_named_company" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'comptroller_jbook_r3',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.95,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_document_id" UUID,

    CONSTRAINT "program_element_performer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program" (
    "id" UUID NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "component" TEXT,
    "capability_area" TEXT,
    "acquisition_pathway" TEXT,
    "mdap_code" TEXT,
    "description" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_alias" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "alias_normalized" TEXT NOT NULL,
    "alias_type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_url" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "program_alias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_identity_crosswalk" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "identity_kind" VARCHAR(32) NOT NULL,
    "source_system" VARCHAR(64) NOT NULL,
    "source_identifier" VARCHAR(256) NOT NULL,
    "relationship_kind" VARCHAR(24) NOT NULL,
    "valid_from_fy" INTEGER,
    "valid_to_fy" INTEGER,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_id" UUID,
    "source" VARCHAR(128) NOT NULL,
    "source_url" TEXT,
    "source_document_id" UUID,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_identity_crosswalk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_record_revision" (
    "id" UUID NOT NULL,
    "identity_key" TEXT NOT NULL,
    "source_system" VARCHAR(64) NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "record_kind" VARCHAR(24) NOT NULL,
    "parent_identity_key" TEXT,
    "title" TEXT,
    "status" VARCHAR(64),
    "buyer_office" TEXT,
    "posted_at" TIMESTAMPTZ(6),
    "response_deadline" TIMESTAMPTZ(6),
    "valid_from" DATE,
    "valid_to" DATE,
    "content_hash" CHAR(64) NOT NULL,
    "source_url" TEXT,
    "source_version" VARCHAR(128),
    "source_observed_at" TIMESTAMPTZ(6),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "acquisition_record_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_award_transaction_revision" (
    "id" UUID NOT NULL,
    "transaction_identity_key" TEXT NOT NULL,
    "award_identity_key" TEXT NOT NULL,
    "parent_award_identity_key" TEXT,
    "source_system" VARCHAR(64) NOT NULL,
    "source_transaction_id" TEXT NOT NULL,
    "piid" TEXT,
    "modification_number" TEXT,
    "action_date" DATE,
    "signed_obligation_delta" DECIMAL(20,2),
    "signed_outlay_delta" DECIMAL(20,2),
    "corrects_identity_key" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "content_hash" CHAR(64) NOT NULL,
    "supersedes_id" UUID,
    "source_url" TEXT,
    "source_observed_at" TIMESTAMPTZ(6),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "acquisition_award_transaction_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_acquisition_relationship" (
    "id" UUID NOT NULL,
    "logical_key" CHAR(64) NOT NULL,
    "subject_kind" VARCHAR(32) NOT NULL,
    "subject_key" TEXT NOT NULL,
    "acquisition_identity_key" TEXT NOT NULL,
    "relationship_class" VARCHAR(48) NOT NULL,
    "valid_from_fy" INTEGER,
    "valid_to_fy" INTEGER,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_id" UUID,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "source_system" VARCHAR(64) NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "source_url" TEXT,
    "source_version" VARCHAR(128),
    "source_observed_at" TIMESTAMPTZ(6),
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "allocated_amount_usd" DECIMAL(20,2),
    "unresolved_reason" TEXT,
    "coverage_state" VARCHAR(16) NOT NULL DEFAULT 'unknown',
    "content_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_acquisition_relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_coverage_gap" (
    "id" UUID NOT NULL,
    "subject_kind" VARCHAR(32) NOT NULL,
    "subject_key" TEXT NOT NULL,
    "source_system" VARCHAR(64) NOT NULL,
    "relationship_kind" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "detail" TEXT,
    "coverage_state" VARCHAR(16) NOT NULL,
    "source_as_of" TIMESTAMPTZ(6),
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "acquisition_coverage_gap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pe_program_match" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "project_code" VARCHAR(32),
    "program_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "evidence_tier" TEXT NOT NULL,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "weak_signal" BOOLEAN NOT NULL DEFAULT false,
    "match_basis" TEXT,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "decision_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pe_program_match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sam_opportunity" (
    "id" UUID NOT NULL,
    "notice_id" TEXT NOT NULL,
    "solicitation_number" TEXT,
    "title" TEXT NOT NULL,
    "notice_type" VARCHAR(32) NOT NULL,
    "base_type" VARCHAR(64),
    "agency" TEXT,
    "sub_agency" TEXT,
    "office" TEXT,
    "set_aside" TEXT,
    "set_aside_code" VARCHAR(16),
    "psc_code" VARCHAR(8),
    "naics_code" VARCHAR(8),
    "posted_date" TIMESTAMPTZ(6),
    "response_deadline" TIMESTAMPTZ(6),
    "archive_date" TIMESTAMPTZ(6),
    "description" TEXT,
    "poc_name" TEXT,
    "poc_email" TEXT,
    "place_of_performance_jsonb" JSONB NOT NULL DEFAULT '{}',
    "source_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sam_opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sam_opportunity_match" (
    "id" UUID NOT NULL,
    "opportunity_id" UUID NOT NULL,
    "program_id" UUID,
    "pe_code" VARCHAR(16),
    "match_basis" VARCHAR(24) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sam_opportunity_match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committee_report_provision" (
    "id" UUID NOT NULL,
    "source_document_id" UUID,
    "committee" VARCHAR(16) NOT NULL,
    "fy" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "page_start" INTEGER,
    "page_end" INTEGER,
    "action_type" VARCHAR(24),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "committee_report_provision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provision_pe_link" (
    "id" UUID NOT NULL,
    "provision_id" UUID NOT NULL,
    "pe_code" VARCHAR(16),
    "project_code" VARCHAR(32),
    "program_id" UUID,
    "match_basis" VARCHAR(24) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provision_pe_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_office" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "office_type" VARCHAR(24) NOT NULL,
    "service" VARCHAR(8),
    "parent_office_id" UUID,
    "source_url" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "program_office_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_role" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "office_id" UUID,
    "program_id" UUID,
    "role_title" TEXT NOT NULL,
    "role_type" VARCHAR(24) NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "source_url" TEXT,
    "source_quote" TEXT,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "effective_start" TIMESTAMPTZ(6),
    "effective_end" TIMESTAMPTZ(6),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "contact_use" VARCHAR(40) NOT NULL,
    "stale_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "person_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_office_program_link" (
    "id" UUID NOT NULL,
    "office_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "relation" VARCHAR(16) NOT NULL,
    "source_url" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "evidence_jsonb" JSONB NOT NULL DEFAULT '[]',
    "evidence_tier" TEXT,
    "match_basis" TEXT,
    "derived_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "program_office_program_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "owner_user_id" UUID,
    "type" VARCHAR(32) NOT NULL,
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'tenant',
    "entity_id" UUID,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" VARCHAR(24) NOT NULL,
    "source_ref" TEXT,
    "provenance" VARCHAR(32) NOT NULL DEFAULT 'human',
    "sections_jsonb" JSONB NOT NULL DEFAULT '[]',
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "last_confirmed_at" TIMESTAMPTZ(6),
    "review_cadence_days" INTEGER,
    "supersedes_id" UUID,
    "contradicts_id" UUID,
    "sensitivity" VARCHAR(16) NOT NULL DEFAULT 'normal',
    "retention_policy_jsonb" JSONB,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "exportable" BOOLEAN NOT NULL DEFAULT true,
    "training_use" VARCHAR(16) NOT NULL DEFAULT 'excluded',
    "confidence" DOUBLE PRECISION,
    "ingest_run_id" UUID,
    "ingested_at" TIMESTAMPTZ(6),
    "review_state" VARCHAR(16) NOT NULL DEFAULT 'auto',
    "expires_at" TIMESTAMPTZ(6),
    "memory_class" VARCHAR(40) NOT NULL DEFAULT 'legacy_unclassified',
    "memory_authority" VARCHAR(40) NOT NULL DEFAULT 'legacy_unclassified',
    "memory_scope" VARCHAR(24) NOT NULL DEFAULT 'firm',
    "governed_status" VARCHAR(24) NOT NULL DEFAULT 'pending_review',
    "source_type" VARCHAR(40) NOT NULL DEFAULT 'unknown',
    "source_id" TEXT,
    "source_excerpt" TEXT,
    "source_content_hash" VARCHAR(96),
    "source_version" VARCHAR(160),
    "asserted_by_user_id" UUID,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "second_approved_by_user_id" UUID,
    "second_approved_at" TIMESTAMPTZ(6),
    "as_of" TIMESTAMPTZ(6),
    "effective_from" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6),
    "review_due_at" TIMESTAMPTZ(6),
    "conflict_status" VARCHAR(24) NOT NULL DEFAULT 'none',
    "conflict_group_id" UUID,
    "controlling_item_id" UUID,
    "origin_surface" VARCHAR(48),
    "origin_trace_id" VARCHAR(160),
    "origin_context_packet_id" UUID,
    "origin_model" VARCHAR(160),
    "origin_prompt_version" VARCHAR(80),
    "instructions_allowed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "memory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_edges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "src_item_id" UUID NOT NULL,
    "relation" VARCHAR(32) NOT NULL DEFAULT 'mentions',
    "dst_type" VARCHAR(32) NOT NULL,
    "dst_slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_candidate" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "proposed_by" UUID NOT NULL,
    "source_kind" VARCHAR(24) NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "client_id" UUID,
    "payload_jsonb" JSONB NOT NULL,
    "provenance_jsonb" JSONB NOT NULL,
    "revision_root_id" UUID,
    "predecessor_candidate_id" UUID,
    "revision_number" INTEGER NOT NULL DEFAULT 1,
    "superseded_by_id" UUID,
    "duplicate_of_id" UUID,
    "contradicts_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "confidence" DOUBLE PRECISION,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "committed_memory_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memory_class" VARCHAR(40) NOT NULL DEFAULT 'legacy_unclassified',
    "memory_authority" VARCHAR(40) NOT NULL DEFAULT 'legacy_unclassified',
    "memory_scope" VARCHAR(24) NOT NULL DEFAULT 'firm',
    "governed_status" VARCHAR(24) NOT NULL DEFAULT 'suggested',
    "source_type" VARCHAR(40) NOT NULL DEFAULT 'unknown',
    "source_id" TEXT,
    "source_ref" TEXT,
    "source_excerpt" TEXT,
    "source_content_hash" VARCHAR(96),
    "source_version" VARCHAR(160),
    "asserted_by_user_id" UUID,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "second_approved_by_user_id" UUID,
    "second_approved_at" TIMESTAMPTZ(6),
    "as_of" TIMESTAMPTZ(6),
    "effective_from" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "review_cadence_days" INTEGER,
    "review_due_at" TIMESTAMPTZ(6),
    "conflict_status" VARCHAR(24) NOT NULL DEFAULT 'none',
    "conflict_group_id" UUID,
    "controlling_item_id" UUID,
    "sensitivity" VARCHAR(24) NOT NULL DEFAULT 'normal',
    "retention_policy_jsonb" JSONB,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "origin_surface" VARCHAR(48),
    "origin_trace_id" VARCHAR(160),
    "origin_context_packet_id" UUID,
    "origin_model" VARCHAR(160),
    "origin_prompt_version" VARCHAR(80),
    "instructions_allowed" BOOLEAN NOT NULL DEFAULT false,
    "duplicate_memory_item_id" UUID,
    "contradicts_memory_item_id" UUID,
    "committed_memory_item_id" UUID,

    CONSTRAINT "memory_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_ingest_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trigger" VARCHAR(24) NOT NULL,
    "actor_user_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "status" VARCHAR(16) NOT NULL DEFAULT 'running',
    "counts_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "memory_ingest_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_access_grant" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "user_id" UUID NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "granted_by_user_id" UUID,
    "reason" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_access_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_transition_audit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "memory_item_id" UUID,
    "memory_candidate_id" UUID,
    "actor_user_id" UUID,
    "effective_tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "from_status" VARCHAR(24),
    "to_status" VARCHAR(24) NOT NULL,
    "reason_code" VARCHAR(48) NOT NULL,
    "reason" TEXT NOT NULL,
    "source_type" VARCHAR(40),
    "source_id" TEXT,
    "proposal_id" UUID,
    "impersonation_session_id" UUID,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_transition_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_cleanup_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "memory_item_id" UUID,
    "clio_memory_id" UUID,
    "operation" VARCHAR(32) NOT NULL,
    "idempotency_key" VARCHAR(192) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "memory_cleanup_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_signal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "client_id" UUID,
    "source_surface" VARCHAR(32) NOT NULL,
    "source_object_type" VARCHAR(64) NOT NULL,
    "source_object_id" UUID NOT NULL,
    "source_run_id" UUID,
    "signal_type" VARCHAR(48) NOT NULL,
    "proposed_memory_layer" VARCHAR(24),
    "proposed_memory_class" VARCHAR(32),
    "evidence_jsonb" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION,
    "source_authority" VARCHAR(24),
    "sensitivity" VARCHAR(16) NOT NULL DEFAULT 'normal',
    "provenance_kind" VARCHAR(24) NOT NULL,
    "provenance_jsonb" JSONB NOT NULL DEFAULT '{}',
    "governance_requirement" VARCHAR(16) NOT NULL DEFAULT 'human_required',
    "status" VARCHAR(16) NOT NULL DEFAULT 'captured',
    "idempotency_key" VARCHAR(320) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_signal_candidate_outcome" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "learning_signal_id" UUID NOT NULL,
    "eligibility" VARCHAR(24) NOT NULL,
    "reason" VARCHAR(240) NOT NULL,
    "memory_candidate_id" UUID,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_signal_candidate_outcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_telemetry_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "client_id" UUID,
    "surface" VARCHAR(24) NOT NULL,
    "operation" VARCHAR(96) NOT NULL,
    "event_type" VARCHAR(24) NOT NULL,
    "artifact_type" VARCHAR(40),
    "artifact_id" VARCHAR(64),
    "artifact_version_seq" INTEGER,
    "context_packet_id" UUID,
    "context_layer_counts_jsonb" JSONB,
    "learning_signal_id" UUID,
    "memory_candidate_id" UUID,
    "edit_metrics_jsonb" JSONB,
    "provenance_jsonb" JSONB NOT NULL DEFAULT '{}',
    "trace_id" VARCHAR(160),
    "generated_at" TIMESTAMPTZ(6),
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" VARCHAR(320) NOT NULL,

    CONSTRAINT "quality_telemetry_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_telemetry_memory_item_use" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "telemetry_event_id" UUID NOT NULL,
    "memory_item_id" UUID,
    "context_layer" VARCHAR(24) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_telemetry_memory_item_use_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_record" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "surface" VARCHAR(24) NOT NULL,
    "operation" VARCHAR(96) NOT NULL,
    "evaluation_type" VARCHAR(40) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "skip_reason" VARCHAR(40),
    "failure_reason" VARCHAR(160),
    "context_packet_id" UUID,
    "quality_telemetry_event_id" UUID,
    "treatment_artifact_type" VARCHAR(40),
    "treatment_artifact_id" VARCHAR(64) NOT NULL,
    "treatment_artifact_version_seq" INTEGER,
    "treatment_output_hash" VARCHAR(128),
    "control_output_hash" VARCHAR(128),
    "control_projection_policy" VARCHAR(64),
    "metrics_jsonb" JSONB,
    "judge_jsonb" JSONB,
    "cost_jsonb" JSONB,
    "sampling_key" VARCHAR(320) NOT NULL,
    "config_version" VARCHAR(32) NOT NULL,
    "trace_id" VARCHAR(160),
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "idempotency_key" VARCHAR(400) NOT NULL,

    CONSTRAINT "evaluation_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'unknown',
    "freshness_at" TIMESTAMPTZ(6),
    "user_edited" BOOLEAN NOT NULL DEFAULT false,
    "original_statement" TEXT,
    "artifact_id" UUID,
    "transcript_segment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "url" TEXT,
    "quote" TEXT,
    "page_number" INTEGER,
    "accessed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_check" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rule_source" TEXT,
    "policy_pack_key" VARCHAR(120),
    "policy_pack_version" VARCHAR(80),
    "policy_binding" VARCHAR(280),
    "policy_decision_hash" VARCHAR(64),
    "required_approval" BOOLEAN NOT NULL DEFAULT false,
    "actor_user_id" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_action" (
    "id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "fy" INTEGER NOT NULL,
    "stage" VARCHAR(12) NOT NULL,
    "action" VARCHAR(16) NOT NULL,
    "amount" DECIMAL(14,2),
    "baseline" VARCHAR(12) NOT NULL,
    "note" TEXT,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "bill_id" TEXT,
    "derived_by" VARCHAR(48) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_line_relationship" (
    "id" UUID NOT NULL,
    "from_pe_code" VARCHAR(16) NOT NULL,
    "to_pe_code" VARCHAR(16) NOT NULL,
    "rel_type" VARCHAR(40) NOT NULL,
    "confidence" VARCHAR(8) NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'accepted',
    "evidence" TEXT NOT NULL,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "transition_fy_from" INTEGER,
    "transition_fy_to" INTEGER,
    "derived_by" VARCHAR(48) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_line_relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(32) NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "taxonomy_path" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "capability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_budget_line_match" (
    "id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "confidence" VARCHAR(8) NOT NULL,
    "matched_on" TEXT NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'accepted',
    "derived_by" VARCHAR(48) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "capability_budget_line_match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_element_intelligence_cache" (
    "pe_code" VARCHAR(16) NOT NULL,
    "line_type" VARCHAR(20),
    "maturity" INTEGER,
    "maturity_jsonb" JSONB NOT NULL DEFAULT '{}',
    "approp_tier" VARCHAR(8),
    "approp_score" INTEGER,
    "approp_jsonb" JSONB NOT NULL DEFAULT '{}',
    "signal_type" VARCHAR(16),
    "signal_tone" VARCHAR(12),
    "signal_fy" INTEGER,
    "valley_of_death" BOOLEAN NOT NULL DEFAULT false,
    "posture_jsonb" JSONB NOT NULL DEFAULT '{}',
    "anomalies_jsonb" JSONB NOT NULL DEFAULT '[]',
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_element_intelligence_cache_pkey" PRIMARY KEY ("pe_code")
);

-- CreateTable
CREATE TABLE "bill_budget_line_link" (
    "id" UUID NOT NULL,
    "bill_id" TEXT NOT NULL,
    "pe_code" VARCHAR(16) NOT NULL,
    "link_type" VARCHAR(24) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "evidence" TEXT NOT NULL,
    "evidence_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(12) NOT NULL DEFAULT 'accepted',
    "derived_by" VARCHAR(48) NOT NULL,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bill_budget_line_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_package" (
    "id" UUID NOT NULL,
    "domain" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_package_vehicle" (
    "id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "track" VARCHAR(24) NOT NULL,
    "stage" VARCHAR(16) NOT NULL,
    "bill_id" TEXT,
    "report_number" TEXT,
    "public_law" TEXT,
    "chamber" VARCHAR(16),
    "label" TEXT NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'introduced',
    "status_at" TIMESTAMPTZ(6),
    "source_document_id" UUID,
    "source_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_package_vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "funding_position" (
    "id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "bill_id" TEXT,
    "fiscal_year" INTEGER NOT NULL,
    "vehicle_class" VARCHAR(24) NOT NULL,
    "stage" VARCHAR(16) NOT NULL,
    "scope" VARCHAR(40) NOT NULL,
    "amount_millions" DECIMAL(14,2) NOT NULL,
    "effective_date" TIMESTAMPTZ(6),
    "source_document_id" UUID,
    "source_url" TEXT,
    "source_page" INTEGER,
    "note" TEXT,
    "verification_status" VARCHAR(16) NOT NULL DEFAULT 'extracted',
    "verified_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "funding_position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_interim_funding_period" (
    "id" UUID NOT NULL,
    "domain" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "start_date" TIMESTAMPTZ(6),
    "coverage_through" TIMESTAMPTZ(6),
    "vehicle_label" TEXT NOT NULL,
    "bill_id" TEXT,
    "public_law" TEXT,
    "shutdown_days" INTEGER,
    "notes" TEXT,
    "source_document_id" UUID,
    "source_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "budget_interim_funding_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_policy_pack" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pack_key" VARCHAR(120) NOT NULL,
    "version" VARCHAR(80) NOT NULL,
    "jurisdiction" VARCHAR(32) NOT NULL DEFAULT 'all',
    "status" VARCHAR(24) NOT NULL DEFAULT 'draft',
    "legal_review_status" VARCHAR(40) NOT NULL DEFAULT 'pending',
    "authority_jsonb" JSONB NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_until" TIMESTAMPTZ(6),
    "owner_user_id" UUID NOT NULL,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "second_approved_by_user_id" UUID,
    "second_approved_at" TIMESTAMPTZ(6),
    "published_by_user_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "four_eyes_required" BOOLEAN NOT NULL DEFAULT true,
    "rules_jsonb" JSONB NOT NULL DEFAULT '[]',
    "fallback_outcome" VARCHAR(8) NOT NULL DEFAULT 'WARN',
    "non_production" BOOLEAN NOT NULL DEFAULT true,
    "rules_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_policy_pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_policy_pack_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "policy_pack_id" UUID NOT NULL,
    "from_status" VARCHAR(24),
    "to_status" VARCHAR(24),
    "action" VARCHAR(24) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "actor_role" VARCHAR(32) NOT NULL,
    "rolled_back_from_pack_id" UUID,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_policy_pack_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_policy_decision" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "policy_pack_id" UUID,
    "pack_key" VARCHAR(120),
    "pack_version" VARCHAR(80),
    "rule_id" VARCHAR(120),
    "outcome" VARCHAR(8) NOT NULL,
    "code" VARCHAR(48),
    "tier" VARCHAR(16),
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "binding" VARCHAR(280) NOT NULL,
    "decision_hash" VARCHAR(64) NOT NULL,
    "context_hash" VARCHAR(64) NOT NULL,
    "policy_source" VARCHAR(24) NOT NULL,
    "policy_mode" VARCHAR(16) NOT NULL,
    "effective_user_id" UUID NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "tool" VARCHAR(80) NOT NULL,
    "channel" VARCHAR(24) NOT NULL,
    "recipient_type" VARCHAR(24),
    "actor_user_id" UUID NOT NULL,
    "actor_role" VARCHAR(32) NOT NULL,
    "client_id" UUID,
    "jurisdiction" VARCHAR(32) NOT NULL,
    "meri_action_proposal_id" UUID,
    "reason" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_policy_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assurance_eval_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "git_sha" VARCHAR(80),
    "prompt_version" VARCHAR(120),
    "context_compiler_version" VARCHAR(120),
    "tool_manifest_hash" VARCHAR(128),
    "model" VARCHAR(160),
    "provider" VARCHAR(40),
    "dataset_version" VARCHAR(120),
    "run_date" TIMESTAMPTZ(6) NOT NULL,
    "provenance_hash" VARCHAR(64) NOT NULL,
    "thresholds_jsonb" JSONB NOT NULL,
    "baseline_jsonb" JSONB,
    "candidate_jsonb" JSONB,
    "allowed" BOOLEAN NOT NULL,
    "blockers_jsonb" JSONB NOT NULL DEFAULT '[]',
    "warnings_jsonb" JSONB NOT NULL DEFAULT '[]',
    "cost_latency_signoff_by_user_id" UUID,
    "cost_latency_signoff_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assurance_eval_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assurance_eval_result" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "eval_run_id" UUID NOT NULL,
    "case_id" VARCHAR(160) NOT NULL,
    "tier" VARCHAR(4),
    "domain" VARCHAR(32) NOT NULL,
    "severity" VARCHAR(12) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "score" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "metric" VARCHAR(48),
    "detail" TEXT NOT NULL,

    CONSTRAINT "assurance_eval_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assurance_eval_domain_gate" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "eval_run_id" UUID NOT NULL,
    "domain" VARCHAR(32) NOT NULL,
    "passed" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "critical_failed" INTEGER NOT NULL,
    "high_failed" INTEGER NOT NULL,
    "minimum_score" DOUBLE PRECISION,
    "blocked" BOOLEAN NOT NULL,
    "blocker_reasons_jsonb" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "assurance_eval_domain_gate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assurance_feedback_candidate" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending_review',
    "reason_codes" TEXT[],
    "surface" VARCHAR(64) NOT NULL,
    "source_message_id" UUID,
    "trace_id" VARCHAR(160),
    "context_packet_id" UUID,
    "claim_ledger_hash" VARCHAR(128),
    "summary" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anonymized" BOOLEAN NOT NULL DEFAULT false,
    "anonymization_version" VARCHAR(80),
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_reason" TEXT,
    "fixture_id" VARCHAR(64),

    CONSTRAINT "assurance_feedback_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assurance_eval_fixture" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fixture_key" VARCHAR(64) NOT NULL,
    "source_candidate_id" UUID NOT NULL,
    "dataset_version" VARCHAR(120) NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "surface" VARCHAR(64) NOT NULL,
    "trace_ref" VARCHAR(160),
    "context_packet_ref" VARCHAR(160),
    "claim_ledger_hash" VARCHAR(128),
    "anonymization_version" VARCHAR(80) NOT NULL,
    "accepted_by_user_id" UUID NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "assurance_eval_fixture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_extraction_candidate_v1" (
    "id" UUID NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "manifest_document_key" TEXT NOT NULL,
    "extraction_artifact_id" TEXT NOT NULL,
    "extraction_artifact_sha256" CHAR(64) NOT NULL,
    "extraction_artifact_locator" TEXT,
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "verifier_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "policy_sha256" CHAR(64) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'EXTRACTED',
    "current_run_id" UUID,
    "family" TEXT,
    "extraction_method" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_extraction_candidate_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_verification_run_v1" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "verifier_version" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "policy_sha256" CHAR(64) NOT NULL,
    "decision" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "extraction_artifact_sha256" CHAR(64) NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "result_snapshot_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_verification_run_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_verification_check_v1" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "check_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rule_version" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "risk_points" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "assertion_ids_jsonb" JSONB NOT NULL,
    "evidence_ids_jsonb" JSONB NOT NULL,
    "reference_artifact_ids_jsonb" JSONB NOT NULL,
    "details_jsonb" JSONB,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_verification_check_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_verification_proof" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "proof_kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "source_document_id" UUID,
    "artifact_id" TEXT,
    "reference_artifact_id" TEXT,
    "evidence_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_verification_proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_verification_discrepancy_v1" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "discrepancy_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assertion_ids_jsonb" JSONB NOT NULL,
    "evidence_ids_jsonb" JSONB NOT NULL,
    "reference_artifact_ids_jsonb" JSONB NOT NULL,
    "details_jsonb" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_verification_discrepancy_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_review_decision_v1" (
    "id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "extraction_artifact_sha256" CHAR(64) NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "evidence_jsonb" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_review_decision_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_scoped_fact_review_v1" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "candidate_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "extraction_artifact_id" TEXT NOT NULL,
    "extraction_artifact_sha256" CHAR(64) NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "policy_id" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "policy_sha256" CHAR(64) NOT NULL,
    "scope_kind" VARCHAR(64) NOT NULL,
    "scope_key" TEXT NOT NULL,
    "scope_jsonb" JSONB NOT NULL,
    "assertion_ids_jsonb" JSONB NOT NULL,
    "evidence_ids_jsonb" JSONB NOT NULL,
    "projection_jsonb" JSONB NOT NULL,
    "independence_jsonb" JSONB NOT NULL,
    "limitations_jsonb" JSONB NOT NULL,
    "decision" VARCHAR(16) NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "decision_hash" CHAR(64) NOT NULL,
    "review_generation" BIGSERIAL NOT NULL,
    "eligibility_state_version" TEXT,
    "eligibility_state_sha256" CHAR(64),
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "revocation_reason" TEXT,
    "superseded_by_id" UUID,
    "acknowledged_revoked_review_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_scoped_fact_review_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_candidate_correction_v1" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "old_candidate_id" UUID NOT NULL,
    "new_candidate_id" UUID NOT NULL,
    "old_candidate_status_at_correction" TEXT NOT NULL,
    "old_candidate_source_document_id" UUID NOT NULL,
    "old_candidate_source_sha256" CHAR(64) NOT NULL,
    "new_candidate_source_document_id" UUID NOT NULL,
    "new_candidate_source_sha256" CHAR(64) NOT NULL,
    "reviewed_intent_version" INTEGER,
    "reviewed_intent_jsonb" JSONB,
    "reviewed_intent_sha256" CHAR(64),
    "superseded_scoped_fact_review_ids_jsonb" JSONB NOT NULL DEFAULT '[]',
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_candidate_correction_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_canonical_snapshot" (
    "id" UUID NOT NULL,
    "snapshot_key" TEXT NOT NULL,
    "domain" VARCHAR(64) NOT NULL DEFAULT 'defense_budget',
    "environment" VARCHAR(32) NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'STAGING',
    "required_scopes" JSONB NOT NULL DEFAULT '[]',
    "completed_scopes" JSONB NOT NULL DEFAULT '[]',
    "snapshot_hash" CHAR(64),
    "mapping_registry_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),

    CONSTRAINT "defense_budget_canonical_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_active_snapshot" (
    "id" UUID NOT NULL,
    "domain" VARCHAR(64) NOT NULL DEFAULT 'defense_budget',
    "environment" VARCHAR(32) NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_active_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_promotion_plan" (
    "id" UUID NOT NULL,
    "plan_id" TEXT NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "eligibility_hash" CHAR(64) NOT NULL,
    "mapping_registry_version" TEXT NOT NULL,
    "mapping_registry_hash" CHAR(64) NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "scope" JSONB NOT NULL,
    "scope_hash" CHAR(64) NOT NULL,
    "mode" VARCHAR(32) NOT NULL,
    "expected_active_snapshot_id" UUID,
    "proposed_snapshot_id" UUID NOT NULL,
    "item_count" INTEGER NOT NULL,
    "blocked_count" INTEGER NOT NULL,
    "plan_document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_promotion_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_projection_plan" (
    "id" UUID NOT NULL,
    "projection_plan_id" TEXT NOT NULL,
    "record_schema_version" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "producer_version" TEXT NOT NULL,
    "certification_id" TEXT,
    "certification_sha256" CHAR(64) NOT NULL,
    "artifact_set_sha256" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "conflict_count" INTEGER NOT NULL,
    "unsupported_count" INTEGER NOT NULL,
    "plan_document" JSONB,
    "plan_locator" TEXT,
    "plan_byte_sha256" CHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_projection_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_promotion_eligibility" (
    "id" UUID NOT NULL,
    "eligibility_id" TEXT NOT NULL,
    "eligibility_hash" CHAR(64) NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "mapping_registry_version" TEXT NOT NULL,
    "mapping_registry_hash" CHAR(64) NOT NULL,
    "scope" JSONB NOT NULL,
    "scope_hash" CHAR(64) NOT NULL,
    "open_conflict_count" INTEGER NOT NULL,
    "unsupported_item_count" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_promotion_eligibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_manual_override" (
    "override_id" UUID NOT NULL,
    "canonical_entity" TEXT NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "fiscal_year" INTEGER,
    "funding_field" VARCHAR(32),
    "money_original_value" TEXT NOT NULL,
    "money_original_unit" TEXT NOT NULL,
    "money_value_millions" DECIMAL(24,9) NOT NULL,
    "author_actor_id" TEXT NOT NULL,
    "approver_actor_id" TEXT,
    "approver_role" TEXT,
    "reason" TEXT NOT NULL,
    "evidence_ids" JSONB NOT NULL,
    "change_request_ref" TEXT,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "prior_override_id" UUID,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "proposed_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "override_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_manual_override_pkey" PRIMARY KEY ("override_id")
);

-- CreateTable
CREATE TABLE "defense_budget_promotion_authorization" (
    "id" UUID NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "eligibility_hash" CHAR(64) NOT NULL,
    "scope_hash" CHAR(64) NOT NULL,
    "expected_active_snapshot_id" UUID,
    "authorizer_actor_id" TEXT NOT NULL,
    "authorizer_role" VARCHAR(32) NOT NULL,
    "reason" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "segregation" JSONB NOT NULL,
    "change_request_reference" TEXT,
    "authorization_hash" CHAR(64) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "consumed_by_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_promotion_authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_promotion_run" (
    "id" UUID NOT NULL,
    "run_key" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "expected_active_snapshot_id" UUID,
    "executor_identity" TEXT NOT NULL,
    "execution_mode" VARCHAR(32) NOT NULL DEFAULT 'execute',
    "status" VARCHAR(48) NOT NULL DEFAULT 'STAGING',
    "staged_row_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,

    CONSTRAINT "defense_budget_promotion_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_promotion_item" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "canonical_entity" VARCHAR(80) NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "operation" VARCHAR(16) NOT NULL,
    "prior_row_hash" CHAR(64),
    "proposed_row_hash" CHAR(64),
    "source_projection_id" TEXT NOT NULL,
    "source_projection_hash" CHAR(64) NOT NULL,
    "alert_disposition" VARCHAR(40) NOT NULL,
    "block_reason" VARCHAR(64),
    "staged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_promotion_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_promotion_activation" (
    "id" UUID NOT NULL,
    "activation_key" TEXT NOT NULL,
    "run_id" UUID NOT NULL,
    "domain" VARCHAR(64) NOT NULL DEFAULT 'defense_budget',
    "environment" VARCHAR(32) NOT NULL,
    "previous_snapshot_id" UUID,
    "new_snapshot_id" UUID NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "activation_kind" VARCHAR(24) NOT NULL DEFAULT 'PROMOTION',
    "activated_by" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_promotion_activation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_rollback_record" (
    "id" UUID NOT NULL,
    "rollback_key" TEXT NOT NULL,
    "from_snapshot_id" UUID NOT NULL,
    "to_snapshot_id" UUID NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "activation_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_rollback_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_promotion_outbox" (
    "id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "old_snapshot_id" UUID,
    "new_snapshot_id" UUID NOT NULL,
    "canonical_entity" VARCHAR(80) NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "family" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER,
    "funding_field" VARCHAR(32),
    "stage" VARCHAR(40),
    "old_original_value" TEXT,
    "old_value_millions" DECIMAL(24,9),
    "new_original_value" TEXT,
    "new_value_millions" DECIMAL(24,9),
    "change_classification" VARCHAR(40) NOT NULL,
    "suppress_alert" BOOLEAN NOT NULL,
    "is_correction" BOOLEAN NOT NULL DEFAULT false,
    "is_rollback" BOOLEAN NOT NULL DEFAULT false,
    "source_lineage" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "last_attempted_at" TIMESTAMPTZ(6),

    CONSTRAINT "defense_budget_promotion_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_side_effect_drain_pause" (
    "id" UUID NOT NULL,
    "domain" VARCHAR(40) NOT NULL DEFAULT 'defense_budget',
    "environment" VARCHAR(24) NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "paused_by" TEXT NOT NULL,
    "paused_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumed_by" TEXT,
    "resumed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_side_effect_drain_pause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_canonical_delta" (
    "id" UUID NOT NULL,
    "delta_key" TEXT NOT NULL,
    "activation_id" UUID NOT NULL,
    "outbox_id" UUID NOT NULL,
    "old_snapshot_id" UUID,
    "new_snapshot_id" UUID NOT NULL,
    "canonical_entity" VARCHAR(80) NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "family" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER,
    "funding_field" VARCHAR(32),
    "stage" VARCHAR(40),
    "delta_kind" VARCHAR(32) NOT NULL,
    "changed_axes" JSONB NOT NULL,
    "old_money_original_value" TEXT,
    "old_money_value_millions" DECIMAL(24,9),
    "new_money_original_value" TEXT,
    "new_money_value_millions" DECIMAL(24,9),
    "money_delta_millions" DECIMAL(24,9),
    "old_quantity" DECIMAL(24,9),
    "new_quantity" DECIMAL(24,9),
    "old_unit_cost_dollars" DECIMAL(24,9),
    "new_unit_cost_dollars" DECIMAL(24,9),
    "change_classification" VARCHAR(40) NOT NULL,
    "suppress_alert" BOOLEAN NOT NULL,
    "alert_eligible" BOOLEAN NOT NULL DEFAULT false,
    "materiality_score" DECIMAL(6,5) NOT NULL DEFAULT 0,
    "materiality_factors" JSONB NOT NULL DEFAULT '{}',
    "severity" VARCHAR(12) NOT NULL DEFAULT 'info',
    "source_lineage" JSONB NOT NULL DEFAULT '{}',
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_canonical_delta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_compatibility_projection_run" (
    "id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "activation_id" UUID,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "rows_written" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "error_text" TEXT,

    CONSTRAINT "defense_budget_compatibility_projection_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_canonical_row" (
    "id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "promotion_run_id" UUID NOT NULL,
    "canonical_entity" VARCHAR(80) NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "parent_natural_key" TEXT,
    "family" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER,
    "funding_field" VARCHAR(32),
    "stage" VARCHAR(40),
    "canonical_row_hash" CHAR(64) NOT NULL,
    "money_original_value" TEXT,
    "money_original_unit" VARCHAR(16),
    "money_value_millions" DECIMAL(24,9),
    "quantity" DECIMAL(24,9),
    "unit_cost_dollars" DECIMAL(24,9),
    "text_value" TEXT,
    "date_value" DATE,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "direct_or_derived" VARCHAR(20) NOT NULL,
    "binding_status" VARCHAR(24) NOT NULL DEFAULT 'not_applicable',
    "source_projection_id" TEXT NOT NULL,
    "source_assertion_id" TEXT NOT NULL,
    "evidence_ids" JSONB NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "artifact_content_sha256" CHAR(64) NOT NULL,
    "verification_candidate_id" TEXT NOT NULL,
    "verification_run_id" TEXT NOT NULL,
    "source_document_id" TEXT NOT NULL,
    "source_pdf_sha256" CHAR(64) NOT NULL,
    "mapping_registry_hash" CHAR(64) NOT NULL,
    "enactment_proof_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_canonical_row_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_promotion_audit" (
    "id" UUID NOT NULL,
    "attempt_kind" VARCHAR(32) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "actor_id" TEXT,
    "cycle_id" TEXT,
    "scope" JSONB,
    "eligibility_hash" CHAR(64),
    "plan_id" TEXT,
    "plan_hash" CHAR(64),
    "authorization_id" TEXT,
    "expected_active_snapshot_id" UUID,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_promotion_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x_tracked_account" (
    "id" UUID NOT NULL,
    "x_user_id" VARCHAR(64) NOT NULL,
    "username" VARCHAR(80) NOT NULL,
    "display_name" VARCHAR(255),
    "avatar_url" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "last_post_id" VARCHAR(64),
    "last_fetched_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "x_tracked_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x_post_cache" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "x_post_id" VARCHAR(64) NOT NULL,
    "text" TEXT NOT NULL,
    "created_at_x" TIMESTAMPTZ(6) NOT NULL,
    "media" JSONB NOT NULL DEFAULT '[]',
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "raw_meta" JSONB NOT NULL DEFAULT '{}',
    "unavailable" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "x_post_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "x_feed_subscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "x_feed_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "source_type" VARCHAR(96) NOT NULL,
    "source_id" VARCHAR(512) NOT NULL,
    "source_version" VARCHAR(160),
    "source_content_hash" VARCHAR(64) NOT NULL,
    "event_type" VARCHAR(96) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "ingested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_refs" JSONB NOT NULL DEFAULT '[]',
    "entity_refs" JSONB NOT NULL DEFAULT '[]',
    "client_refs" JSONB NOT NULL DEFAULT '[]',
    "sensitivity" VARCHAR(96) NOT NULL DEFAULT 'normal',
    "access_scope" JSONB NOT NULL DEFAULT '{"kind":"tenant"}',
    "evidence_locator" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "origin_trace_id" VARCHAR(160),
    "status" VARCHAR(24) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_assertions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "origin_event_id" UUID NOT NULL,
    "subject_type" VARCHAR(96) NOT NULL,
    "subject_id" VARCHAR(512) NOT NULL,
    "predicate" VARCHAR(96) NOT NULL,
    "object_type" VARCHAR(96) NOT NULL,
    "object_id" VARCHAR(512),
    "object_value" JSONB,
    "assertion_class" VARCHAR(32) NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "authority" VARCHAR(32) NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "status" VARCHAR(24) NOT NULL DEFAULT 'active',
    "conflict_status" VARCHAR(24) NOT NULL DEFAULT 'none',
    "conflict_group_id" UUID,
    "supersedes_assertion_id" UUID,
    "contradicts_assertion_id" UUID,
    "sensitivity" VARCHAR(96) NOT NULL DEFAULT 'normal',
    "access_scope" JSONB NOT NULL DEFAULT '{"kind":"tenant"}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_evidence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "assertion_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "source_type" VARCHAR(96) NOT NULL,
    "source_id" VARCHAR(512) NOT NULL,
    "excerpt" TEXT NOT NULL,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_mailbox_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mail_message_id" UUID NOT NULL,
    "source_revision" VARCHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" VARCHAR(160),
    "last_error" TEXT,
    "relevance" JSONB,
    "result_event_id" UUID,
    "processed_content_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_mailbox_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_mailbox_extraction_jobs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "mailbox_job_id" UUID NOT NULL,
    "mail_message_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "source_revision" VARCHAR(64) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "sensitivity" VARCHAR(32) NOT NULL,
    "access_scope" JSONB NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" VARCHAR(160),
    "last_error" TEXT,
    "result" JSONB,
    "assertion_count" INTEGER NOT NULL DEFAULT 0,
    "held_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_mailbox_extraction_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_episodes" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "strategy" VARCHAR(32) NOT NULL,
    "identity_key" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "sensitivity" VARCHAR(96) NOT NULL,
    "access_scope" JSONB NOT NULL,
    "client_refs" JSONB NOT NULL DEFAULT '[]',
    "grouping_key" JSONB NOT NULL,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "assertion_count" INTEGER NOT NULL DEFAULT 0,
    "entity_count" INTEGER NOT NULL DEFAULT 0,
    "first_event_at" TIMESTAMPTZ(6) NOT NULL,
    "last_event_at" TIMESTAMPTZ(6) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_episode_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_episode_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_episode_assertions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "assertion_id" UUID NOT NULL,
    "origin_event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_episode_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_episode_entities" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "canonical_entity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_episode_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_episode_projection_jobs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" VARCHAR(160),
    "last_error" TEXT,
    "episode_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_episode_projection_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_funding_measure" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "measure_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "authority_type" TEXT NOT NULL,
    "fiscal_year" INTEGER,
    "availability_start" DATE,
    "availability_end" DATE,
    "legislation_id" TEXT,
    "public_law_number" TEXT,
    "title" TEXT NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_page" INTEGER,
    "dedup_key" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_funding_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_funding_provision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "measure_id" UUID NOT NULL,
    "section" TEXT,
    "agency" TEXT,
    "component" TEXT,
    "appropriation_title" TEXT,
    "tas" TEXT,
    "stated_amount_usd" DECIMAL(20,2),
    "purpose_text" TEXT NOT NULL,
    "designation" TEXT,
    "transfer_authority" TEXT,
    "availability_start" DATE,
    "availability_end" DATE,
    "source_document_id" UUID NOT NULL,
    "source_page" INTEGER,
    "evidence_sha256" CHAR(64) NOT NULL,
    "dedup_key" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_funding_provision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_funding_allocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provision_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_native_key" TEXT,
    "target_id" TEXT,
    "allocation_stage" TEXT NOT NULL,
    "mapping_maturity" TEXT NOT NULL,
    "review_state" TEXT NOT NULL DEFAULT 'candidate',
    "authoritative_amount_usd" DECIMAL(20,2),
    "inferred_relevance" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DECIMAL(5,4),
    "base_request_status" TEXT NOT NULL DEFAULT 'unknown',
    "potential_double_count" BOOLEAN NOT NULL DEFAULT false,
    "funding_posture" TEXT NOT NULL DEFAULT 'unknown',
    "evidence_source_document_id" UUID NOT NULL,
    "evidence_page" INTEGER,
    "evidence_sha256" CHAR(64) NOT NULL,
    "obligation_reference" TEXT,
    "execution_reference" TEXT,
    "source_event_id" UUID,
    "amount_basis" TEXT NOT NULL DEFAULT 'legacy_unspecified',
    "as_of_date" DATE,
    "period_start" DATE,
    "period_end" DATE,
    "execution_metric" TEXT,
    "correction_of_allocation_id" UUID,
    "transfer_pair_key" TEXT,
    "transfer_side" TEXT,
    "dedup_key" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_funding_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_funding_source_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_event_key" TEXT NOT NULL,
    "source_system" TEXT NOT NULL,
    "source_record_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "event_type" TEXT NOT NULL,
    "measure_id" UUID,
    "source_document_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6),
    "source_observed_at" TIMESTAMPTZ(6),
    "source_url" TEXT,
    "source_version" TEXT,
    "amount_basis" TEXT,
    "execution_metric" TEXT,
    "as_of_date" DATE,
    "period_start" DATE,
    "period_end" DATE,
    "source_amount_usd" DECIMAL(20,2),
    "signed_obligation_delta" DECIMAL(20,2),
    "signed_outlay_delta" DECIMAL(20,2),
    "correction_of_event_id" UUID,
    "transfer_pair_key" TEXT,
    "transfer_side" TEXT,
    "content_sha256" CHAR(64) NOT NULL,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_funding_source_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_funding_certification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "certification_key" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "measure_id" UUID NOT NULL,
    "measure_status" TEXT NOT NULL,
    "source_event_watermark" TIMESTAMPTZ(6),
    "source_event_count" INTEGER NOT NULL,
    "scope_jsonb" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'certified',
    "certified_by" TEXT,
    "certified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content_sha256" CHAR(64) NOT NULL,

    CONSTRAINT "federal_funding_certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_funding_publication" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "certification_id" UUID NOT NULL,
    "allocation_id" UUID NOT NULL,
    "allocation_snapshot_jsonb" JSONB NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_funding_publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_funding_reconciliation_residual" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "certification_id" UUID NOT NULL,
    "scope_key" TEXT NOT NULL,
    "scope_jsonb" JSONB NOT NULL,
    "basis" TEXT NOT NULL,
    "residual_amount_usd" DECIMAL(20,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "coverage_state" TEXT NOT NULL,
    "freshness_jsonb" JSONB NOT NULL DEFAULT '{}',
    "evidence_source_document_id" UUID,
    "evidence_sha256" CHAR(64),
    "content_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_funding_reconciliation_residual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "federal_funding_publication_checkpoint" (
    "checkpoint_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "cursor" TEXT,
    "through_id" TEXT,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "federal_funding_publication_checkpoint_pkey" PRIMARY KEY ("checkpoint_key")
);

-- CreateTable
CREATE TABLE "defense_budget_cycle" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "fiscal_year" INTEGER NOT NULL,
    "authority_track" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "template_version" TEXT NOT NULL,
    "bootstrap_origin" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "dedup_key" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_cycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_expected_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cycle_id" UUID NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "authority_track" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "source_family" TEXT NOT NULL,
    "chamber" TEXT,
    "committee" TEXT,
    "component" TEXT,
    "adapter_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expected_state" TEXT NOT NULL DEFAULT 'expected',
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "template_version" TEXT NOT NULL,
    "expected_from" TIMESTAMPTZ(6) NOT NULL,
    "expected_to" TIMESTAMPTZ(6) NOT NULL,
    "review_reason" TEXT,
    "dedup_key" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_expected_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_source_bundle_member" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "expected_source_id" UUID NOT NULL,
    "member_key" TEXT NOT NULL,
    "volume" TEXT,
    "budget_activity" TEXT,
    "official_url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "member_status" TEXT NOT NULL DEFAULT 'missing',
    "observation_id" UUID,
    "source_document_id" UUID,
    "expected_fiscal_year" INTEGER NOT NULL,
    "expected_authority_track" TEXT NOT NULL,
    "expected_stage" TEXT NOT NULL,
    "expected_source_family" TEXT NOT NULL,
    "expected_component" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_source_bundle_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_governed_import_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "expected_source_id" UUID NOT NULL,
    "bundle_member_id" UUID NOT NULL,
    "observation_id" UUID,
    "operator" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "official_url" TEXT NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "archive_bucket" TEXT NOT NULL,
    "archive_s3_key" TEXT NOT NULL,
    "archive_version_id" TEXT,
    "import_command_version" TEXT NOT NULL,
    "identity_checks_jsonb" JSONB NOT NULL,
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_governed_import_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_source_observation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "expected_source_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "adapter_id" TEXT NOT NULL,
    "discovered_url" TEXT NOT NULL,
    "http_etag" TEXT,
    "http_last_modified" TEXT,
    "content_sha256" CHAR(64) NOT NULL,
    "byte_size" INTEGER,
    "observation_state" TEXT NOT NULL DEFAULT 'discovered',
    "revision_kind" TEXT NOT NULL,
    "classified_fiscal_year" INTEGER,
    "classified_authority_track" TEXT,
    "classified_stage" TEXT,
    "classified_source_family" TEXT,
    "classification_confidence" DECIMAL(4,3),
    "review_reasons" JSONB NOT NULL DEFAULT '[]',
    "source_document_id" UUID,
    "superseded_by_observation_id" UUID,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_count" INTEGER NOT NULL DEFAULT 1,
    "dedup_key" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_source_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_watcher_adapter" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adapter_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "cursor_jsonb" JSONB NOT NULL DEFAULT '{}',
    "checkpoint_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_check_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "next_check_at" TIMESTAMPTZ(6),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_error_class" TEXT,
    "last_error_message" TEXT,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(6),
    "requires_gpu" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_watcher_adapter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_watcher_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adapter_id" TEXT NOT NULL,
    "run_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "discovered_count" INTEGER NOT NULL DEFAULT 0,
    "unchanged_count" INTEGER NOT NULL DEFAULT 0,
    "changed_count" INTEGER NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "queued_count" INTEGER NOT NULL DEFAULT 0,
    "blocked_count" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error_class" TEXT,
    "error_message" TEXT,
    "next_check_at" TIMESTAMPTZ(6),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_watcher_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_ingestion_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "observation_id" UUID NOT NULL,
    "observation_state" TEXT NOT NULL,
    "cycle_id" UUID NOT NULL,
    "job_kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leased_by" TEXT,
    "leased_until" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "dedup_key" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_ingestion_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_reextraction_operation_v1" (
    "id" UUID NOT NULL,
    "outbox_row_id" UUID NOT NULL,
    "old_candidate_id" UUID NOT NULL,
    "old_verification_run_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "request_jsonb" JSONB NOT NULL,
    "snapshot_jsonb" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "lease_token" UUID,
    "leased_until" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "verification_correlations_jsonb" JSONB NOT NULL DEFAULT '[]',
    "terminal_jsonb" JSONB,
    "closure_jsonb" JSONB,
    "candidate_id" UUID,
    "verification_run_id" UUID,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "budget_reextraction_operation_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_ingestion_manifest_v1" (
    "id" UUID NOT NULL,
    "schema_version" TEXT NOT NULL,
    "manifest_sha256" CHAR(64) NOT NULL,
    "manifest_jsonb" JSONB NOT NULL,
    "owner" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "release_revision" CHAR(40) NOT NULL,
    "runtime_image_digest" TEXT NOT NULL,
    "task_definition_arn" TEXT NOT NULL,
    "runtime_config_sha256" CHAR(64) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "stop_requested_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "defense_budget_ingestion_manifest_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_ingestion_manifest_item_v1" (
    "id" UUID NOT NULL,
    "manifest_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "outbox_row_id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "source_byte_size" INTEGER NOT NULL,
    "expected_outbox_state" TEXT NOT NULL,
    "member_jsonb" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lease_token" UUID,
    "lease_generation" INTEGER NOT NULL DEFAULT 0,
    "leased_until" TIMESTAMPTZ(6),
    "last_heartbeat_at" TIMESTAMPTZ(6),
    "task_job_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "execution_history_jsonb" JSONB NOT NULL DEFAULT '[]',
    "verification_correlations_jsonb" JSONB NOT NULL DEFAULT '[]',
    "reconciliations_jsonb" JSONB NOT NULL DEFAULT '[]',
    "terminal_jsonb" JSONB,
    "candidate_id" UUID,
    "verification_run_id" UUID,
    "parser_disposition" TEXT,
    "last_error_class" TEXT,
    "last_error_message" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "defense_budget_ingestion_manifest_item_v1_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_lifecycle_signal" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cycle_id" UUID NOT NULL,
    "signal_kind" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "authority_track" TEXT NOT NULL,
    "from_stage" TEXT NOT NULL,
    "to_stage" TEXT NOT NULL,
    "from_observation_id" UUID NOT NULL,
    "to_observation_id" UUID NOT NULL,
    "emitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedup_key" CHAR(64) NOT NULL,
    "payload_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_lifecycle_signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_discovery_crawl" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adapter_id" TEXT NOT NULL,
    "run_key" TEXT NOT NULL,
    "request_url" TEXT NOT NULL,
    "resource_kind" TEXT NOT NULL,
    "status_code" INTEGER,
    "status" TEXT NOT NULL,
    "content_sha256" CHAR(64),
    "byte_size" INTEGER,
    "items_seen" INTEGER NOT NULL DEFAULT 0,
    "robots_unavailable" BOOLEAN NOT NULL DEFAULT false,
    "effective_interval_ms" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_discovery_crawl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_discovery_candidate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "crawl_id" UUID NOT NULL,
    "adapter_id" TEXT NOT NULL,
    "run_key" TEXT NOT NULL,
    "candidate_url" TEXT NOT NULL,
    "package_id" TEXT,
    "title" TEXT,
    "resolution" TEXT NOT NULL,
    "expected_source_dedup_key" CHAR(64),
    "classified_fiscal_year" INTEGER,
    "reason" TEXT NOT NULL,
    "emitted" BOOLEAN NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_discovery_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_discovery_host_budget" (
    "host" TEXT NOT NULL,
    "next_request_allowed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reservation_count" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_discovery_host_budget_pkey" PRIMARY KEY ("host")
);

-- CreateTable
CREATE TABLE "defense_provider_invocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "model" TEXT,
    "tenant_id" TEXT NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "idempotency_key" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "failure_class" TEXT,
    "reason" TEXT NOT NULL,
    "result_dimension" INTEGER,
    "result_count" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_provider_invocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_schedule_tick" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "worker_id" TEXT NOT NULL,
    "tick_key" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,
    "outcome" TEXT NOT NULL,
    "horizon_bootstrapped" BOOLEAN NOT NULL,
    "adapters_considered" INTEGER NOT NULL,
    "adapters_due" INTEGER NOT NULL,
    "adapters_succeeded" INTEGER NOT NULL,
    "adapters_failed" INTEGER NOT NULL,
    "adapters_skipped_lease" INTEGER NOT NULL,
    "committed" BOOLEAN NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_schedule_tick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_review_resolution" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "expected_source_id" UUID NOT NULL,
    "previous_expected_state" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "review_reason_before" TEXT,
    "note" TEXT NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resolved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_review_resolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_budget_cycle_manifest_registry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cycle_id" TEXT NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "manifest_document_jsonb" JSONB NOT NULL,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_budget_cycle_manifest_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legiwatch_digest_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL,
    "decision_count" INTEGER NOT NULL,
    "source_families" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "content_jsonb" JSONB NOT NULL,

    CONSTRAINT "legiwatch_digest_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legiwatch_digest_schedule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" UUID,
    "cadence" TEXT NOT NULL DEFAULT 'daily',
    "hour_utc" INTEGER NOT NULL DEFAULT 11,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legiwatch_digest_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gsa_real_property" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_hash" CHAR(64) NOT NULL,
    "source_document_sha256" CHAR(64) NOT NULL,
    "source_dataset" VARCHAR(48) NOT NULL DEFAULT 'frpp_public_detailed',
    "fiscal_year" INTEGER NOT NULL,
    "retrieved_at" TIMESTAMPTZ(6) NOT NULL,
    "rp_uid" VARCHAR(64) NOT NULL,
    "reporting_agency" TEXT NOT NULL,
    "reporting_agency_code" VARCHAR(8),
    "using_agency" TEXT,
    "bureau" TEXT,
    "installation_name" TEXT,
    "installation_id" VARCHAR(64),
    "grain" VARCHAR(24) NOT NULL DEFAULT 'detailed_asset',
    "is_defense" BOOLEAN NOT NULL DEFAULT false,
    "us_or_foreign" VARCHAR(24) NOT NULL,
    "country_name" TEXT,
    "state_code" VARCHAR(8),
    "state_name" TEXT,
    "county_name" TEXT,
    "city_name" TEXT,
    "zip_code" VARCHAR(16),
    "street_address" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "geography_basis" VARCHAR(24) NOT NULL DEFAULT 'source_coordinates',
    "legal_interest" VARCHAR(24),
    "real_property_type" TEXT,
    "real_property_use" TEXT,
    "utilization" TEXT,
    "asset_status" TEXT,
    "asset_status_code" VARCHAR(8),
    "historical_status" TEXT,
    "square_feet" DECIMAL(18,2),
    "square_feet_uom" VARCHAR(32),
    "congressional_district" VARCHAR(32),
    "boundary_congress" INTEGER,
    "district_source" VARCHAR(24) NOT NULL DEFAULT 'source_reported',
    "congressional_district_source_url" TEXT,
    "congress_session" INTEGER,
    "lease_expiration_date" DATE,
    "lease_start_date" DATE,
    "annual_rent_usd" DECIMAL(18,2),
    "federal_employees_count" INTEGER,
    "federal_contractors_count" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gsa_real_property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gsa_real_property_source_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_dataset" VARCHAR(48) NOT NULL,
    "fiscal_year" INTEGER,
    "source_document_sha256" CHAR(64),
    "source_url" TEXT,
    "dry_run" BOOLEAN NOT NULL DEFAULT true,
    "status" VARCHAR(24) NOT NULL,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "rows_seen" INTEGER NOT NULL DEFAULT 0,
    "rows_written" INTEGER NOT NULL DEFAULT 0,
    "rows_rejected" INTEGER NOT NULL DEFAULT 0,
    "rows_skipped_duplicate" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "gsa_real_property_source_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "district_nexus_change" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dedupe_key" VARCHAR(120) NOT NULL,
    "change_kind" VARCHAR(48) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "source_dataset" VARCHAR(64),
    "source_record_id" TEXT NOT NULL,
    "source_fiscal_year" INTEGER,
    "source_version" TEXT,
    "state_code" VARCHAR(2),
    "district_code" VARCHAR(8),
    "boundary_congress" INTEGER,
    "member_bioguide_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "old_value" JSONB,
    "new_value" JSONB,
    "old_state" VARCHAR(24),
    "new_state" VARCHAR(24),
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "effective_at" TIMESTAMPTZ(6),
    "source_year" INTEGER,
    "geography_vintage" VARCHAR(48),
    "severity" VARCHAR(16) NOT NULL DEFAULT 'info',
    "observation_kind" VARCHAR(24) NOT NULL DEFAULT 'change',
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "district_nexus_change_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "business_development_prospect_activity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "kind" VARCHAR(24) NOT NULL DEFAULT 'note',
    "body" TEXT NOT NULL,
    "before_jsonb" JSONB,
    "after_jsonb" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_development_prospect_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_development_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "practice_service_areas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agencies_issues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "geographies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_development_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_development_jev_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" VARCHAR(24) NOT NULL,
    "subject_id" VARCHAR(160) NOT NULL,
    "prospect_id" UUID,
    "canonical_entity_id" UUID,
    "task" VARCHAR(32) NOT NULL,
    "mode" VARCHAR(24) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "operational_state" VARCHAR(40),
    "provider_name" VARCHAR(64) NOT NULL,
    "model_version" VARCHAR(40) NOT NULL,
    "registry_version" VARCHAR(64) NOT NULL,
    "question_version" VARCHAR(64) NOT NULL,
    "envelope_hash" VARCHAR(80) NOT NULL,
    "candidate_inventory_hash" VARCHAR(80),
    "source_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_hashes_jsonb" JSONB NOT NULL DEFAULT '[]',
    "deterministic_outcome" VARCHAR(64),
    "outcome" VARCHAR(64),
    "probabilities_jsonb" JSONB,
    "confidence" DECIMAL(6,5),
    "reason_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "estimated_cost_usd" DECIMAL(12,9),
    "latency_ms" INTEGER,
    "visible_effect_jsonb" JSONB,
    "review_status" VARCHAR(24) NOT NULL DEFAULT 'unreviewed',
    "reviewed_outcome" VARCHAR(64),
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "idempotency_key" VARCHAR(400) NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_development_jev_decisions_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "business_development_watches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "muted_until" TIMESTAMPTZ(6),
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "frequency" VARCHAR(16),
    "digest" BOOLEAN NOT NULL DEFAULT false,
    "preference_version" INTEGER NOT NULL DEFAULT 1,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_development_watches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_development_watch_source_states" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "watch_id" UUID NOT NULL,
    "source_family" VARCHAR(32) NOT NULL,
    "health" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "baseline_state" JSONB,
    "baselined_at" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6),
    "last_successful_complete_check_at" TIMESTAMPTZ(6),
    "source_watermark" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "lease_token" VARCHAR(64),
    "lease_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_development_watch_source_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_development_alerts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "watch_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "source_family" VARCHAR(32) NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "change_kind" VARCHAR(24) NOT NULL,
    "materiality" VARCHAR(16) NOT NULL,
    "record_id" TEXT NOT NULL,
    "source_revision" TEXT,
    "fingerprint" VARCHAR(64) NOT NULL,
    "dedupe_key" VARCHAR(512) NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB NOT NULL,
    "changes_jsonb" JSONB NOT NULL DEFAULT '[]',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "implication" TEXT NOT NULL,
    "source_locator" TEXT NOT NULL,
    "event_at" TIMESTAMPTZ(6),
    "effective_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "first_observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_state" VARCHAR(16) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_development_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_development_alert_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "channel" VARCHAR(16) NOT NULL DEFAULT 'in_app',
    "delivered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),
    "dismissed_at" TIMESTAMPTZ(6),
    "dismissed_by_user_id" UUID,

    CONSTRAINT "business_development_alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolios" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "purpose" TEXT,
    "mode" "research_portfolio_mode" NOT NULL DEFAULT 'manual',
    "lifecycle" "research_portfolio_lifecycle" NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_grants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "principal_user_id" UUID NOT NULL,
    "role" "research_portfolio_grant_role" NOT NULL,
    "granted_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_client_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "linked_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_client_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "target_kind" "research_portfolio_member_kind" NOT NULL,
    "target_id" VARCHAR(256) NOT NULL,
    "label" VARCHAR(300),
    "disposition" "research_portfolio_member_disposition" NOT NULL DEFAULT 'included',
    "origin" "research_portfolio_member_origin" NOT NULL DEFAULT 'manual',
    "reason" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "qualification" VARCHAR(64),
    "rule_version_id" UUID,
    "decision_revision" INTEGER,
    "unresolved_input" JSONB,
    "resolved_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "event_kind" "research_portfolio_event_kind" NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" VARCHAR(128),
    "payload_fingerprint" VARCHAR(64),
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "research_portfolio_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_taxonomy_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "vocabulary" VARCHAR(64) NOT NULL,
    "source" TEXT,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "author_user_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "predecessor_id" UUID,

    CONSTRAINT "research_taxonomy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_taxonomy_concepts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "taxonomy_version_id" UUID NOT NULL,
    "stable_key" VARCHAR(128) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(48) NOT NULL,
    "parent_key" VARCHAR(128),
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "qualification" VARCHAR(32) NOT NULL DEFAULT 'reviewed',

    CONSTRAINT "research_taxonomy_concepts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_template_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "expression" JSONB NOT NULL,
    "readable_expression" TEXT NOT NULL,
    "mode" "research_portfolio_mode" NOT NULL,
    "qualification_policy" JSONB NOT NULL,
    "taxonomy_version_id" UUID,
    "author_user_id" UUID NOT NULL,
    "predecessor_id" UUID,
    "operation_key" VARCHAR(128) NOT NULL,
    "payload_fingerprint" CHAR(64) NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_rule_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "expression" JSONB NOT NULL,
    "readable_expression" TEXT NOT NULL,
    "mode" "research_portfolio_mode" NOT NULL,
    "qualification_policy" JSONB NOT NULL,
    "taxonomy_version_id" UUID,
    "template_version_id" UUID,
    "preview_hash" CHAR(64) NOT NULL,
    "author_user_id" UUID NOT NULL,
    "predecessor_id" UUID,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_rule_previews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "portfolio_revision" INTEGER NOT NULL,
    "preview_hash" CHAR(64) NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "expression" JSONB NOT NULL,
    "manifest" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_rule_previews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_recompute_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "status" "research_portfolio_recompute_status" NOT NULL DEFAULT 'queued',
    "cursor" TEXT,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "matched_count" INTEGER NOT NULL DEFAULT 0,
    "unknown_count" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" VARCHAR(128),
    "lease_until" TIMESTAMPTZ(6),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB NOT NULL DEFAULT '{}',
    "error_code" VARCHAR(128),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_recompute_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_reviews" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "target_kind" "research_portfolio_review_target_kind" NOT NULL,
    "target_id" VARCHAR(256) NOT NULL,
    "trigger" "research_portfolio_review_trigger" NOT NULL,
    "trigger_identity" VARCHAR(256) NOT NULL,
    "dependency_identity" VARCHAR(256),
    "assignee_user_id" UUID,
    "reason" TEXT NOT NULL,
    "evidence_for" JSONB NOT NULL DEFAULT '[]',
    "evidence_against" JSONB NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "trigger_fingerprint" CHAR(64) NOT NULL,
    "status" "research_portfolio_review_status" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "research_portfolio_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_decisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "target_kind" "research_portfolio_review_target_kind" NOT NULL,
    "target_id" VARCHAR(256) NOT NULL,
    "decision_type" "research_portfolio_decision_type" NOT NULL,
    "reason" TEXT NOT NULL,
    "author_user_id" UUID NOT NULL,
    "decision_time" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prior_decision_id" UUID,
    "supersedes_id" UUID,
    "evidence_for" JSONB NOT NULL DEFAULT '[]',
    "evidence_against" JSONB NOT NULL DEFAULT '[]',
    "review_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_continuity_ledger" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "prior_decision_id" UUID,
    "current_decision_id" UUID,
    "continuity_key" CHAR(64) NOT NULL,
    "prior_dependency_fingerprint" CHAR(64),
    "dependency_fingerprint" CHAR(64) NOT NULL,
    "status" "research_portfolio_continuity_status" NOT NULL,
    "identity_mapping" JSONB NOT NULL DEFAULT '{}',
    "changed_dependencies" JSONB NOT NULL DEFAULT '{}',
    "original_evidence" JSONB NOT NULL DEFAULT '{}',
    "source_edition" VARCHAR(128),
    "relevant_period_start" DATE,
    "relevant_period_end" DATE,
    "expiry_date" DATE,
    "reopening_reason" TEXT,
    "reopening_review_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_continuity_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_import_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "worksheet_kind" "research_portfolio_import_worksheet_kind" NOT NULL,
    "status" "research_portfolio_import_job_status" NOT NULL DEFAULT 'created',
    "original_hash" CHAR(64) NOT NULL,
    "original_size" INTEGER NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "media_type" VARCHAR(128) NOT NULL,
    "original_storage_key" VARCHAR(512),
    "original_bytes" BYTEA NOT NULL,
    "file_metadata" JSONB NOT NULL DEFAULT '{}',
    "parser_version" VARCHAR(32) NOT NULL,
    "schema_version" VARCHAR(32) NOT NULL,
    "target_revision" INTEGER NOT NULL,
    "checkpoint" JSONB,
    "lease_owner" VARCHAR(128),
    "lease_until" TIMESTAMPTZ(6),
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "applied_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_import_rows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "worksheet_kind" "research_portfolio_import_worksheet_kind" NOT NULL,
    "sheet_name" VARCHAR(128),
    "row_number" INTEGER NOT NULL,
    "row_identity" VARCHAR(256) NOT NULL,
    "raw_cells" JSONB NOT NULL DEFAULT '{}',
    "parsed_data" JSONB NOT NULL DEFAULT '{}',
    "repairs" JSONB NOT NULL DEFAULT '{}',
    "validation_issues" JSONB NOT NULL DEFAULT '[]',
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "preview_classification" "research_portfolio_import_row_preview_classification",
    "preview_reason" TEXT,
    "final_outcome" "research_portfolio_import_row_outcome",
    "final_reason" TEXT,
    "final_disposition" JSONB NOT NULL DEFAULT '{}',
    "expected_revision" INTEGER,
    "canonical_target_key" VARCHAR(320),
    "target_kind" VARCHAR(64),
    "target_id" VARCHAR(256),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_import_mapping_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "mapping" JSONB NOT NULL,
    "schema_version" VARCHAR(32) NOT NULL,
    "author_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_import_mapping_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_import_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "outcome" VARCHAR(32) NOT NULL,
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "error_code" VARCHAR(128),
    "receipt" JSONB NOT NULL DEFAULT '{}',
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_import_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_import_effects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "import_row_id" UUID NOT NULL,
    "effect_fingerprint" CHAR(64) NOT NULL,
    "effect_kind" VARCHAR(48) NOT NULL,
    "canonical_target_key" VARCHAR(320) NOT NULL,
    "target_id" VARCHAR(256) NOT NULL,
    "target_revision_at_apply" INTEGER,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_import_effects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_import_compensation_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "import_job_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "preview_hash" CHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "effects" JSONB NOT NULL DEFAULT '[]',
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_import_compensation_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_event_recipient_states" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "seen_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "dismissed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_event_recipient_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "subscriber_user_id" UUID NOT NULL,
    "target_kind" VARCHAR(48) NOT NULL,
    "target_id" VARCHAR(256) NOT NULL,
    "channel" VARCHAR(32) NOT NULL,
    "cadence" VARCHAR(32) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "baseline_event_id" UUID,
    "baseline_revision" INTEGER NOT NULL,
    "baseline_completed_at" TIMESTAMPTZ(6) NOT NULL,
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "lease_owner" VARCHAR(128),
    "lease_until" TIMESTAMPTZ(6),
    "lease_fence" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_subscription_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "channel" VARCHAR(32) NOT NULL,
    "status" "research_portfolio_delivery_status" NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "receipt" JSONB NOT NULL DEFAULT '{}',
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "research_portfolio_subscription_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "portfolio_revision" INTEGER NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "basis" JSONB NOT NULL,
    "membership" JSONB NOT NULL,
    "projection" JSONB NOT NULL,
    "structure_versions" JSONB NOT NULL DEFAULT '{}',
    "rule_versions" JSONB NOT NULL DEFAULT '[]',
    "decision_versions" JSONB NOT NULL DEFAULT '[]',
    "template_versions" JSONB NOT NULL DEFAULT '[]',
    "taxonomy_versions" JSONB NOT NULL DEFAULT '[]',
    "label_versions" JSONB NOT NULL DEFAULT '[]',
    "source_versions" JSONB NOT NULL DEFAULT '[]',
    "calculation_version" VARCHAR(64) NOT NULL,
    "limitations" JSONB NOT NULL DEFAULT '[]',
    "client_access_requirements" JSONB NOT NULL DEFAULT '[]',
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_output_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "snapshot_id" UUID,
    "operation_key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "selected_sections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "include_source_appendix" BOOLEAN NOT NULL DEFAULT false,
    "format" VARCHAR(16) NOT NULL DEFAULT 'csv',
    "status" "research_portfolio_output_status" NOT NULL DEFAULT 'queued',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_output_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_output_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "status" "research_portfolio_output_status" NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(6),
    "lease_owner" VARCHAR(128),
    "lease_until" TIMESTAMPTZ(6),
    "lease_fence" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(128),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_output_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_output_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "outcome" "research_portfolio_output_status" NOT NULL,
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "receipt" JSONB NOT NULL DEFAULT '{}',
    "error_code" VARCHAR(128),
    "actor_user_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_output_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_output_artifacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "media_type" VARCHAR(128) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "bytes" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_output_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_output_client_file_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "attachment_id" UUID NOT NULL,
    "attachment_name" VARCHAR(255) NOT NULL,
    "lifecycle_status" VARCHAR(32),
    "scan_status" VARCHAR(32),
    "indexed_at" TIMESTAMPTZ(6),
    "open_path" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_output_client_file_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_bookmarks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "target_kind" VARCHAR(48) NOT NULL,
    "target_id" VARCHAR(256) NOT NULL,
    "label" VARCHAR(255),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_tour_states" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tour_version" VARCHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_tour_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_review_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "review_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_review_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_context_documents" (
    "id" UUID NOT NULL,
    "source_key" VARCHAR(256) NOT NULL,
    "family" VARCHAR(64) NOT NULL,
    "publisher" VARCHAR(200) NOT NULL,
    "publisher_host" VARCHAR(255),
    "title" TEXT NOT NULL,
    "congress" INTEGER,
    "committee" VARCHAR(300),
    "publication_period_start" DATE,
    "publication_period_end" DATE,
    "published_at" TIMESTAMPTZ(6),
    "status" VARCHAR(48) NOT NULL,
    "transcript_availability" VARCHAR(32) NOT NULL,
    "coverage" VARCHAR(24) NOT NULL,
    "coverage_reason" TEXT,
    "qualification" VARCHAR(32) NOT NULL,
    "source_url" TEXT,
    "eligible" BOOLEAN NOT NULL DEFAULT true,
    "current_revision_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "defense_context_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_context_document_revisions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "source_document_id" UUID,
    "version" VARCHAR(128) NOT NULL,
    "content_hash" CHAR(64),
    "published_at" TIMESTAMPTZ(6),
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(48) NOT NULL,
    "source_url" TEXT,
    "provenance" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "defense_context_document_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_context_sections" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "native_locator" VARCHAR(300),
    "text_availability" VARCHAR(24) NOT NULL,
    "content_hash" CHAR(64),
    "content_text" TEXT,

    CONSTRAINT "defense_context_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_reference_occurrences" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "section_id" UUID,
    "exact_span" TEXT NOT NULL,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "original_wording" TEXT NOT NULL,
    "reference_type" VARCHAR(64) NOT NULL,
    "target_candidates" JSONB NOT NULL DEFAULT '[]',
    "resolved_target" JSONB,
    "resolved_target_document_id" UUID,
    "resolved_target_revision_id" UUID,
    "resolved_target_section_id" UUID,
    "disposition" VARCHAR(24) NOT NULL,
    "target_availability" VARCHAR(24) NOT NULL,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_reference_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_fit_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "basis_fingerprint" CHAR(64) NOT NULL,
    "calculation_version" VARCHAR(64) NOT NULL,
    "portfolio_revision" INTEGER NOT NULL,
    "projection" JSONB NOT NULL,
    "input_basis" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_portfolio_fit_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_saved_comparisons" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "portfolio_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "current_version_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "defense_saved_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_saved_comparison_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "comparison_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "creator_user_id" UUID NOT NULL,
    "schema_version" VARCHAR(64) NOT NULL,
    "projection_version" VARCHAR(64) NOT NULL,
    "display_version" VARCHAR(64) NOT NULL,
    "subjects" JSONB NOT NULL,
    "selection" JSONB NOT NULL,
    "basis_pair" JSONB NOT NULL,
    "passage_mode" VARCHAR(32) NOT NULL,
    "source_pins" JSONB NOT NULL,
    "captured_projection" JSONB NOT NULL,
    "limitations" JSONB NOT NULL DEFAULT '[]',
    "content_hash" CHAR(64) NOT NULL,
    "capture_known_at" TIMESTAMPTZ(6) NOT NULL,
    "known_at_support" VARCHAR(32) NOT NULL DEFAULT 'capture_only',
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_saved_comparison_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defense_saved_comparison_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "comparison_id" UUID NOT NULL,
    "version_id" UUID,
    "actor_user_id" UUID NOT NULL,
    "aggregate_revision" INTEGER NOT NULL,
    "event_kind" VARCHAR(32) NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "payload_fingerprint" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defense_saved_comparison_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_portfolio_client_filing_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "receipt_operation_key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "research_portfolio_client_filing_status" NOT NULL DEFAULT 'pending',
    "writer_fence" INTEGER NOT NULL DEFAULT 1,
    "writer_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "external_checkpoint" JSONB NOT NULL DEFAULT '{}',
    "receipt_id" UUID,
    "last_error_code" VARCHAR(128),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "research_portfolio_client_filing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_subaward" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "provider_key" TEXT NOT NULL,
    "award_key" TEXT,
    "prime_award_key" TEXT,
    "piid" VARCHAR(64),
    "subaward_number" VARCHAR(128),
    "subaward_type" VARCHAR(64),
    "subaward_amount" DECIMAL(20,2),
    "action_date" DATE,
    "fiscal_year" INTEGER,
    "description" TEXT,
    "naics_code" VARCHAR(12),
    "prime_recipient_uei" VARCHAR(12),
    "prime_recipient_name" TEXT,
    "prime_parent_uei" VARCHAR(12),
    "prime_parent_name" TEXT,
    "subawardee_uei" VARCHAR(12),
    "subawardee_name" TEXT,
    "subawardee_parent_uei" VARCHAR(12),
    "subawardee_parent_name" TEXT,
    "awarding_agency" TEXT,
    "awarding_office" TEXT,
    "funding_agency" TEXT,
    "funding_office" TEXT,
    "pop_country" VARCHAR(3),
    "pop_state" VARCHAR(8),
    "pop_city" TEXT,
    "pop_zip" VARCHAR(16),
    "pop_congressional_district" VARCHAR(8),
    "source_url" TEXT,
    "provider_modified_at" TIMESTAMPTZ(6),
    "content_sha256" VARCHAR(64) NOT NULL,
    "normalized_jsonb" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "first_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tango_subaward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tango_subaward_sync_checkpoint" (
    "sync_key" VARCHAR(64) NOT NULL,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "next_page" INTEGER NOT NULL DEFAULT 1,
    "completeness" VARCHAR(16) NOT NULL DEFAULT 'complete',
    "rows_processed" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tango_subaward_sync_checkpoint_pkey" PRIMARY KEY ("sync_key")
);

-- CreateTable
CREATE TABLE "krisp_notetaker_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "folder_id" TEXT,
    "enabled_at" TIMESTAMPTZ(6) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "last_checked_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "krisp_notetaker_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "krisp_meeting_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "document_id" VARCHAR(32) NOT NULL,
    "title" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "meeting_id" UUID,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "note_id" UUID,
    "debrief_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "krisp_meeting_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_activity_commands" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "actor_clerk_user_id" VARCHAR(255) NOT NULL,
    "request_id" UUID NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "activity_id" UUID NOT NULL,
    "person_id" UUID,
    "assignee_user_id" UUID,
    "assignee_clerk_user_id" VARCHAR(255),
    "planner_payload" JSONB,
    "status" VARCHAR(16) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "task_id" UUID,
    "attempt_token" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "client_activity_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prospect_attachment_upload_intents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "prospect_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content_length" INTEGER NOT NULL,
    "checksum_sha256" VARCHAR(64) NOT NULL,
    "bucket" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmed_attachment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_attachment_upload_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_recipient_access" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "outreach_record_id" UUID NOT NULL,
    "draft_version_id" UUID,
    "token" VARCHAR(64) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "html" TEXT NOT NULL,
    "survey_answers" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_recipient_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_review_email_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "message_id" TEXT,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_review_email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "unsubscribed_at" TIMESTAMPTZ(6),

    CONSTRAINT "newsletter_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_account_invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_role" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "provider_invitation_id" TEXT,
    "provider_role" TEXT,
    "attempted_at" TIMESTAMPTZ(6),
    "attempt_kind" TEXT,
    "lease_id" UUID,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_account_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_invitation_email_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "message_id" TEXT,
    "error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsletter_invitation_email_deliveries_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "canonical_entities_visible_name_idx" ON "canonical_entities"("entity_type", "normalized_name", "identity_scope", "tenant_id", "status");

-- CreateIndex
CREATE INDEX "entity_identifiers_entity_idx" ON "entity_identifiers"("entity_id", "identifier_type", "status");

-- CreateIndex
CREATE INDEX "entity_resolutions_tenant_created_idx" ON "entity_resolutions"("tenant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "entity_resolutions_identity_unique" ON "entity_resolutions"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_entity_merges_source_unique" ON "canonical_entity_merges"("source_entity_id");

-- CreateIndex
CREATE INDEX "canonical_entity_merges_tenant_created_idx" ON "canonical_entity_merges"("tenant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "canonical_entity_merges_target_idx" ON "canonical_entity_merges"("tenant_id", "target_entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "entity_identity_governance_events_subject_idx" ON "entity_identity_governance_events"("tenant_id", "subject_type", "subject_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "entity_identity_governance_events_actor_idx" ON "entity_identity_governance_events"("tenant_id", "actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "entity_identity_governance_events_identity_unique" ON "entity_identity_governance_events"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "canonical_entity_backfill_checkpoints_tenant_status_idx" ON "canonical_entity_backfill_checkpoints"("tenant_id", "status", "updated_at" DESC);

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
CREATE INDEX "admin_broadcasts_tenant_created_idx" ON "admin_broadcasts"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_broadcast_recipients_pending_idx" ON "admin_broadcast_recipients"("tenant_id", "user_id", "acknowledged_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_broadcast_recipients_broadcast_user_unique" ON "admin_broadcast_recipients"("broadcast_id", "user_id");

-- CreateIndex
CREATE INDEX "user_identity_conflict_detected_at_idx" ON "user_identity_conflict"("detected_at");

-- CreateIndex
CREATE INDEX "user_identity_conflict_email_idx" ON "user_identity_conflict"("email");

-- CreateIndex
CREATE INDEX "identity_outbox_pending_idx" ON "identity_outbox"("consumed_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "identity_outbox_tenant_created_idx" ON "identity_outbox"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "clerk_events_event_id_key" ON "clerk_events"("event_id");

-- CreateIndex
CREATE INDEX "clerk_events_event_type_idx" ON "clerk_events"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_events_event_id_key" ON "stripe_events"("event_id");

-- CreateIndex
CREATE INDEX "stripe_events_event_type_idx" ON "stripe_events"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_usage_meters_tenant_period_key" ON "tenant_usage_meters"("tenant_id", "period_start");

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
CREATE INDEX "client_objectives_list_idx" ON "client_objectives"("tenant_id", "client_id", "deleted_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "client_objectives_scope_key" ON "client_objectives"("tenant_id", "client_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "client_objectives_request_key" ON "client_objectives"("tenant_id", "client_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_objective_revisions_version_key" ON "client_objective_revisions"("tenant_id", "objective_id", "version");

-- CreateIndex
CREATE INDEX "client_ordered_owners_member_idx" ON "client_ordered_owners"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_ordered_owners_user_unique" ON "client_ordered_owners"("tenant_id", "client_id", "user_id");

-- CreateIndex
CREATE INDEX "client_team_members_client_idx" ON "client_team_members"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "client_team_members_user_idx" ON "client_team_members"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_team_members_uniq" ON "client_team_members"("tenant_id", "client_id", "user_id");

-- CreateIndex
CREATE INDEX "saved_opportunity_searches_scope_idx" ON "saved_opportunity_searches"("tenant_id", "client_id", "archived_at", "updated_at");

-- CreateIndex
CREATE INDEX "saved_opportunity_searches_owner_idx" ON "saved_opportunity_searches"("tenant_id", "owner_id", "archived_at");

-- CreateIndex
CREATE INDEX "directory_contact_notes_tenant_contact_created_idx" ON "directory_contact_notes"("tenant_id", "directory_contact_id", "created_at");

-- CreateIndex
CREATE INDEX "directory_contact_notes_created_by_idx" ON "directory_contact_notes"("created_by_user_id");

-- CreateIndex
CREATE INDEX "directory_contact_favorites_tenant_user_idx" ON "directory_contact_favorites"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "directory_contact_favorites_unique" ON "directory_contact_favorites"("tenant_id", "user_id", "directory_contact_id");

-- CreateIndex
CREATE INDEX "engagement_connections_tenant_status_idx" ON "engagement_connections"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_connections_tenant_provider_account_key" ON "engagement_connections"("tenant_id", "provider", "account_email");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_connection_tokens_connection_id_key" ON "engagement_connection_tokens"("connection_id");

-- CreateIndex
CREATE INDEX "engagement_connection_tokens_tenant_connection_idx" ON "engagement_connection_tokens"("tenant_id", "connection_id");

-- CreateIndex
CREATE INDEX "engagement_contacts_tenant_client_idx" ON "engagement_contacts"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "engagement_contacts_acquisition_personnel_id_idx" ON "engagement_contacts"("acquisition_personnel_id");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_contacts_tenant_email_key" ON "engagement_contacts"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "meetings_tenant_starts_idx" ON "meetings"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "meetings_tenant_client_starts_idx" ON "meetings"("tenant_id", "client_id", "starts_at");

-- CreateIndex
CREATE INDEX "meetings_tenant_ical_idx" ON "meetings"("tenant_id", "ical_uid");

-- CreateIndex
CREATE UNIQUE INDEX "meetings_tenant_source_external_key" ON "meetings"("tenant_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "meeting_attendees_tenant_email_idx" ON "meeting_attendees"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_attendees_meeting_email_key" ON "meeting_attendees"("meeting_id", "email");

-- CreateIndex
CREATE INDEX "mail_threads_tenant_client_last_idx" ON "mail_threads"("tenant_id", "client_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_threads_tenant_source_external_key" ON "mail_threads"("tenant_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "mail_messages_tenant_from_idx" ON "mail_messages"("tenant_id", "from_email");

-- CreateIndex
CREATE INDEX "mail_messages_tenant_received_idx" ON "mail_messages"("tenant_id", "received_at");

-- CreateIndex
CREATE INDEX "mail_messages_tenant_sent_idx" ON "mail_messages"("tenant_id", "sent_at");

-- CreateIndex
CREATE INDEX "mail_messages_thread_removed_received_idx" ON "mail_messages"("thread_id", "removed_at", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "mail_messages_tenant_source_external_key" ON "mail_messages"("tenant_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "mobile_device_tokens_owner_active_idx" ON "mobile_device_tokens"("tenant_id", "user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "mobile_device_tokens_hash_env_idx" ON "mobile_device_tokens"("token_hash", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "mobile_device_tokens_owner_device_env_key" ON "mobile_device_tokens"("tenant_id", "user_id", "device_id", "environment");

-- CreateIndex
CREATE INDEX "engagement_attachments_prospect_idx" ON "engagement_attachments"("tenant_id", "prospect_id", "created_at");

-- CreateIndex
CREATE INDEX "engagement_attachments_tenant_client_idx" ON "engagement_attachments"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "engagement_attachments_generated_source_idx" ON "engagement_attachments"("tenant_id", "client_id", "source", "source_entity_type", "created_at");

-- CreateIndex
CREATE INDEX "engagement_attachments_tenant_meeting_idx" ON "engagement_attachments"("tenant_id", "meeting_id");

-- CreateIndex
CREATE INDEX "engagement_attachments_tenant_mail_message_idx" ON "engagement_attachments"("tenant_id", "mail_message_id");

-- CreateIndex
CREATE INDEX "engagement_attachments_tenant_lifecycle_created_idx" ON "engagement_attachments"("tenant_id", "lifecycle_status", "created_at");

-- CreateIndex
CREATE INDEX "engagement_attachments_tenant_shared_idx" ON "engagement_attachments"("tenant_id", "shared_at");

-- CreateIndex
CREATE INDEX "meeting_notes_tenant_meeting_created_idx" ON "meeting_notes"("tenant_id", "meeting_id", "created_at");

-- CreateIndex
CREATE INDEX "meeting_notes_tenant_shared_idx" ON "meeting_notes"("tenant_id", "shared_at");

-- CreateIndex
CREATE INDEX "meeting_prep_jobs_status_lease_until_created_at_idx" ON "meeting_prep_jobs"("status", "lease_until", "created_at");

-- CreateIndex
CREATE INDEX "meeting_prep_jobs_tenant_id_user_id_meeting_id_created_at_idx" ON "meeting_prep_jobs"("tenant_id", "user_id", "meeting_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_prep_jobs_tenant_id_user_id_request_key_key" ON "meeting_prep_jobs"("tenant_id", "user_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_prep_monday_mappings_tenant_id_user_id_client_id_key" ON "meeting_prep_monday_mappings"("tenant_id", "user_id", "client_id");

-- CreateIndex
CREATE INDEX "meeting_preps_tenant_meeting_created_idx" ON "meeting_preps"("tenant_id", "meeting_id", "created_at");

-- CreateIndex
CREATE INDEX "meeting_preps_tenant_shared_idx" ON "meeting_preps"("tenant_id", "shared_at");

-- CreateIndex
CREATE INDEX "meeting_debriefs_tenant_meeting_created_idx" ON "meeting_debriefs"("tenant_id", "meeting_id", "created_at");

-- CreateIndex
CREATE INDEX "meeting_debriefs_tenant_shared_idx" ON "meeting_debriefs"("tenant_id", "shared_at");

-- CreateIndex
CREATE UNIQUE INDEX "client_notetaker_preferences_scope_key" ON "client_notetaker_preferences"("tenant_id", "client_id", "user_id");

-- CreateIndex
CREATE INDEX "meeting_bot_sessions_tenant_meeting_created_idx" ON "meeting_bot_sessions"("tenant_id", "meeting_id", "created_at");

-- CreateIndex
CREATE INDEX "meeting_bot_sessions_external_bot_idx" ON "meeting_bot_sessions"("external_bot_id");

-- CreateIndex
CREATE INDEX "engagement_tasks_tenant_client_status_idx" ON "engagement_tasks"("tenant_id", "client_id", "status");

-- CreateIndex
CREATE INDEX "engagement_tasks_tenant_due_idx" ON "engagement_tasks"("tenant_id", "due_date");

-- CreateIndex
CREATE INDEX "engagement_report_targets_tenant_client_prep_idx" ON "engagement_report_target_offices"("tenant_id", "client_id", "prep_status");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_report_targets_tenant_scope_office_key" ON "engagement_report_target_offices"("tenant_id", "scope_key", "office_key");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_report_targets_id_tenant_key" ON "engagement_report_target_offices"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "engagement_report_overrides_tenant_year_idx" ON "engagement_report_target_overrides"("tenant_id", "report_year");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_report_overrides_target_year_key" ON "engagement_report_target_overrides"("target_id", "report_year");

-- CreateIndex
CREATE INDEX "outreach_records_tenant_type_status_created_idx" ON "outreach_records"("tenant_id", "type", "status", "created_at");

-- CreateIndex
CREATE INDEX "outreach_records_tenant_client_created_idx" ON "outreach_records"("tenant_id", "client_id", "created_at");

-- CreateIndex
CREATE INDEX "outreach_records_tenant_meeting_idx" ON "outreach_records"("tenant_id", "meeting_id");

-- CreateIndex
CREATE INDEX "outreach_records_tenant_deleted_created_idx" ON "outreach_records"("tenant_id", "deleted_at", "created_at");

-- CreateIndex
CREATE INDEX "outreach_templates_tenant_user_type_updated_idx" ON "outreach_templates"("tenant_id", "created_by_user_id", "type", "updated_at");

-- CreateIndex
CREATE INDEX "outreach_audiences_tenant_user_kind_name_idx" ON "outreach_audiences"("tenant_id", "created_by_user_id", "kind", "name");

-- CreateIndex
CREATE INDEX "outreach_audience_members_tenant_audience_idx" ON "outreach_audience_members"("tenant_id", "audience_id");

-- CreateIndex
CREATE INDEX "outreach_ai_templates_tenant_user_cat_idx" ON "outreach_ai_template"("tenant_id", "user_id", "category", "updated_at");

-- CreateIndex
CREATE INDEX "association_overrides_entity_idx" ON "client_association_overrides"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "association_overrides_client_created_idx" ON "client_association_overrides"("tenant_id", "client_id", "created_at");

-- CreateIndex
CREATE INDEX "context_embeddings_tenant_client_idx" ON "context_embeddings"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "context_embeddings_source_idx" ON "context_embeddings"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "context_embeddings_unique" ON "context_embeddings"("tenant_id", "source_type", "source_id", "model");

-- CreateIndex
CREATE INDEX "impersonation_sessions_actor_active_idx" ON "impersonation_sessions"("actor_user_id", "expires_at");

-- CreateIndex
CREATE INDEX "demo_requests_created_idx" ON "demo_requests"("created_at" DESC);

-- CreateIndex
CREATE INDEX "demo_requests_email_created_idx" ON "demo_requests"("email", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_conversations_tenant_user_updated_idx" ON "clio_conversations"("tenant_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "clio_conversations_tenant_client_updated_idx" ON "clio_conversations"("tenant_id", "client_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "clio_conversations_tenant_user_workspace_updated_idx" ON "clio_conversations"("tenant_id", "user_id", "workspace_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "meri_saved_prompts_tenant_user_updated_idx" ON "meri_saved_prompts"("tenant_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "meri_workspaces_tenant_user_updated_idx" ON "meri_workspaces"("tenant_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "meri_workspaces_tenant_user_client_idx" ON "meri_workspaces"("tenant_id", "user_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "meri_vnext_preferences_tenant_user_unique" ON "meri_vnext_preferences"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "clio_messages_tenant_user_created_idx" ON "clio_messages"("tenant_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "clio_messages_conversation_created_idx" ON "clio_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "clio_artifacts_tenant_user_created_idx" ON "clio_artifacts"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_artifacts_conversation_created_idx" ON "clio_artifacts"("conversation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_attachments_tenant_user_created_idx" ON "clio_attachments"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_attachments_message_idx" ON "clio_attachments"("message_id");

-- CreateIndex
CREATE INDEX "clio_research_sessions_tenant_user_updated_idx" ON "clio_research_sessions"("tenant_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "clio_research_sessions_tenant_client_updated_idx" ON "clio_research_sessions"("tenant_id", "client_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "clio_research_sessions_tenant_user_kind_updated_idx" ON "clio_research_sessions"("tenant_id", "user_id", "kind", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "clio_notes_tenant_user_created_idx" ON "clio_notes"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_notes_tenant_client_created_idx" ON "clio_notes"("tenant_id", "client_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_notes_conversation_created_idx" ON "clio_notes"("conversation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_memory_scope_owner_updated_idx" ON "clio_memory"("tenant_id", "scope", "owner_user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "clio_memory_scope_updated_idx" ON "clio_memory"("tenant_id", "scope", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "clio_memory_tenant_scope_owner_key_uniq" ON "clio_memory"("tenant_id", "scope", "owner_user_id", "key");

-- CreateIndex
CREATE INDEX "meri_action_approval_user_created_idx" ON "meri_action_approval"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "meri_action_approval_tenant_user_fp_uniq" ON "meri_action_approval"("tenant_id", "user_id", "fingerprint");

-- CreateIndex
CREATE INDEX "meri_pending_action_user_created_idx" ON "meri_pending_action"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "meri_pending_action_tenant_user_fp_uniq" ON "meri_pending_action"("tenant_id", "user_id", "fingerprint");

-- CreateIndex
CREATE INDEX "meri_action_proposal_user_status_created_idx" ON "meri_action_proposals"("tenant_id", "user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "meri_action_proposal_conversation_status_idx" ON "meri_action_proposals"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "meri_action_proposal_expiry_status_idx" ON "meri_action_proposals"("expires_at", "status");

-- CreateIndex
CREATE INDEX "meri_action_proposal_tenant_fingerprint_idx" ON "meri_action_proposals"("tenant_id", "fingerprint");

-- CreateIndex
CREATE INDEX "meri_action_proposals_policy_pack_idx" ON "meri_action_proposals"("tenant_id", "policy_pack_key", "policy_pack_version");

-- CreateIndex
CREATE INDEX "meri_action_proposals_policy_decision_idx" ON "meri_action_proposals"("tenant_id", "policy_decision_hash");

-- CreateIndex
CREATE INDEX "clio_scheduled_task_tenant_owner_idx" ON "clio_scheduled_task"("tenant_id", "owner_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_scheduled_task_due_idx" ON "clio_scheduled_task"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "clio_mcp_servers_tenant_enabled_idx" ON "clio_mcp_servers"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "clio_mcp_servers_tenant_owner_enabled_idx" ON "clio_mcp_servers"("tenant_id", "owner_user_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "clio_mcp_servers_tenant_owner_name_unique" ON "clio_mcp_servers"("tenant_id", "owner_user_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "clio_mcp_oauth_credentials_server_id_key" ON "clio_mcp_oauth_credentials"("server_id");

-- CreateIndex
CREATE INDEX "clio_mcp_oauth_credentials_tenant_idx" ON "clio_mcp_oauth_credentials"("tenant_id");

-- CreateIndex
CREATE INDEX "clio_firm_skills_tenant_enabled_idx" ON "clio_firm_skills"("tenant_id", "enabled", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "clio_firm_skills_tenant_skill_unique" ON "clio_firm_skills"("tenant_id", "skill_id");

-- CreateIndex
CREATE INDEX "ai_usage_events_tenant_created_idx" ON "ai_usage_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_run_workflow_created_idx" ON "ai_run"("workflow", "created_at");

-- CreateIndex
CREATE INDEX "ai_run_subject_idx" ON "ai_run"("subject_type", "subject_key");

-- CreateIndex
CREATE INDEX "ai_run_tenant_created_idx" ON "ai_run"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_run_targeting_guard_idx" ON "ai_run"("workflow", "subject_key", "tenant_id", "client_id", "created_at");

-- CreateIndex
CREATE INDEX "meri_audit_ledger_tenant_created_idx" ON "meri_audit_ledger"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "meri_audit_ledger_surface_severity_idx" ON "meri_audit_ledger"("surface", "top_severity", "created_at" DESC);

-- CreateIndex
CREATE INDEX "meri_audit_ledger_tenant_client_alert_idx" ON "meri_audit_ledger"("tenant_id", "client_id", "alert_id", "decision", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "meri_audit_ledger_subject_mode_key" ON "meri_audit_ledger"("tenant_id", "subject_type", "subject_id", "mode");

-- CreateIndex
CREATE INDEX "review_request_tenant_status_idx" ON "review_request"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "review_request_assigned_idx" ON "review_request"("tenant_id", "assigned_to", "status");

-- CreateIndex
CREATE INDEX "review_request_subject_idx" ON "review_request"("tenant_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "alert_generation_record_tenant_client_alert_idx" ON "alert_generation_record"("tenant_id", "client_id", "alert_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "outcome_event_tenant_observed_idx" ON "outcome_event"("tenant_id", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "outcome_event_tenant_client_idx" ON "outcome_event"("tenant_id", "client_id", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "outcome_event_source_idx" ON "outcome_event"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "context_packet_tenant_created_idx" ON "context_packet"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "context_packet_tenant_surface_idx" ON "context_packet"("tenant_id", "surface", "created_at" DESC);

-- CreateIndex
CREATE INDEX "context_packet_tenant_version_created_idx" ON "context_packet"("tenant_id", "packet_version", "created_at" DESC);

-- CreateIndex
CREATE INDEX "outreach_jobs_status_created_idx" ON "outreach_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "outreach_jobs_tenant_user_status_idx" ON "outreach_jobs"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_jobs_tenant_user_request_key" ON "outreach_jobs"("tenant_id", "user_id", "request_key");

-- CreateIndex
CREATE INDEX "outreach_job_items_job_status_idx" ON "outreach_job_items"("job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_job_items_job_recipient" ON "outreach_job_items"("job_id", "recipient_key");

-- CreateIndex
CREATE INDEX "outreach_draft_artifacts_tenant_record_idx" ON "outreach_draft_artifacts"("tenant_id", "outreach_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_draft_artifacts_tenant_record_genkey" ON "outreach_draft_artifacts"("tenant_id", "outreach_record_id", "generation_key");

-- CreateIndex
CREATE INDEX "outreach_draft_versions_tenant_audit_approval_idx" ON "outreach_draft_versions"("tenant_id", "audit_status", "approval_status");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_draft_versions_artifact_version" ON "outreach_draft_versions"("artifact_id", "version");

-- CreateIndex
CREATE INDEX "outreach_send_intents_status_created_idx" ON "outreach_send_intents"("status", "created_at");

-- CreateIndex
CREATE INDEX "outreach_send_intents_tenant_record_idx" ON "outreach_send_intents"("tenant_id", "outreach_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_send_intents_tenant_user_request_key" ON "outreach_send_intents"("tenant_id", "user_id", "request_key");

-- CreateIndex
CREATE INDEX "outreach_deliveries_intent_status_idx" ON "outreach_deliveries"("send_intent_id", "status");

-- CreateIndex
CREATE INDEX "outreach_deliveries_tenant_correlation_idx" ON "outreach_deliveries"("tenant_id", "correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_deliveries_tenant_idempotency_key" ON "outreach_deliveries"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_ai_credentials_tenant_provider_key" ON "tenant_ai_credentials"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "clio_proactive_alerts_tenant_id_status_created_at_idx" ON "clio_proactive_alerts"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_proactive_alerts_tenant_id_client_id_created_at_idx" ON "clio_proactive_alerts"("tenant_id", "client_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "clio_proactive_alerts_tenant_id_owner_user_id_status_create_idx" ON "clio_proactive_alerts"("tenant_id", "owner_user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_occurred_idx" ON "audit_logs"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_action_idx" ON "audit_logs"("tenant_id", "action");

-- CreateIndex
CREATE INDEX "client_capabilities_tenant_client_idx" ON "client_capabilities"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "client_submission_history_tenant_client_cap_idx" ON "client_submission_history"("tenant_id", "client_id", "capability_id");

-- CreateIndex
CREATE INDEX "client_people_tenant_client_idx" ON "client_people"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "client_people_tenant_client_email_idx" ON "client_people"("tenant_id", "client_id", "email");

-- CreateIndex
CREATE INDEX "client_activity_timeline_idx" ON "client_activity"("tenant_id", "client_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "client_activity_kind_idx" ON "client_activity"("tenant_id", "client_id", "kind", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "client_facilities_tenant_client_idx" ON "client_facilities"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "client_facilities_district_idx" ON "client_facilities"("state", "congressional_district");

-- CreateIndex
CREATE INDEX "client_facilities_state_house_idx" ON "client_facilities"("state", "state_house_district");

-- CreateIndex
CREATE INDEX "client_facilities_state_senate_idx" ON "client_facilities"("state", "state_senate_district");

-- CreateIndex
CREATE INDEX "client_targets_tenant_client_idx" ON "client_targets"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_targets_client_member_key" ON "client_targets"("client_id", "member_id");

-- CreateIndex
CREATE INDEX "client_target_recommendations_tenant_client_idx" ON "client_target_recommendations"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_target_recommendations_client_key" ON "client_target_recommendations"("client_id");

-- CreateIndex
CREATE INDEX "client_capability_fit_recommendations_tenant_client_idx" ON "client_capability_fit_recommendations"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_capability_fit_recommendations_client_key" ON "client_capability_fit_recommendations"("client_id");

-- CreateIndex
CREATE INDEX "action_recommendation_tenant_status_deadline_idx" ON "action_recommendation"("tenant_id", "status", "deadline");

-- CreateIndex
CREATE INDEX "action_recommendation_tenant_client_idx" ON "action_recommendation"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "action_recommendation_tenant_client_district_idx" ON "action_recommendation"("tenant_id", "client_id", "district_key");

-- CreateIndex
CREATE INDEX "engagement_campaigns_tenant_client_status_idx" ON "engagement_campaigns"("tenant_id", "client_id", "status");

-- CreateIndex
CREATE INDEX "engagement_campaign_recipients_tenant_campaign_idx" ON "engagement_campaign_recipients"("tenant_id", "campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "lobby_intel_slug_key" ON "lobby_intel"("slug");

-- CreateIndex
CREATE INDEX "lobby_intel_name_idx" ON "lobby_intel"("name");

-- CreateIndex
CREATE INDEX "lobby_intel_slug_idx" ON "lobby_intel"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "lobby_trending_topics_word_key" ON "lobby_trending_topics"("word");

-- CreateIndex
CREATE INDEX "lobby_trending_kind_growth_idx" ON "lobby_trending_topics"("kind", "growth_pct");

-- CreateIndex
CREATE UNIQUE INDEX "federal_contractor_name_key" ON "federal_contractor"("name");

-- CreateIndex
CREATE INDEX "federal_contractor_name_idx" ON "federal_contractor"("name");

-- CreateIndex
CREATE INDEX "federal_contractor_uei_idx" ON "federal_contractor"("uei");

-- CreateIndex
CREATE INDEX "federal_agency_name_idx" ON "federal_agency"("name");

-- CreateIndex
CREATE UNIQUE INDEX "lda_filing_filing_uuid_key" ON "lda_filing"("filing_uuid");

-- CreateIndex
CREATE INDEX "lda_filing_year_idx" ON "lda_filing"("filing_year");

-- CreateIndex
CREATE INDEX "lda_filing_dt_posted_idx" ON "lda_filing"("dt_posted");

-- CreateIndex
CREATE INDEX "lda_filing_client_id_idx" ON "lda_filing"("client_id");

-- CreateIndex
CREATE INDEX "lda_filing_registrant_id_idx" ON "lda_filing"("registrant_id");

-- CreateIndex
CREATE INDEX "lda_filing_client_name_idx" ON "lda_filing"("client_name");

-- CreateIndex
CREATE INDEX "lda_filing_registrant_name_idx" ON "lda_filing"("registrant_name");

-- CreateIndex
CREATE INDEX "lda_client_name_idx" ON "lda_client"("name");

-- CreateIndex
CREATE INDEX "lda_client_state_idx" ON "lda_client"("state");

-- CreateIndex
CREATE INDEX "lda_registrant_name_idx" ON "lda_registrant"("name");

-- CreateIndex
CREATE INDEX "lda_lobbyist_name_idx" ON "lda_lobbyist"("last_name", "first_name");

-- CreateIndex
CREATE UNIQUE INDEX "lda_contribution_filing_uuid_key" ON "lda_contribution"("filing_uuid");

-- CreateIndex
CREATE INDEX "lda_contribution_year_idx" ON "lda_contribution"("filing_year");

-- CreateIndex
CREATE INDEX "lda_contribution_registrant_id_idx" ON "lda_contribution"("registrant_id");

-- CreateIndex
CREATE INDEX "meri_analytics_query_log_created_at_idx" ON "meri_analytics_query_log"("created_at");

-- CreateIndex
CREATE INDEX "meri_analytics_query_log_tenant_id_idx" ON "meri_analytics_query_log"("tenant_id");

-- CreateIndex
CREATE INDEX "fec_committee_name_idx" ON "fec_committee"("name");

-- CreateIndex
CREATE INDEX "fec_contribution_committee_id_idx" ON "fec_contribution"("committee_id");

-- CreateIndex
CREATE INDEX "fec_contribution_candidate_name_idx" ON "fec_contribution"("candidate_name");

-- CreateIndex
CREATE INDEX "fec_contribution_employer_idx" ON "fec_contribution"("contributor_employer");

-- CreateIndex
CREATE INDEX "fec_contribution_cycle_idx" ON "fec_contribution"("cycle");

-- CreateIndex
CREATE UNIQUE INDEX "fec_contribution_dedup_key" ON "fec_contribution"("committee_id", "candidate_name", "contributor_employer", "amount", "cycle");

-- CreateIndex
CREATE INDEX "fec_pac_contribution_committee_id_idx" ON "fec_pac_contribution"("committee_id");

-- CreateIndex
CREATE INDEX "fec_pac_contribution_candidate_name_idx" ON "fec_pac_contribution"("candidate_name");

-- CreateIndex
CREATE INDEX "fec_pac_contribution_cycle_idx" ON "fec_pac_contribution"("cycle");

-- CreateIndex
CREATE UNIQUE INDEX "fec_pac_contribution_source_key" ON "fec_pac_contribution"("committee_id", "cycle", "source_sub_id");

-- CreateIndex
CREATE INDEX "congress_bill_congress_idx" ON "congress_bill"("congress");

-- CreateIndex
CREATE INDEX "congress_bill_policy_area_idx" ON "congress_bill"("policy_area");

-- CreateIndex
CREATE INDEX "congress_bill_pe_codes_gin_idx" ON "congress_bill" USING GIN ("pe_codes");

-- CreateIndex
CREATE INDEX "congress_bill_sponsor_bioguide_idx" ON "congress_bill"("sponsor_bioguide_id");

-- CreateIndex
CREATE INDEX "congress_bill_status_idx" ON "congress_bill"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cbo_cost_estimate_cbo_url_key" ON "cbo_cost_estimate"("cbo_url");

-- CreateIndex
CREATE INDEX "cbo_cost_estimate_bill_id_idx" ON "cbo_cost_estimate"("bill_id");

-- CreateIndex
CREATE INDEX "cbo_cost_estimate_pub_date_idx" ON "cbo_cost_estimate"("pub_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "congress_member_lis_id_key" ON "congress_member"("lis_id");

-- CreateIndex
CREATE INDEX "congress_member_chamber_state_idx" ON "congress_member"("chamber", "state");

-- CreateIndex
CREATE INDEX "congress_member_last_name_idx" ON "congress_member"("last_name");

-- CreateIndex
CREATE INDEX "congress_member_is_current_idx" ON "congress_member"("is_current");

-- CreateIndex
CREATE INDEX "congress_bill_cosponsor_bioguide_id_idx" ON "congress_bill_cosponsor"("bioguide_id");

-- CreateIndex
CREATE UNIQUE INDEX "congress_bill_cosponsor_bill_id_bioguide_id_key" ON "congress_bill_cosponsor"("bill_id", "bioguide_id");

-- CreateIndex
CREATE INDEX "congress_committee_chamber_idx" ON "congress_committee"("chamber");

-- CreateIndex
CREATE INDEX "congress_committee_parent_system_code_idx" ON "congress_committee"("parent_system_code");

-- CreateIndex
CREATE INDEX "congress_committee_url_source_idx" ON "congress_committee"("url_source");

-- CreateIndex
CREATE INDEX "congress_committee_membership_bioguide_id_idx" ON "congress_committee_membership"("bioguide_id");

-- CreateIndex
CREATE UNIQUE INDEX "congress_committee_membership_system_code_bioguide_id_key" ON "congress_committee_membership"("system_code", "bioguide_id");

-- CreateIndex
CREATE INDEX "entity_crosswalk_entity_type_entity_key_idx" ON "entity_crosswalk"("entity_type", "entity_key");

-- CreateIndex
CREATE UNIQUE INDEX "entity_crosswalk_id_type_id_value_key" ON "entity_crosswalk"("id_type", "id_value");

-- CreateIndex
CREATE INDEX "roll_call_vote_bill_id_idx" ON "roll_call_vote"("bill_id");

-- CreateIndex
CREATE INDEX "roll_call_vote_chamber_congress_session_idx" ON "roll_call_vote"("chamber", "congress", "session");

-- CreateIndex
CREATE INDEX "roll_call_vote_vote_date_idx" ON "roll_call_vote"("vote_date" DESC);

-- CreateIndex
CREATE INDEX "member_vote_bioguide_id_idx" ON "member_vote"("bioguide_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_vote_vote_id_member_key_key" ON "member_vote"("vote_id", "member_key");

-- CreateIndex
CREATE INDEX "bill_rule_link_target_bill_id_idx" ON "bill_rule_link"("target_bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_rule_link_rule_bill_id_target_bill_id_key" ON "bill_rule_link"("rule_bill_id", "target_bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_text_bill_id_key" ON "bill_text"("bill_id");

-- CreateIndex
CREATE INDEX "federal_evidence_revision_bill_idx" ON "federal_evidence_revision"("bill_id", "fetched_at" DESC);

-- CreateIndex
CREATE INDEX "federal_evidence_revision_package_idx" ON "federal_evidence_revision"("package_id", "fetched_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "federal_evidence_revision_identity_key" ON "federal_evidence_revision"("source_key", "content_hash", "extraction_hash", "parser_version");

-- CreateIndex
CREATE INDEX "federal_evidence_passage_tsv_idx" ON "federal_evidence_passage" USING GIN ("tsv");

-- CreateIndex
CREATE UNIQUE INDEX "federal_evidence_observation_key_key" ON "federal_evidence_observation"("observation_key");

-- CreateIndex
CREATE INDEX "federal_evidence_observation_current_idx" ON "federal_evidence_observation"("source_key", "id" DESC);

-- CreateIndex
CREATE INDEX "federal_evidence_mention_pending_idx" ON "federal_evidence_mention"("qualification_state", "raw_mention");

-- CreateIndex
CREATE INDEX "federal_evidence_mention_pe_idx" ON "federal_evidence_mention"("canonical_pe_code", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "federal_evidence_mention_revision_candidate_key" ON "federal_evidence_mention"("revision_id", "candidate_key", "matcher_version");

-- CreateIndex
CREATE UNIQUE INDEX "federal_evidence_mention_event_key_key" ON "federal_evidence_mention_event"("event_key");

-- CreateIndex
CREATE INDEX "federal_evidence_mention_event_source_idx" ON "federal_evidence_mention_event"("source_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "federal_evidence_mention_event_pe_idx" ON "federal_evidence_mention_event"("canonical_pe_code", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "federal_evidence_change_outbox_event_key" ON "federal_evidence_change_outbox"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "federal_evidence_change_outbox_dedupe_key" ON "federal_evidence_change_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "federal_evidence_change_outbox_ready_idx" ON "federal_evidence_change_outbox"("status", "available_at", "created_at");

-- CreateIndex
CREATE INDEX "federal_evidence_inventory_member_last_seen_idx" ON "federal_evidence_inventory_member"("inventory_source", "last_seen_window_end");

-- CreateIndex
CREATE INDEX "federal_evidence_coverage_gap_open_idx" ON "federal_evidence_coverage_gap"("collection", "resolved_at", "last_observed_at" DESC);

-- CreateIndex
CREATE INDEX "congress_bill_action_bill_id_date_idx" ON "congress_bill_action"("bill_id", "date");

-- CreateIndex
CREATE INDEX "congress_bill_committee_bill_id_idx" ON "congress_bill_committee"("bill_id");

-- CreateIndex
CREATE INDEX "congress_bill_committee_committee_code_idx" ON "congress_bill_committee"("committee_code");

-- CreateIndex
CREATE INDEX "congress_bill_subject_bill_id_idx" ON "congress_bill_subject"("bill_id");

-- CreateIndex
CREATE INDEX "congress_bill_subject_name_idx" ON "congress_bill_subject"("name");

-- CreateIndex
CREATE INDEX "program_element_service_code_idx" ON "program_element"("service_code");

-- CreateIndex
CREATE INDEX "program_element_appropriation_type_idx" ON "program_element"("appropriation_type");

-- CreateIndex
CREATE INDEX "program_element_status_idx" ON "program_element"("status");

-- CreateIndex
CREATE INDEX "program_element_retired_at_idx" ON "program_element"("retired_at");

-- CreateIndex
CREATE INDEX "program_element_source_pe_code_idx" ON "program_element_source"("pe_code");

-- CreateIndex
CREATE INDEX "program_element_source_pe_fy_idx" ON "program_element_source"("pe_code", "fy");

-- CreateIndex
CREATE INDEX "program_element_source_doc_type_idx" ON "program_element_source"("doc_type");

-- CreateIndex
CREATE INDEX "program_element_source_source_document_idx" ON "program_element_source"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_source_pe_doc_url_page_key" ON "program_element_source"("pe_code", "doc_type", "source_url", "page_number");

-- CreateIndex
CREATE INDEX "program_element_project_pe_code_idx" ON "program_element_project"("pe_code");

-- CreateIndex
CREATE INDEX "program_element_project_source_document_idx" ON "program_element_project"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_project_pe_code_project_key" ON "program_element_project"("pe_code", "project_code");

-- CreateIndex
CREATE INDEX "program_element_year_fy_idx" ON "program_element_year"("fy");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_year_pe_code_fy_key" ON "program_element_year"("pe_code", "fy");

-- CreateIndex
CREATE INDEX "procurement_line_line_item_number_idx" ON "procurement_line"("line_item_number");

-- CreateIndex
CREATE INDEX "procurement_line_component_idx" ON "procurement_line"("component");

-- CreateIndex
CREATE INDEX "procurement_line_related_pe_code_idx" ON "procurement_line"("related_pe_code");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_line_appropriation_line_item_key" ON "procurement_line"("appropriation_code", "line_item_number");

-- CreateIndex
CREATE INDEX "procurement_line_year_fy_idx" ON "procurement_line_year"("fy");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_line_year_line_fy_subline_key" ON "procurement_line_year"("line_id", "fy", "subline_key");

-- CreateIndex
CREATE INDEX "procurement_line_source_line_idx" ON "procurement_line_source"("line_id");

-- CreateIndex
CREATE INDEX "procurement_line_source_line_fy_idx" ON "procurement_line_source"("line_id", "fy");

-- CreateIndex
CREATE INDEX "procurement_line_source_year_idx" ON "procurement_line_source"("year_id");

-- CreateIndex
CREATE INDEX "procurement_line_source_source_document_idx" ON "procurement_line_source"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_line_source_line_span_hash_key" ON "procurement_line_source"("line_id", "source_span_hash");

-- CreateIndex
CREATE INDEX "program_element_budget_position_pe_fy_idx" ON "program_element_budget_position"("pe_code", "asserted_fy");

-- CreateIndex
CREATE INDEX "program_element_budget_position_cycle_idx" ON "program_element_budget_position"("position_cycle");

-- CreateIndex
CREATE INDEX "program_element_budget_position_source_document_idx" ON "program_element_budget_position"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_budget_position_natural_key" ON "program_element_budget_position"("pe_code", "position_cycle", "asserted_fy", "value_kind");

-- CreateIndex
CREATE INDEX "program_element_project_budget_position_pe_project_idx" ON "program_element_project_budget_position"("pe_code", "project_code");

-- CreateIndex
CREATE INDEX "program_element_project_budget_position_pe_fy_idx" ON "program_element_project_budget_position"("pe_code", "asserted_fy");

-- CreateIndex
CREATE INDEX "program_element_project_budget_position_cycle_idx" ON "program_element_project_budget_position"("position_cycle");

-- CreateIndex
CREATE INDEX "program_element_project_budget_position_source_document_idx" ON "program_element_project_budget_position"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_project_budget_position_natural_key" ON "program_element_project_budget_position"("pe_code", "project_code", "position_cycle", "asserted_fy", "value_kind");

-- CreateIndex
CREATE INDEX "program_element_delta_natural_key_idx" ON "program_element_delta"("pe_code", "asserted_fy", "delta_type", "from_ref", "to_ref");

-- CreateIndex
CREATE INDEX "program_element_delta_pe_fy_idx" ON "program_element_delta"("pe_code", "asserted_fy");

-- CreateIndex
CREATE INDEX "program_element_delta_type_idx" ON "program_element_delta"("delta_type");

-- CreateIndex
CREATE INDEX "program_element_delta_score_idx" ON "program_element_delta"("materiality_score" DESC);

-- CreateIndex
CREATE INDEX "program_element_delta_superseded_idx" ON "program_element_delta"("superseded_at");

-- CreateIndex
CREATE INDEX "program_element_milestone_status_idx" ON "program_element_milestone"("status");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_milestone_pe_code_type_key" ON "program_element_milestone"("pe_code", "milestone_type");

-- CreateIndex
CREATE INDEX "program_element_milestone_schedule_period_pe_type_idx" ON "program_element_milestone_schedule_period"("pe_code", "milestone_type");

-- CreateIndex
CREATE INDEX "program_element_milestone_schedule_period_kind_idx" ON "program_element_milestone_schedule_period"("period_kind");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_milestone_schedule_period_natural_key" ON "program_element_milestone_schedule_period"("milestone_id", "period_role", "rawText");

-- CreateIndex
CREATE INDEX "program_element_ingest_run_source_idx" ON "program_element_ingest_run"("source");

-- CreateIndex
CREATE INDEX "program_element_ingest_run_fy_idx" ON "program_element_ingest_run"("fy");

-- CreateIndex
CREATE INDEX "program_element_ingest_run_created_idx" ON "program_element_ingest_run"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "program_element_year_source_value_observation_key_key" ON "program_element_year_source_value"("observation_key");

-- CreateIndex
CREATE INDEX "program_element_year_source_value_lookup_idx" ON "program_element_year_source_value"("pe_code", "fy", "field_name");

-- CreateIndex
CREATE INDEX "program_element_year_source_value_winner_idx" ON "program_element_year_source_value"("pe_code", "fy", "field_name", "is_winner");

-- CreateIndex
CREATE INDEX "program_element_year_source_value_source_document_idx" ON "program_element_year_source_value"("source_document_id");

-- CreateIndex
CREATE INDEX "program_element_year_source_value_parse_job_idx" ON "program_element_year_source_value"("parse_job_id");

-- CreateIndex
CREATE INDEX "program_element_year_source_value_document_field_idx" ON "program_element_year_source_value"("source_document_id", "field_name");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_change_outbox_dedupe_key_key" ON "program_element_change_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "program_element_change_outbox_status_created_idx" ON "program_element_change_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "source_document_type_fy_cycle_component_idx" ON "source_document"("document_type", "fiscal_year", "budget_cycle", "component");

-- CreateIndex
CREATE INDEX "source_document_source_key_idx" ON "source_document"("source_key");

-- CreateIndex
CREATE INDEX "source_document_archive_version_idx" ON "source_document"("archive_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_document_source_key_sha256_key" ON "source_document"("source_key", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "community_funding_request_identity_hash_key" ON "community_funding_request"("identity_hash");

-- CreateIndex
CREATE INDEX "community_funding_request_fy_chamber_idx" ON "community_funding_request"("fiscal_year", "chamber");

-- CreateIndex
CREATE INDEX "community_funding_request_recipient_idx" ON "community_funding_request"("recipient_normalized");

-- CreateIndex
CREATE INDEX "community_funding_request_source_request_idx" ON "community_funding_request_source"("request_id");

-- CreateIndex
CREATE INDEX "community_funding_request_source_document_idx" ON "community_funding_request_source"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_funding_request_source_occurrence_key" ON "community_funding_request_source"("request_id", "source_document_id", "source_page", "source_row");

-- CreateIndex
CREATE INDEX "cfdc_adapter_started_idx" ON "community_funding_discovery_crawl"("adapter_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "cfdc_run_key_idx" ON "community_funding_discovery_crawl"("run_key");

-- CreateIndex
CREATE INDEX "cfdcand_crawl_idx" ON "community_funding_discovery_candidate"("crawl_id");

-- CreateIndex
CREATE UNIQUE INDEX "cfdcand_run_url_uidx" ON "community_funding_discovery_candidate"("adapter_id", "run_key", "candidate_url");

-- CreateIndex
CREATE INDEX "community_funding_ingest_run_unit_idx" ON "community_funding_ingest_run"("chamber", "fiscal_year");

-- CreateIndex
CREATE INDEX "community_funding_ingest_run_sha_idx" ON "community_funding_ingest_run"("artifact_sha256");

-- CreateIndex
CREATE INDEX "document_parse_job_source_document_idx" ON "document_parse_job"("source_document_id");

-- CreateIndex
CREATE INDEX "document_parse_job_status_idx" ON "document_parse_job"("status");

-- CreateIndex
CREATE INDEX "document_parse_job_provider_job_idx" ON "document_parse_job"("provider_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_parse_job_dedup_key" ON "document_parse_job"("source_document_id", "input_sha256", "provider", "page_start", "page_end");

-- CreateIndex
CREATE INDEX "reconciliation_review_queue_status_idx" ON "reconciliation_review_queue"("status", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "reconciliation_review_queue_pe_fy_idx" ON "reconciliation_review_queue"("pe_code", "fy");

-- CreateIndex
CREATE INDEX "program_element_watch_tenant_pe_code_idx" ON "program_element_watch"("tenant_id", "pe_code");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_watch_user_pe_code_key" ON "program_element_watch"("user_id", "pe_code");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_watch_tenant_user_pe_code_key" ON "program_element_watch"("tenant_id", "user_id", "pe_code");

-- CreateIndex
CREATE INDEX "defense_budget_client_watch_client_idx" ON "defense_budget_client_watch"("tenant_id", "client_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_client_watch_target_key" ON "defense_budget_client_watch"("tenant_id", "client_id", "target_type", "target_key");

-- CreateIndex
CREATE INDEX "defense_budget_client_watch_event_client_idx" ON "defense_budget_client_watch_event"("tenant_id", "client_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "defense_budget_client_watch_event_update_idx" ON "defense_budget_client_watch_event"("tenant_id", "client_id", "update_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_client_watch_event_logical_key" ON "defense_budget_client_watch_event"("watch_id", "logical_event_key");

-- CreateIndex
CREATE INDEX "program_element_data_issue_tenant_status_created_idx" ON "program_element_data_issue"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "program_element_data_issue_pe_fy_idx" ON "program_element_data_issue"("pe_code", "fy");

-- CreateIndex
CREATE INDEX "pe_alert_email_pref_tenant_idx" ON "pe_alert_email_pref"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "pe_alert_email_pref_user_tenant_key" ON "pe_alert_email_pref"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "acquisition_personnel_pe_primary_idx" ON "acquisition_personnel"("pe_primary");

-- CreateIndex
CREATE INDEX "acquisition_personnel_name_key_idx" ON "acquisition_personnel"("name_key");

-- CreateIndex
CREATE INDEX "acquisition_personnel_service_org_idx" ON "acquisition_personnel"("service", "organization");

-- CreateIndex
CREATE INDEX "acquisition_personnel_status_idx" ON "acquisition_personnel"("status");

-- CreateIndex
CREATE INDEX "acquisition_personnel_superseded_at_idx" ON "acquisition_personnel"("superseded_at");

-- CreateIndex
CREATE INDEX "acquisition_personnel_source_person_observed_idx" ON "acquisition_personnel_source"("person_id", "observed_at");

-- CreateIndex
CREATE INDEX "acquisition_personnel_source_source_idx" ON "acquisition_personnel_source"("source");

-- CreateIndex
CREATE INDEX "acquisition_personnel_merge_candidate_status_idx" ON "acquisition_personnel_merge_candidate"("status");

-- CreateIndex
CREATE INDEX "program_element_person_candidate_status_idx" ON "program_element_person_candidate"("status");

-- CreateIndex
CREATE INDEX "program_element_person_candidate_pe_code_idx" ON "program_element_person_candidate"("pe_code");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_person_candidate_person_pe_key" ON "program_element_person_candidate"("person_id", "pe_code");

-- CreateIndex
CREATE INDEX "conference_probability_fy_idx" ON "conference_probability"("fy");

-- CreateIndex
CREATE INDEX "conference_probability_model_version_idx" ON "conference_probability"("model_version");

-- CreateIndex
CREATE UNIQUE INDEX "federal_register_document_document_number_key" ON "federal_register_document"("document_number");

-- CreateIndex
CREATE INDEX "federal_register_document_type_publication_date_idx" ON "federal_register_document"("type", "publication_date");

-- CreateIndex
CREATE INDEX "federal_register_document_comment_end_date_idx" ON "federal_register_document"("comment_end_date");

-- CreateIndex
CREATE INDEX "federal_register_document_type_effective_date_idx" ON "federal_register_document"("type", "effective_date");

-- CreateIndex
CREATE INDEX "intelligence_insight_category_generated_at_idx" ON "intelligence_insight"("category", "generated_at");

-- CreateIndex
CREATE INDEX "intelligence_insight_tenant_id_category_generated_at_idx" ON "intelligence_insight"("tenant_id", "category", "generated_at");

-- CreateIndex
CREATE INDEX "client_intel_mapping_client_id_idx" ON "client_intel_mapping"("client_id");

-- CreateIndex
CREATE INDEX "client_intel_mapping_tenant_id_idx" ON "client_intel_mapping"("tenant_id");

-- CreateIndex
CREATE INDEX "client_intel_mapping_source_external_id_idx" ON "client_intel_mapping"("source", "external_id");

-- CreateIndex
CREATE INDEX "client_intel_mapping_tenant_source_review_idx" ON "client_intel_mapping"("tenant_id", "source", "review_status");

-- CreateIndex
CREATE UNIQUE INDEX "client_intel_mapping_client_id_source_external_id_key" ON "client_intel_mapping"("client_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "tracked_bill_tenant_id_idx" ON "tracked_bill"("tenant_id");

-- CreateIndex
CREATE INDEX "tracked_bill_client_id_idx" ON "tracked_bill"("client_id");

-- CreateIndex
CREATE INDEX "tracked_bill_bill_id_idx" ON "tracked_bill"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracked_bill_client_id_bill_id_key" ON "tracked_bill"("client_id", "bill_id");

-- CreateIndex
CREATE INDEX "alert_state_tenant_id_idx" ON "alert_state"("tenant_id");

-- CreateIndex
CREATE INDEX "alert_state_client_id_idx" ON "alert_state"("client_id");

-- CreateIndex
CREATE INDEX "alert_state_user_id_idx" ON "alert_state"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_state_user_id_client_id_alert_id_key" ON "alert_state"("user_id", "client_id", "alert_id");

-- CreateIndex
CREATE INDEX "client_brief_tenant_id_idx" ON "client_brief"("tenant_id");

-- CreateIndex
CREATE INDEX "client_brief_client_id_idx" ON "client_brief"("client_id");

-- CreateIndex
CREATE INDEX "client_watchlist_tenant_id_idx" ON "client_watchlist"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_watchlist_client_id_key" ON "client_watchlist"("client_id");

-- CreateIndex
CREATE INDEX "alert_preference_tenant_id_idx" ON "alert_preference"("tenant_id");

-- CreateIndex
CREATE INDEX "alert_preference_client_id_idx" ON "alert_preference"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_preference_user_id_client_id_key" ON "alert_preference"("user_id", "client_id");

-- CreateIndex
CREATE INDEX "tracker_feedback_tenant_id_idx" ON "tracker_feedback"("tenant_id");

-- CreateIndex
CREATE INDEX "tracker_feedback_client_id_idx" ON "tracker_feedback"("client_id");

-- CreateIndex
CREATE INDEX "tracker_feedback_bill_id_idx" ON "tracker_feedback"("bill_id");

-- CreateIndex
CREATE INDEX "notification_log_tenant_id_idx" ON "notification_log"("tenant_id");

-- CreateIndex
CREATE INDEX "notification_log_client_id_idx" ON "notification_log"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_log_alert_id_user_id_channel_key" ON "notification_log"("alert_id", "user_id", "channel");

-- CreateIndex
CREATE INDEX "district_nexus_alert_payload_tenant_client_idx" ON "district_nexus_alert_payload"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "alert_digest_queue_tenant_id_idx" ON "alert_digest_queue"("tenant_id");

-- CreateIndex
CREATE INDEX "alert_digest_queue_user_id_channel_cadence_flushed_idx" ON "alert_digest_queue"("user_id", "channel", "cadence", "flushed");

-- CreateIndex
CREATE INDEX "sms_verification_user_id_idx" ON "sms_verification"("user_id");

-- CreateIndex
CREATE INDEX "sms_verification_tenant_id_idx" ON "sms_verification"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "intelligence_change_dedupe_key_key" ON "intelligence_change"("dedupe_key");

-- CreateIndex
CREATE INDEX "intelligence_change_detected_at_idx" ON "intelligence_change"("detected_at" DESC);

-- CreateIndex
CREATE INDEX "intelligence_change_source_change_type_idx" ON "intelligence_change"("source", "change_type");

-- CreateIndex
CREATE INDEX "intelligence_change_pe_codes_gin_idx" ON "intelligence_change" USING GIN ("related_pe_codes");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_docket_document_id_key" ON "regulatory_docket"("document_id");

-- CreateIndex
CREATE INDEX "regulatory_docket_agency_id_posted_date_idx" ON "regulatory_docket"("agency_id", "posted_date");

-- CreateIndex
CREATE INDEX "regulatory_docket_comment_end_date_idx" ON "regulatory_docket"("comment_end_date");

-- CreateIndex
CREATE INDEX "regulatory_docket_document_type_idx" ON "regulatory_docket"("document_type");

-- CreateIndex
CREATE UNIQUE INDEX "sec_filing_accession_number_key" ON "sec_filing"("accession_number");

-- CreateIndex
CREATE INDEX "sec_filing_cik_idx" ON "sec_filing"("cik");

-- CreateIndex
CREATE INDEX "sec_filing_form_type_filing_date_idx" ON "sec_filing"("form_type", "filing_date");

-- CreateIndex
CREATE INDEX "sec_filing_company_name_idx" ON "sec_filing"("company_name");

-- CreateIndex
CREATE UNIQUE INDEX "fara_registration_registration_number_key" ON "fara_registration"("registration_number");

-- CreateIndex
CREATE INDEX "fara_registration_registrant_name_idx" ON "fara_registration"("registrant_name");

-- CreateIndex
CREATE INDEX "fara_registration_foreign_principal_idx" ON "fara_registration"("foreign_principal");

-- CreateIndex
CREATE INDEX "fara_registration_country_idx" ON "fara_registration"("country");

-- CreateIndex
CREATE UNIQUE INDEX "regulatory_comment_comment_id_key" ON "regulatory_comment"("comment_id");

-- CreateIndex
CREATE INDEX "regulatory_comment_docket_id_idx" ON "regulatory_comment"("docket_id");

-- CreateIndex
CREATE INDEX "regulatory_comment_organization_idx" ON "regulatory_comment"("organization");

-- CreateIndex
CREATE INDEX "regulatory_comment_last_name_first_name_idx" ON "regulatory_comment"("last_name", "first_name");

-- CreateIndex
CREATE INDEX "bls_data_point_series_id_year_idx" ON "bls_data_point"("series_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "bls_data_point_series_id_year_period_key" ON "bls_data_point"("series_id", "year", "period");

-- CreateIndex
CREATE INDEX "census_district_congress_state_idx" ON "census_district"("congress", "state");

-- CreateIndex
CREATE INDEX "census_district_state_district_idx" ON "census_district"("state", "district");

-- CreateIndex
CREATE INDEX "legislative_district_state_chamber_status_idx" ON "legislative_district"("state", "chamber", "status");

-- CreateIndex
CREATE INDEX "legislative_district_legistorm_district_id_idx" ON "legislative_district"("legistorm_district_id");

-- CreateIndex
CREATE INDEX "legistorm_trip_approver_member_id_idx" ON "legistorm_trip"("approver_member_id");

-- CreateIndex
CREATE INDEX "legistorm_trip_traveler_member_id_idx" ON "legistorm_trip"("traveler_member_id");

-- CreateIndex
CREATE INDEX "legistorm_trip_traveler_staff_id_idx" ON "legistorm_trip"("traveler_staff_id");

-- CreateIndex
CREATE INDEX "bea_data_dataset_name_year_idx" ON "bea_data"("dataset_name", "year");

-- CreateIndex
CREATE INDEX "bea_data_geo_fips_idx" ON "bea_data"("geo_fips");

-- CreateIndex
CREATE UNIQUE INDEX "bea_data_dataset_name_table_name_series_code_year_period_ge_key" ON "bea_data"("dataset_name", "table_name", "series_code", "year", "period", "geo_fips");

-- CreateIndex
CREATE INDEX "california_grant_opportunity_status_idx" ON "california_grant_opportunity"("status");

-- CreateIndex
CREATE INDEX "california_grant_opportunity_deadline_idx" ON "california_grant_opportunity"("application_deadline_calendar_date");

-- CreateIndex
CREATE INDEX "federal_grant_agency_idx" ON "federal_grant"("agency");

-- CreateIndex
CREATE INDEX "federal_grant_close_date_idx" ON "federal_grant"("close_date");

-- CreateIndex
CREATE INDEX "federal_grant_status_idx" ON "federal_grant"("status");

-- CreateIndex
CREATE INDEX "federal_grant_doc_type_idx" ON "federal_grant"("doc_type");

-- CreateIndex
CREATE INDEX "federal_grant_detail_synced_at_idx" ON "federal_grant"("detail_synced_at");

-- CreateIndex
CREATE INDEX "federal_grant_lifecycle_enrichment_idx" ON "federal_grant"("status", "close_date", "detail_synced_at");

-- CreateIndex
CREATE INDEX "gao_report_publish_date_idx" ON "gao_report"("publish_date");

-- CreateIndex
CREATE INDEX "gao_report_report_type_idx" ON "gao_report"("report_type");

-- CreateIndex
CREATE UNIQUE INDEX "state_bill_legiscan_bill_id_key" ON "state_bill"("legiscan_bill_id");

-- CreateIndex
CREATE INDEX "state_bill_state_session_idx" ON "state_bill"("state", "session");

-- CreateIndex
CREATE INDEX "state_bill_state_latest_action_date_idx" ON "state_bill"("state", "latest_action_date");

-- CreateIndex
CREATE INDEX "state_bill_state_status_idx" ON "state_bill"("state", "status");

-- CreateIndex
CREATE INDEX "state_bill_currentCommitteeId_idx" ON "state_bill"("current_committee_id");

-- CreateIndex
CREATE INDEX "state_bill_status_derived_at_idx" ON "state_bill"("status_derived_at");

-- CreateIndex
CREATE UNIQUE INDEX "state_legislator_legiscan_people_id_key" ON "state_legislator"("legiscan_people_id");

-- CreateIndex
CREATE INDEX "state_legislator_state_chamber_idx" ON "state_legislator"("state", "chamber");

-- CreateIndex
CREATE INDEX "state_legislator_party_state_idx" ON "state_legislator"("party", "state");

-- CreateIndex
CREATE INDEX "state_bill_published_record_bill_key_first_observed_at_idx" ON "state_bill_published_record"("bill_key", "first_observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "state_bill_published_record_bill_key_kind_source_identity_r_key" ON "state_bill_published_record"("bill_key", "kind", "source_identity", "revision_hash");

-- CreateIndex
CREATE INDEX "state_bill_action_bill_key_date_idx" ON "state_bill_action"("bill_key", "date");

-- CreateIndex
CREATE INDEX "state_bill_action_first_seen_at_idx" ON "state_bill_action"("first_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "state_bill_action_bill_key_date_order_key_key" ON "state_bill_action"("bill_key", "date", "order_key");

-- CreateIndex
CREATE INDEX "state_bill_sponsor_legislator_id_idx" ON "state_bill_sponsor"("legislator_id");

-- CreateIndex
CREATE UNIQUE INDEX "state_bill_sponsor_bill_key_legiscan_people_id_key" ON "state_bill_sponsor"("bill_key", "legiscan_people_id");

-- CreateIndex
CREATE UNIQUE INDEX "state_roll_call_vote_legiscan_roll_call_id_key" ON "state_roll_call_vote"("legiscan_roll_call_id");

-- CreateIndex
CREATE INDEX "state_roll_call_vote_bill_key_idx" ON "state_roll_call_vote"("bill_key");

-- CreateIndex
CREATE INDEX "state_roll_call_vote_date_idx" ON "state_roll_call_vote"("date" DESC);

-- CreateIndex
CREATE INDEX "state_member_vote_legislator_id_idx" ON "state_member_vote"("legislator_id");

-- CreateIndex
CREATE UNIQUE INDEX "state_member_vote_vote_id_legiscan_people_id_key" ON "state_member_vote"("vote_id", "legiscan_people_id");

-- CreateIndex
CREATE UNIQUE INDEX "state_bill_version_legiscan_doc_id_key" ON "state_bill_version"("legiscan_doc_id");

-- CreateIndex
CREATE INDEX "state_bill_version_bill_key_date_idx" ON "state_bill_version"("bill_key", "date");

-- CreateIndex
CREATE INDEX "state_bill_link_related_bill_key_idx" ON "state_bill_link"("related_bill_key");

-- CreateIndex
CREATE UNIQUE INDEX "state_bill_link_bill_key_legiscan_related_bill_id_key" ON "state_bill_link"("bill_key", "legiscan_related_bill_id");

-- CreateIndex
CREATE INDEX "state_bill_calendar_event_date_idx" ON "state_bill_calendar_event"("date");

-- CreateIndex
CREATE UNIQUE INDEX "state_bill_calendar_event_bill_key_event_key_key" ON "state_bill_calendar_event"("bill_key", "event_key");

-- CreateIndex
CREATE UNIQUE INDEX "state_session_legiscan_session_id_key" ON "state_session"("legiscan_session_id");

-- CreateIndex
CREATE INDEX "state_session_state_idx" ON "state_session"("state");

-- CreateIndex
CREATE UNIQUE INDEX "state_committee_official_source_key_key" ON "state_committee"("official_source_key");

-- CreateIndex
CREATE UNIQUE INDEX "state_committee_legiscan_committee_id_key" ON "state_committee"("legiscan_committee_id");

-- CreateIndex
CREATE INDEX "state_committee_membership_legislator_id_idx" ON "state_committee_membership"("legislator_id");

-- CreateIndex
CREATE UNIQUE INDEX "state_committee_membership_committee_id_legislator_id_key" ON "state_committee_membership"("committee_id", "legislator_id");

-- CreateIndex
CREATE INDEX "state_sync_cursor_state_idx" ON "state_sync_cursor"("state");

-- CreateIndex
CREATE INDEX "state_rule_state_publication_date_idx" ON "state_rule"("state", "publication_date");

-- CreateIndex
CREATE INDEX "state_rule_comment_end_date_idx" ON "state_rule"("comment_end_date");

-- CreateIndex
CREATE INDEX "crs_report_date_idx" ON "crs_report"("date");

-- CreateIndex
CREATE UNIQUE INDEX "intel_article_url_key" ON "intel_article"("url");

-- CreateIndex
CREATE INDEX "intel_article_source_published_at_idx" ON "intel_article"("source", "published_at");

-- CreateIndex
CREATE INDEX "intel_article_published_at_idx" ON "intel_article"("published_at");

-- CreateIndex
CREATE INDEX "member_press_item_bioguide_published_idx" ON "member_press_item"("bioguide_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "member_press_item_bioguide_link_key" ON "member_press_item"("bioguide_id", "link");

-- CreateIndex
CREATE INDEX "committee_hearing_date_idx" ON "committee_hearing"("date");

-- CreateIndex
CREATE INDEX "committee_hearing_canonical_hearing_id_idx" ON "committee_hearing"("canonical_hearing_id");

-- CreateIndex
CREATE INDEX "committee_hearing_committee_name_date_idx" ON "committee_hearing"("committee_name", "date");

-- CreateIndex
CREATE INDEX "committee_hearing_geographic_jurisdiction_legislative_sessi_idx" ON "committee_hearing"("geographic_jurisdiction", "legislative_session", "date");

-- CreateIndex
CREATE INDEX "committee_hearing_starts_at_idx" ON "committee_hearing"("starts_at");

-- CreateIndex
CREATE INDEX "committee_hearing_committee_system_code_idx" ON "committee_hearing"("committee_system_code");

-- CreateIndex
CREATE INDEX "committee_hearing_coverage_status_idx" ON "committee_hearing"("coverage_status");

-- CreateIndex
CREATE INDEX "committee_hearing_event_status_idx" ON "committee_hearing"("event_status");

-- CreateIndex
CREATE INDEX "legislative_agenda_item_state_bill_key_active_hearing_id_idx" ON "legislative_agenda_item"("state_bill_key", "active", "hearing_id");

-- CreateIndex
CREATE INDEX "legislative_agenda_item_federal_bill_id_active_hearing_id_idx" ON "legislative_agenda_item"("federal_bill_id", "active", "hearing_id");

-- CreateIndex
CREATE UNIQUE INDEX "legislative_agenda_item_hearing_id_item_key_key" ON "legislative_agenda_item"("hearing_id", "item_key");

-- CreateIndex
CREATE INDEX "legislative_calendar_transition_observed_at_id_idx" ON "legislative_calendar_transition"("observed_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "legislative_calendar_transition_hearing_id_revision_key" ON "legislative_calendar_transition"("hearing_id", "revision");

-- CreateIndex
CREATE INDEX "legislative_observation_revision_hearing_id_observed_at_idx" ON "legislative_observation_revision"("hearing_id", "observed_at");

-- CreateIndex
CREATE INDEX "legislative_observation_revision_source_id_external_event_i_idx" ON "legislative_observation_revision"("source_id", "external_event_id", "observed_at");

-- CreateIndex
CREATE INDEX "legislative_calendar_coverage_jurisdiction_chamber_attempte_idx" ON "legislative_calendar_coverage"("jurisdiction", "chamber", "attempted_at");

-- CreateIndex
CREATE INDEX "state_bill_calendar_snapshot_bill_key_observed_at_idx" ON "state_bill_calendar_snapshot"("bill_key", "observed_at");

-- CreateIndex
CREATE INDEX "committee_hearing_bill_bill_id_idx" ON "committee_hearing_bill"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "committee_hearing_bill_hearing_id_bill_id_key" ON "committee_hearing_bill"("hearing_id", "bill_id");

-- CreateIndex
CREATE INDEX "official_hearing_transcript_hearing_id_idx" ON "official_hearing_transcript"("hearing_id");

-- CreateIndex
CREATE INDEX "official_hearing_transcript_congress_chamber_date_idx" ON "official_hearing_transcript"("congress", "chamber", "date");

-- CreateIndex
CREATE INDEX "official_hearing_transcript_date_idx" ON "official_hearing_transcript"("date");

-- CreateIndex
CREATE INDEX "committee_source_chamber_idx" ON "committee_source"("chamber");

-- CreateIndex
CREATE INDEX "committee_source_committee_system_code_idx" ON "committee_source"("committee_system_code");

-- CreateIndex
CREATE INDEX "committee_source_source_type_idx" ON "committee_source"("source_type");

-- CreateIndex
CREATE INDEX "committee_source_enabled_priority_idx" ON "committee_source"("enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "committee_source_adapter_key_source_url_key" ON "committee_source"("adapter_key", "source_url");

-- CreateIndex
CREATE INDEX "committee_source_exception_source_id_idx" ON "committee_source_exception"("source_id");

-- CreateIndex
CREATE INDEX "hearing_source_observation_hearing_id_idx" ON "hearing_source_observation"("hearing_id");

-- CreateIndex
CREATE INDEX "hearing_source_observation_raw_content_hash_idx" ON "hearing_source_observation"("raw_content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "hearing_source_observation_source_id_external_event_id_key" ON "hearing_source_observation"("source_id", "external_event_id");

-- CreateIndex
CREATE INDEX "hearing_stream_candidate_hearing_id_priority_idx" ON "hearing_stream_candidate"("hearing_id", "priority");

-- CreateIndex
CREATE INDEX "hearing_stream_candidate_resolution_state_idx" ON "hearing_stream_candidate"("resolution_state");

-- CreateIndex
CREATE INDEX "hearing_stream_candidate_capture_policy_idx" ON "hearing_stream_candidate"("capture_policy");

-- CreateIndex
CREATE UNIQUE INDEX "public_hearing_capture_hearing_id_key" ON "public_hearing_capture"("hearing_id");

-- CreateIndex
CREATE INDEX "public_hearing_capture_status_idx" ON "public_hearing_capture"("status");

-- CreateIndex
CREATE INDEX "public_hearing_capture_worker_lease_owner_idx" ON "public_hearing_capture"("worker_lease_owner");

-- CreateIndex
CREATE UNIQUE INDEX "public_hearing_capture_attempt_capture_id_attempt_number_key" ON "public_hearing_capture_attempt"("capture_id", "attempt_number");

-- CreateIndex
CREATE INDEX "public_hearing_transcript_segment_capture_id_sequence_idx" ON "public_hearing_transcript_segment"("capture_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "public_hearing_transcript_segment_capture_id_start_ms_end_m_key" ON "public_hearing_transcript_segment"("capture_id", "start_ms", "end_ms");

-- CreateIndex
CREATE UNIQUE INDEX "public_hearing_speaker_capture_id_speaker_label_key" ON "public_hearing_speaker"("capture_id", "speaker_label");

-- CreateIndex
CREATE INDEX "committee_site_update_committee_system_code_last_seen_at_idx" ON "committee_site_update"("committee_system_code", "last_seen_at");

-- CreateIndex
CREATE INDEX "committee_site_update_hearing_id_idx" ON "committee_site_update"("hearing_id");

-- CreateIndex
CREATE INDEX "committee_site_update_update_type_idx" ON "committee_site_update"("update_type");

-- CreateIndex
CREATE INDEX "committee_site_update_content_hash_idx" ON "committee_site_update"("content_hash");

-- CreateIndex
CREATE INDEX "hearing_subscription_tenant_id_hearing_id_idx" ON "hearing_subscription"("tenant_id", "hearing_id");

-- CreateIndex
CREATE INDEX "hearing_subscription_hearing_id_idx" ON "hearing_subscription"("hearing_id");

-- CreateIndex
CREATE UNIQUE INDEX "hearing_subscription_tenant_id_user_id_hearing_id_key" ON "hearing_subscription"("tenant_id", "user_id", "hearing_id");

-- CreateIndex
CREATE INDEX "hearing_follow_tenant_user_idx" ON "hearing_follow"("tenant_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "hearing_follow_hearing_idx" ON "hearing_follow"("hearing_id");

-- CreateIndex
CREATE UNIQUE INDEX "hearing_follow_tenant_user_hearing_key" ON "hearing_follow"("tenant_id", "user_id", "hearing_id");

-- CreateIndex
CREATE INDEX "legiwatch_committee_follow_tenant_user_idx" ON "legiwatch_committee_follow"("tenant_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "legiwatch_committee_follow_code_idx" ON "legiwatch_committee_follow"("committee_system_code");

-- CreateIndex
CREATE UNIQUE INDEX "legiwatch_committee_follow_tenant_user_code_key" ON "legiwatch_committee_follow"("tenant_id", "user_id", "committee_system_code");

-- CreateIndex
CREATE INDEX "legiwatch_saved_item_tenant_user_idx" ON "legiwatch_saved_item"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "legiwatch_saved_item_hearing_idx" ON "legiwatch_saved_item"("tenant_id", "hearing_id");

-- CreateIndex
CREATE INDEX "legiwatch_saved_item_client_idx" ON "legiwatch_saved_item"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "legiwatch_notification_event_inbox_idx" ON "legiwatch_notification_event"("tenant_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "legiwatch_notification_event_hearing_idx" ON "legiwatch_notification_event"("tenant_id", "hearing_id");

-- CreateIndex
CREATE INDEX "legiwatch_notification_event_email_drain_idx" ON "legiwatch_notification_event"("email_delivery_status", "email_delivery_next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "legiwatch_notification_event_dedup_key" ON "legiwatch_notification_event"("tenant_id", "user_id", "dedup_key");

-- CreateIndex
CREATE INDEX "legiwatch_committee_email_preference_tenant_user_idx" ON "legiwatch_committee_email_preference"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "legiwatch_committee_email_preference_user_key" ON "legiwatch_committee_email_preference"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "hearing_auto_record_rule_tenant_id_enabled_idx" ON "hearing_auto_record_rule"("tenant_id", "enabled");

-- CreateIndex
CREATE INDEX "public_hearing_insight_hearing_sequence_idx" ON "public_hearing_insight"("hearing_id", "sequence", "id");

-- CreateIndex
CREATE INDEX "public_hearing_insight_segment_idx" ON "public_hearing_insight"("segment_id");

-- CreateIndex
CREATE INDEX "public_hearing_insight_type_idx" ON "public_hearing_insight"("insight_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "public_hearing_insight_entities_gin_idx" ON "public_hearing_insight" USING GIN ("entities");

-- CreateIndex
CREATE UNIQUE INDEX "public_hearing_intelligence_job_segment_id_key" ON "public_hearing_intelligence_job"("segment_id");

-- CreateIndex
CREATE INDEX "public_hearing_intelligence_job_hearing_idx" ON "public_hearing_intelligence_job"("hearing_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "tenant_hearing_relevance_tenant_hearing_score_idx" ON "tenant_hearing_relevance"("tenant_id", "hearing_id", "score" DESC, "id");

-- CreateIndex
CREATE INDEX "tenant_hearing_relevance_tenant_client_idx" ON "tenant_hearing_relevance"("tenant_id", "client_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_hearing_relevance_tenant_client_insight_key" ON "tenant_hearing_relevance"("tenant_id", "client_id", "insight_id");

-- CreateIndex
CREATE INDEX "tenant_hearing_relevance_job_tenant_hearing_idx" ON "tenant_hearing_relevance_job"("tenant_id", "hearing_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_hearing_relevance_job_tenant_batch_key" ON "tenant_hearing_relevance_job"("tenant_id", "batch_key");

-- CreateIndex
CREATE INDEX "sync_run_source_started_at_idx" ON "sync_run"("source", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "govinfo_cache_url_key" ON "govinfo_cache"("url");

-- CreateIndex
CREATE INDEX "govinfo_cache_fetched_at_idx" ON "govinfo_cache"("fetched_at");

-- CreateIndex
CREATE INDEX "pe_procurement_line_pe_code_idx" ON "program_element_procurement_line"("pe_code");

-- CreateIndex
CREATE INDEX "pe_procurement_line_fy_idx" ON "program_element_procurement_line"("fy");

-- CreateIndex
CREATE UNIQUE INDEX "pe_procurement_line_dedup_key" ON "program_element_procurement_line"("pe_code", "line_description", "fy");

-- CreateIndex
CREATE UNIQUE INDEX "federal_award_award_unique_id_key" ON "federal_award"("award_unique_id");

-- CreateIndex
CREATE INDEX "federal_award_pe_code_idx" ON "federal_award"("pe_code");

-- CreateIndex
CREATE INDEX "federal_award_contractor_name_idx" ON "federal_award"("contractor_name");

-- CreateIndex
CREATE INDEX "federal_award_pop_district_idx" ON "federal_award"("pop_state", "pop_congressional_district");

-- CreateIndex
CREATE INDEX "federal_award_awarded_at_idx" ON "federal_award"("awarded_at");

-- CreateIndex
CREATE INDEX "federal_award_action_date_idx" ON "federal_award"("action_date");

-- CreateIndex
CREATE INDEX "federal_award_dod_acq_program_idx" ON "federal_award"("dod_acq_program_code");

-- CreateIndex
CREATE UNIQUE INDEX "federal_assistance_award_award_unique_id_key" ON "federal_assistance_award"("award_unique_id");

-- CreateIndex
CREATE INDEX "faa_recipient_uei_idx" ON "federal_assistance_award"("recipient_uei");

-- CreateIndex
CREATE INDEX "faa_pop_district_idx" ON "federal_assistance_award"("pop_state", "pop_congressional_district");

-- CreateIndex
CREATE INDEX "faa_recipient_district_idx" ON "federal_assistance_award"("recipient_state", "recipient_congressional_district");

-- CreateIndex
CREATE INDEX "faa_aln_idx" ON "federal_assistance_award"("assistance_listing_number");

-- CreateIndex
CREATE INDEX "faa_awarding_agency_idx" ON "federal_assistance_award"("awarding_agency");

-- CreateIndex
CREATE INDEX "faa_end_date_idx" ON "federal_assistance_award"("end_date");

-- CreateIndex
CREATE INDEX "client_grant_nexus_tenant_client_idx" ON "client_grant_nexus"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "client_grant_nexus_tenant_award_idx" ON "client_grant_nexus"("tenant_id", "assistance_award_id");

-- CreateIndex
CREATE INDEX "client_grant_nexus_tenant_opp_idx" ON "client_grant_nexus"("tenant_id", "grant_opportunity_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_grant_nexus_producer_unique_idx" ON "client_grant_nexus"("tenant_id", "client_id", "grant_opportunity_id", "relationship_type", "evidence_source_type");

-- CreateIndex
CREATE INDEX "client_funding_opportunity_tenant_client_status_idx" ON "client_funding_opportunity"("tenant_id", "client_id", "workflow_status");

-- CreateIndex
CREATE INDEX "client_funding_opportunity_pipeline_stage_idx" ON "client_funding_opportunity"("tenant_id", "client_id", "pipeline_stage");

-- CreateIndex
CREATE INDEX "client_funding_opportunity_tenant_grant_idx" ON "client_funding_opportunity"("tenant_id", "grant_opportunity_id");

-- CreateIndex
CREATE INDEX "client_funding_opportunity_tenant_sam_idx" ON "client_funding_opportunity"("tenant_id", "sam_opportunity_id");

-- CreateIndex
CREATE INDEX "client_funding_opportunity_tenant_owner_idx" ON "client_funding_opportunity"("tenant_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "client_funding_opportunity_lifecycle_idx" ON "client_funding_opportunity"("tenant_id", "workflow_status", "response_deadline_snapshot");

-- CreateIndex
CREATE INDEX "client_funding_opportunity_tenant_cursor_idx" ON "client_funding_opportunity"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "client_funding_opportunity_source_record_idx" ON "client_funding_opportunity"("tenant_id", "source_record_type", "source_record_key");

-- CreateIndex
CREATE INDEX "opportunity_bookmark_lookup_idx" ON "opportunity_bookmarks"("tenant_id", "client_id", "source", "source_record_type", "source_record_key");

-- CreateIndex
CREATE INDEX "tango_resource_snapshot_history_idx" ON "tango_resource_snapshot"("resource_type", "external_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tango_resource_snapshot_natural_key_uniq" ON "tango_resource_snapshot"("resource_type", "external_id", "content_sha256");

-- CreateIndex
CREATE INDEX "tango_resource_link_tango_idx" ON "tango_resource_link"("tango_resource_type", "tango_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "tango_resource_link_pair_uniq" ON "tango_resource_link"("local_resource_type", "local_resource_id", "tango_resource_type", "tango_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "tango_sync_checkpoint_walk_uniq" ON "tango_sync_checkpoint"("sync_verb", "resource_type", "filter_fingerprint");

-- CreateIndex
CREATE INDEX "tango_api_usage_family_time_idx" ON "tango_api_usage"("call_family", "timestamp_bucket");

-- CreateIndex
CREATE UNIQUE INDEX "tango_webhook_delivery_delivery_id_uniq" ON "tango_webhook_delivery"("delivery_id");

-- CreateIndex
CREATE INDEX "tango_webhook_delivery_status_idx" ON "tango_webhook_delivery"("status", "received_at");

-- CreateIndex
CREATE INDEX "tango_webhook_delivery_event_idx" ON "tango_webhook_delivery"("event_type", "received_at");

-- CreateIndex
CREATE INDEX "tango_webhook_delivery_payload_sha_idx" ON "tango_webhook_delivery"("payload_sha256");

-- CreateIndex
CREATE INDEX "tango_event_outbox_claim_idx" ON "tango_event_outbox"("status", "lease_until", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tango_event_outbox_delivery_event_uniq" ON "tango_event_outbox"("delivery_id", "event_index");

-- CreateIndex
CREATE INDEX "tango_event_alert_tenant_created_idx" ON "tango_event_alert"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "tango_event_alert_client_idx" ON "tango_event_alert"("tenant_id", "client_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tango_event_alert_dedupe_uniq" ON "tango_event_alert"("tenant_id", "client_id", "source_record_key", "change_fingerprint");

-- CreateIndex
CREATE INDEX "client_profile_enrichment_candidate_pending_idx" ON "client_profile_enrichment_candidate"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "client_profile_enrichment_candidate_content_uniq" ON "client_profile_enrichment_candidate"("tenant_id", "client_id", "source", "field", "content_hash");

-- CreateIndex
CREATE INDEX "client_relevant_vehicle_tenant_client_idx" ON "client_relevant_vehicle"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_relevant_vehicle_uniq" ON "client_relevant_vehicle"("tenant_id", "client_id", "tango_vehicle_id", "relationship");

-- CreateIndex
CREATE UNIQUE INDEX "tango_procurement_forecast_tango_forecast_id_key" ON "tango_procurement_forecast"("tango_forecast_id");

-- CreateIndex
CREATE INDEX "tango_procurement_forecast_fiscal_year_idx" ON "tango_procurement_forecast"("fiscal_year");

-- CreateIndex
CREATE INDEX "tango_procurement_forecast_agency_idx" ON "tango_procurement_forecast"("agency");

-- CreateIndex
CREATE INDEX "tango_procurement_forecast_modified_idx" ON "tango_procurement_forecast"("provider_modified_at");

-- CreateIndex
CREATE UNIQUE INDEX "tango_budget_account_row_id_uniq" ON "tango_budget_account"("tango_account_row_id");

-- CreateIndex
CREATE INDEX "tango_budget_account_symbol_fy_idx" ON "tango_budget_account"("federal_account_symbol", "fiscal_year");

-- CreateIndex
CREATE INDEX "tango_budget_account_agency_idx" ON "tango_budget_account"("agency_code");

-- CreateIndex
CREATE INDEX "tango_budget_vendor_flow_uei_idx" ON "tango_budget_vendor_flow"("recipient_uei");

-- CreateIndex
CREATE INDEX "tango_budget_vendor_flow_account_idx" ON "tango_budget_vendor_flow"("budget_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "tango_procurement_protest_case_uniq" ON "tango_procurement_protest"("tango_case_id");

-- CreateIndex
CREATE INDEX "tango_procurement_protest_protester_idx" ON "tango_procurement_protest"("protester_uei");

-- CreateIndex
CREATE INDEX "tango_procurement_protest_opportunity_idx" ON "tango_procurement_protest"("sam_opportunity_id");

-- CreateIndex
CREATE INDEX "tango_procurement_protest_agency_idx" ON "tango_procurement_protest"("agency_name");

-- CreateIndex
CREATE UNIQUE INDEX "tango_entity_exclusion_uei_uniq" ON "tango_entity_exclusion"("uei");

-- CreateIndex
CREATE INDEX "tango_entity_exclusion_observed_idx" ON "tango_entity_exclusion"("observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "tango_dibbs_solicitation_tango_id_uniq" ON "tango_dibbs_solicitation"("tango_dibbs_id");

-- CreateIndex
CREATE INDEX "tango_dibbs_solicitation_solicitation_idx" ON "tango_dibbs_solicitation"("solicitation");

-- CreateIndex
CREATE INDEX "tango_dibbs_solicitation_nsn_idx" ON "tango_dibbs_solicitation"("nsn");

-- CreateIndex
CREATE INDEX "tango_dibbs_solicitation_part_number_idx" ON "tango_dibbs_solicitation"("part_number");

-- CreateIndex
CREATE INDEX "tango_dibbs_solicitation_type_closes_idx" ON "tango_dibbs_solicitation"("document_type", "closes_date");

-- CreateIndex
CREATE UNIQUE INDEX "tango_dibbs_award_tango_id_uniq" ON "tango_dibbs_award"("tango_dibbs_id");

-- CreateIndex
CREATE INDEX "tango_dibbs_award_award_number_idx" ON "tango_dibbs_award"("award_number");

-- CreateIndex
CREATE INDEX "tango_dibbs_award_solicitation_idx" ON "tango_dibbs_award"("solicitation");

-- CreateIndex
CREATE INDEX "tango_dibbs_award_nsn_idx" ON "tango_dibbs_award"("nsn");

-- CreateIndex
CREATE INDEX "tango_dibbs_award_awardee_cage_idx" ON "tango_dibbs_award"("awardee_cage");

-- CreateIndex
CREATE INDEX "tango_dibbs_award_posted_date_idx" ON "tango_dibbs_award"("posted_date");

-- CreateIndex
CREATE UNIQUE INDEX "tango_sbir_solicitation_tango_id_uniq" ON "tango_sbir_solicitation"("tango_sbir_id");

-- CreateIndex
CREATE INDEX "tango_sbir_solicitation_number_idx" ON "tango_sbir_solicitation"("solicitation_number");

-- CreateIndex
CREATE INDEX "tango_sbir_solicitation_program_idx" ON "tango_sbir_solicitation"("program");

-- CreateIndex
CREATE INDEX "tango_sbir_solicitation_year_idx" ON "tango_sbir_solicitation"("year");

-- CreateIndex
CREATE INDEX "tango_sbir_solicitation_status_idx" ON "tango_sbir_solicitation"("solicitation_status");

-- CreateIndex
CREATE UNIQUE INDEX "tango_sbir_topic_tango_id_uniq" ON "tango_sbir_topic"("tango_sbir_id");

-- CreateIndex
CREATE INDEX "tango_sbir_topic_solicitation_number_idx" ON "tango_sbir_topic"("solicitation_number");

-- CreateIndex
CREATE INDEX "tango_sbir_topic_topic_number_idx" ON "tango_sbir_topic"("topic_number");

-- CreateIndex
CREATE INDEX "tango_sbir_topic_agency_idx" ON "tango_sbir_topic"("agency");

-- CreateIndex
CREATE INDEX "tango_sbir_topic_close_date_idx" ON "tango_sbir_topic"("close_date");

-- CreateIndex
CREATE INDEX "tango_opportunity_parity_conflict_idx" ON "tango_opportunity_parity"("agreement", "resolution", "last_observed_at");

-- CreateIndex
CREATE INDEX "tango_opportunity_parity_sam_idx" ON "tango_opportunity_parity"("sam_opportunity_id");

-- CreateIndex
CREATE UNIQUE INDEX "tango_opportunity_parity_record_field_uniq" ON "tango_opportunity_parity"("tango_opportunity_id", "sam_opportunity_id", "field");

-- CreateIndex
CREATE UNIQUE INDEX "tango_opportunity_notice_notice_id_uniq" ON "tango_opportunity_notice"("tango_notice_id");

-- CreateIndex
CREATE INDEX "tango_opportunity_notice_parent_idx" ON "tango_opportunity_notice"("tango_opportunity_id", "posted_date");

-- CreateIndex
CREATE INDEX "tango_opportunity_notice_sam_idx" ON "tango_opportunity_notice"("sam_opportunity_id", "posted_date");

-- CreateIndex
CREATE INDEX "opportunity_attachment_sam_idx" ON "opportunity_attachment"("sam_opportunity_id", "status");

-- CreateIndex
CREATE INDEX "opportunity_attachment_status_idx" ON "opportunity_attachment"("status", "first_seen_at");

-- CreateIndex
CREATE INDEX "opportunity_attachment_hash_idx" ON "opportunity_attachment"("content_sha256");

-- CreateIndex
CREATE INDEX "opportunity_document_text_binding_idx" ON "opportunity_document_text"("attachment_content_sha256");

-- CreateIndex
CREATE INDEX "opportunity_document_text_status_idx" ON "opportunity_document_text"("status", "created_at");

-- CreateIndex
CREATE INDEX "opportunity_requirement_sam_idx" ON "opportunity_requirement"("sam_opportunity_id", "requirement_type");

-- CreateIndex
CREATE INDEX "opportunity_requirement_binding_idx" ON "opportunity_requirement"("attachment_content_sha256", "superseded_at");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_requirement_evidence_uniq" ON "opportunity_requirement"("attachment_content_sha256", "requirement_type", "excerpt_start", "excerpt_end");

-- CreateIndex
CREATE INDEX "opportunity_requirement_review_status_idx" ON "opportunity_requirement_review"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_requirement_review_tenant_req_uniq" ON "opportunity_requirement_review"("tenant_id", "requirement_id");

-- CreateIndex
CREATE INDEX "funding_opportunity_stage_transition_row_idx" ON "funding_opportunity_stage_transition"("tenant_id", "client_funding_opportunity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "funding_opportunity_stage_transition_actor_idx" ON "funding_opportunity_stage_transition"("tenant_id", "actor_user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "pe_acq_program_pe_code_idx" ON "program_element_acquisition_program"("pe_code");

-- CreateIndex
CREATE INDEX "pe_acq_program_code_idx" ON "program_element_acquisition_program"("acq_program_code");

-- CreateIndex
CREATE UNIQUE INDEX "pe_acq_program_code_pe_key" ON "program_element_acquisition_program"("acq_program_code", "pe_code");

-- CreateIndex
CREATE INDEX "program_element_performer_pe_code_idx" ON "program_element_performer"("pe_code");

-- CreateIndex
CREATE INDEX "program_element_performer_norm_idx" ON "program_element_performer"("performer_normalized");

-- CreateIndex
CREATE INDEX "program_element_performer_named_idx" ON "program_element_performer"("is_named_company");

-- CreateIndex
CREATE INDEX "program_element_performer_source_document_idx" ON "program_element_performer"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "program_element_performer_natural_key" ON "program_element_performer"("pe_code", "performer_normalized", "location", "contract_method", "cost_category", "fy");

-- CreateIndex
CREATE INDEX "program_mdap_code_idx" ON "program"("mdap_code");

-- CreateIndex
CREATE INDEX "program_component_idx" ON "program"("component");

-- CreateIndex
CREATE INDEX "program_status_idx" ON "program"("status");

-- CreateIndex
CREATE INDEX "program_alias_program_id_idx" ON "program_alias"("program_id");

-- CreateIndex
CREATE INDEX "program_alias_normalized_idx" ON "program_alias"("alias_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "program_alias_program_norm_type_key" ON "program_alias"("program_id", "alias_normalized", "alias_type");

-- CreateIndex
CREATE INDEX "program_identity_crosswalk_identity_time_idx" ON "program_identity_crosswalk"("identity_kind", "source_system", "source_identifier", "recorded_at");

-- CreateIndex
CREATE INDEX "program_identity_crosswalk_program_fy_idx" ON "program_identity_crosswalk"("program_id", "valid_from_fy", "valid_to_fy");

-- CreateIndex
CREATE INDEX "program_identity_crosswalk_source_document_idx" ON "program_identity_crosswalk"("source_document_id");

-- CreateIndex
CREATE INDEX "program_identity_crosswalk_review_idx" ON "program_identity_crosswalk"("review_status", "recorded_at");

-- CreateIndex
CREATE INDEX "acquisition_record_revision_identity_time_idx" ON "acquisition_record_revision"("identity_key", "recorded_at");

-- CreateIndex
CREATE INDEX "acquisition_record_revision_source_kind_idx" ON "acquisition_record_revision"("source_system", "record_kind", "recorded_at");

-- CreateIndex
CREATE INDEX "acquisition_record_revision_parent_idx" ON "acquisition_record_revision"("parent_identity_key");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_record_revision_identity_content_key" ON "acquisition_record_revision"("identity_key", "content_hash");

-- CreateIndex
CREATE INDEX "acquisition_transaction_award_action_idx" ON "acquisition_award_transaction_revision"("award_identity_key", "action_date");

-- CreateIndex
CREATE INDEX "acquisition_transaction_parent_idx" ON "acquisition_award_transaction_revision"("parent_award_identity_key");

-- CreateIndex
CREATE INDEX "acquisition_transaction_source_id_idx" ON "acquisition_award_transaction_revision"("source_system", "source_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_transaction_identity_content_key" ON "acquisition_award_transaction_revision"("transaction_identity_key", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_transaction_supersedes_key" ON "acquisition_award_transaction_revision"("supersedes_id");

-- CreateIndex
CREATE INDEX "program_acquisition_relationship_subject_time_idx" ON "program_acquisition_relationship"("subject_kind", "subject_key", "recorded_at");

-- CreateIndex
CREATE INDEX "program_acquisition_relationship_acquisition_time_idx" ON "program_acquisition_relationship"("acquisition_identity_key", "recorded_at");

-- CreateIndex
CREATE INDEX "program_acquisition_relationship_review_class_idx" ON "program_acquisition_relationship"("review_status", "relationship_class");

-- CreateIndex
CREATE UNIQUE INDEX "program_acquisition_relationship_logical_content_key" ON "program_acquisition_relationship"("logical_key", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "program_acquisition_relationship_supersedes_key" ON "program_acquisition_relationship"("supersedes_id");

-- CreateIndex
CREATE INDEX "acquisition_coverage_gap_subject_open_idx" ON "acquisition_coverage_gap"("subject_kind", "subject_key", "resolved_at");

-- CreateIndex
CREATE INDEX "acquisition_coverage_gap_source_open_idx" ON "acquisition_coverage_gap"("source_system", "resolved_at", "last_observed_at");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_coverage_gap_identity_key" ON "acquisition_coverage_gap"("subject_kind", "subject_key", "source_system", "relationship_kind", "reason");

-- CreateIndex
CREATE INDEX "pe_program_match_program_id_idx" ON "pe_program_match"("program_id");

-- CreateIndex
CREATE INDEX "pe_program_match_pe_code_idx" ON "pe_program_match"("pe_code");

-- CreateIndex
CREATE INDEX "pe_program_match_status_idx" ON "pe_program_match"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sam_opportunity_notice_id_key" ON "sam_opportunity"("notice_id");

-- CreateIndex
CREATE INDEX "sam_opportunity_active_response_deadline_idx" ON "sam_opportunity"("active", "response_deadline");

-- CreateIndex
CREATE INDEX "sam_opportunity_active_type_deadline_idx" ON "sam_opportunity"("active", "notice_type", "response_deadline");

-- CreateIndex
CREATE INDEX "sam_opportunity_lifecycle_idx" ON "sam_opportunity"("active", "response_deadline", "archive_date");

-- CreateIndex
CREATE INDEX "sam_opportunity_set_aside_code_idx" ON "sam_opportunity"("set_aside_code");

-- CreateIndex
CREATE INDEX "sam_opportunity_solicitation_number_idx" ON "sam_opportunity"("solicitation_number");

-- CreateIndex
CREATE INDEX "sam_opportunity_naics_code_idx" ON "sam_opportunity"("naics_code");

-- CreateIndex
CREATE INDEX "sam_opportunity_psc_code_idx" ON "sam_opportunity"("psc_code");

-- CreateIndex
CREATE INDEX "sam_opportunity_office_idx" ON "sam_opportunity"("office");

-- CreateIndex
CREATE INDEX "sam_opportunity_match_program_id_idx" ON "sam_opportunity_match"("program_id");

-- CreateIndex
CREATE INDEX "sam_opportunity_match_pe_code_idx" ON "sam_opportunity_match"("pe_code");

-- CreateIndex
CREATE INDEX "sam_opportunity_match_review_status_idx" ON "sam_opportunity_match"("review_status");

-- CreateIndex
CREATE INDEX "committee_report_provision_committee_fy_idx" ON "committee_report_provision"("committee", "fy");

-- CreateIndex
CREATE INDEX "committee_report_provision_action_type_idx" ON "committee_report_provision"("action_type");

-- CreateIndex
CREATE INDEX "committee_report_provision_source_document_idx" ON "committee_report_provision"("source_document_id");

-- CreateIndex
CREATE INDEX "provision_pe_link_pe_code_idx" ON "provision_pe_link"("pe_code");

-- CreateIndex
CREATE INDEX "provision_pe_link_program_id_idx" ON "provision_pe_link"("program_id");

-- CreateIndex
CREATE INDEX "provision_pe_link_review_status_idx" ON "provision_pe_link"("review_status");

-- CreateIndex
CREATE INDEX "program_office_service_idx" ON "program_office"("service");

-- CreateIndex
CREATE INDEX "program_office_office_type_idx" ON "program_office"("office_type");

-- CreateIndex
CREATE INDEX "program_office_parent_idx" ON "program_office"("parent_office_id");

-- CreateIndex
CREATE INDEX "person_role_person_id_idx" ON "person_role"("person_id");

-- CreateIndex
CREATE INDEX "person_role_office_id_idx" ON "person_role"("office_id");

-- CreateIndex
CREATE INDEX "person_role_program_id_idx" ON "person_role"("program_id");

-- CreateIndex
CREATE INDEX "person_role_review_status_idx" ON "person_role"("review_status");

-- CreateIndex
CREATE INDEX "person_role_contact_use_idx" ON "person_role"("contact_use");

-- CreateIndex
CREATE INDEX "program_office_program_link_program_id_idx" ON "program_office_program_link"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "program_office_program_link_office_program_key" ON "program_office_program_link"("office_id", "program_id");

-- CreateIndex
CREATE INDEX "memory_items_tenant_client_idx" ON "memory_items"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "memory_items_tenant_visibility_owner_idx" ON "memory_items"("tenant_id", "visibility", "owner_user_id");

-- CreateIndex
CREATE INDEX "memory_items_tenant_type_idx" ON "memory_items"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "memory_items_entity_idx" ON "memory_items"("entity_id");

-- CreateIndex
CREATE INDEX "memory_items_tenant_status_idx" ON "memory_items"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "memory_items_governed_recall_idx" ON "memory_items"("tenant_id", "governed_status", "memory_class", "memory_scope", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "memory_items_tenant_type_slug_unique" ON "memory_items"("tenant_id", "type", "slug");

-- CreateIndex
CREATE INDEX "memory_edges_tenant_dst_idx" ON "memory_edges"("tenant_id", "dst_type", "dst_slug");

-- CreateIndex
CREATE UNIQUE INDEX "memory_edges_unique" ON "memory_edges"("src_item_id", "relation", "dst_type", "dst_slug");

-- CreateIndex
CREATE INDEX "memory_candidate_tenant_status_idx" ON "memory_candidate"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "memory_candidate_tenant_proposed_by_idx" ON "memory_candidate"("tenant_id", "proposed_by");

-- CreateIndex
CREATE INDEX "memory_candidate_governed_queue_idx" ON "memory_candidate"("tenant_id", "governed_status", "memory_class", "client_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "memory_candidate_tenant_id_id_unique" ON "memory_candidate"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "memory_ingest_run_tenant_started_idx" ON "memory_ingest_run"("tenant_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "memory_access_grant_user_idx" ON "memory_access_grant"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "memory_transition_audit_tenant_time_idx" ON "memory_transition_audit"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "memory_transition_audit_item_idx" ON "memory_transition_audit"("tenant_id", "memory_item_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "memory_transition_audit_candidate_idx" ON "memory_transition_audit"("tenant_id", "memory_candidate_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "memory_cleanup_outbox_pending_idx" ON "memory_cleanup_outbox"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "memory_cleanup_outbox_idempotency_key" ON "memory_cleanup_outbox"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "learning_signal_tenant_client_idx" ON "learning_signal"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "learning_signal_tenant_actor_idx" ON "learning_signal"("tenant_id", "actor_user_id");

-- CreateIndex
CREATE INDEX "learning_signal_tenant_surface_type_idx" ON "learning_signal"("tenant_id", "source_surface", "signal_type");

-- CreateIndex
CREATE INDEX "learning_signal_tenant_status_created_idx" ON "learning_signal"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "learning_signal_tenant_idempotency_unique" ON "learning_signal"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "learning_signal_candidate_outcome_signal_unique" ON "learning_signal_candidate_outcome"("learning_signal_id");

-- CreateIndex
CREATE INDEX "learning_signal_candidate_outcome_tenant_eligibility_idx" ON "learning_signal_candidate_outcome"("tenant_id", "eligibility", "decided_at" DESC);

-- CreateIndex
CREATE INDEX "quality_telemetry_event_tenant_surface_type_idx" ON "quality_telemetry_event"("tenant_id", "surface", "event_type", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "quality_telemetry_event_tenant_artifact_idx" ON "quality_telemetry_event"("tenant_id", "artifact_type", "artifact_id");

-- CreateIndex
CREATE INDEX "quality_telemetry_event_tenant_client_idx" ON "quality_telemetry_event"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "quality_telemetry_event_context_packet_idx" ON "quality_telemetry_event"("context_packet_id");

-- CreateIndex
CREATE INDEX "quality_telemetry_event_learning_signal_idx" ON "quality_telemetry_event"("learning_signal_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_telemetry_event_tenant_idempotency_unique" ON "quality_telemetry_event"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "quality_telemetry_memory_item_use_item_idx" ON "quality_telemetry_memory_item_use"("memory_item_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "quality_telemetry_memory_item_use_tenant_item_idx" ON "quality_telemetry_memory_item_use"("tenant_id", "memory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_telemetry_memory_item_use_event_item_unique" ON "quality_telemetry_memory_item_use"("telemetry_event_id", "memory_item_id");

-- CreateIndex
CREATE INDEX "evaluation_record_tenant_surface_status_idx" ON "evaluation_record"("tenant_id", "surface", "status", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "evaluation_record_tenant_artifact_idx" ON "evaluation_record"("tenant_id", "treatment_artifact_type", "treatment_artifact_id");

-- CreateIndex
CREATE INDEX "evaluation_record_tenant_client_idx" ON "evaluation_record"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "evaluation_record_context_packet_idx" ON "evaluation_record"("context_packet_id");

-- CreateIndex
CREATE INDEX "evaluation_record_quality_telemetry_event_idx" ON "evaluation_record"("quality_telemetry_event_id");

-- CreateIndex
CREATE INDEX "evaluation_record_status_created_idx" ON "evaluation_record"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "evaluation_record_tenant_idempotency_unique" ON "evaluation_record"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "claim_tenant_id_idx" ON "claim"("tenant_id");

-- CreateIndex
CREATE INDEX "claim_tenant_id_subject_type_subject_id_idx" ON "claim"("tenant_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "claim_artifact_id_idx" ON "claim"("artifact_id");

-- CreateIndex
CREATE INDEX "evidence_tenant_id_idx" ON "evidence"("tenant_id");

-- CreateIndex
CREATE INDEX "evidence_claim_id_idx" ON "evidence"("claim_id");

-- CreateIndex
CREATE INDEX "compliance_check_tenant_id_occurred_at_idx" ON "compliance_check"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "compliance_check_tenant_id_trigger_idx" ON "compliance_check"("tenant_id", "trigger");

-- CreateIndex
CREATE INDEX "budget_action_pe_code_idx" ON "budget_action"("pe_code");

-- CreateIndex
CREATE INDEX "budget_action_fy_stage_idx" ON "budget_action"("fy", "stage");

-- CreateIndex
CREATE INDEX "budget_action_action_idx" ON "budget_action"("action");

-- CreateIndex
CREATE UNIQUE INDEX "budget_action_natural_key" ON "budget_action"("pe_code", "fy", "stage", "action");

-- CreateIndex
CREATE INDEX "budget_line_relationship_from_idx" ON "budget_line_relationship"("from_pe_code");

-- CreateIndex
CREATE INDEX "budget_line_relationship_to_idx" ON "budget_line_relationship"("to_pe_code");

-- CreateIndex
CREATE INDEX "budget_line_relationship_type_idx" ON "budget_line_relationship"("rel_type");

-- CreateIndex
CREATE UNIQUE INDEX "budget_line_relationship_natural_key" ON "budget_line_relationship"("from_pe_code", "to_pe_code", "rel_type");

-- CreateIndex
CREATE UNIQUE INDEX "capability_slug_key" ON "capability"("slug");

-- CreateIndex
CREATE INDEX "capability_budget_line_match_pe_idx" ON "capability_budget_line_match"("pe_code");

-- CreateIndex
CREATE UNIQUE INDEX "capability_budget_line_match_natural_key" ON "capability_budget_line_match"("capability_id", "pe_code");

-- CreateIndex
CREATE INDEX "pe_intelligence_cache_line_type_idx" ON "program_element_intelligence_cache"("line_type");

-- CreateIndex
CREATE INDEX "pe_intelligence_cache_approp_idx" ON "program_element_intelligence_cache"("approp_score");

-- CreateIndex
CREATE INDEX "pe_intelligence_cache_signal_idx" ON "program_element_intelligence_cache"("signal_type");

-- CreateIndex
CREATE INDEX "bill_budget_line_link_pe_idx" ON "bill_budget_line_link"("pe_code");

-- CreateIndex
CREATE INDEX "bill_budget_line_link_bill_idx" ON "bill_budget_line_link"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_budget_line_link_natural_key" ON "bill_budget_line_link"("bill_id", "pe_code", "link_type");

-- CreateIndex
CREATE INDEX "budget_package_domain_fy_idx" ON "budget_package"("domain", "fiscal_year");

-- CreateIndex
CREATE UNIQUE INDEX "budget_package_domain_fy_key" ON "budget_package"("domain", "fiscal_year");

-- CreateIndex
CREATE INDEX "budget_package_vehicle_package_track_stage_idx" ON "budget_package_vehicle"("package_id", "track", "stage");

-- CreateIndex
CREATE INDEX "budget_package_vehicle_bill_idx" ON "budget_package_vehicle"("bill_id");

-- CreateIndex
CREATE INDEX "budget_package_vehicle_source_document_idx" ON "budget_package_vehicle"("source_document_id");

-- CreateIndex
CREATE INDEX "funding_position_natural_key_idx" ON "funding_position"("package_id", "vehicle_id", "fiscal_year", "vehicle_class", "stage", "scope");

-- CreateIndex
CREATE INDEX "funding_position_package_stage_scope_idx" ON "funding_position"("package_id", "stage", "scope");

-- CreateIndex
CREATE INDEX "funding_position_bill_fy_idx" ON "funding_position"("bill_id", "fiscal_year");

-- CreateIndex
CREATE INDEX "funding_position_verification_idx" ON "funding_position"("verification_status");

-- CreateIndex
CREATE INDEX "funding_position_source_document_idx" ON "funding_position"("source_document_id");

-- CreateIndex
CREATE INDEX "budget_interim_funding_period_domain_fy_seq_idx" ON "budget_interim_funding_period"("domain", "fiscal_year", "sequence");

-- CreateIndex
CREATE INDEX "budget_interim_funding_period_bill_idx" ON "budget_interim_funding_period"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_interim_funding_period_natural_key" ON "budget_interim_funding_period"("domain", "fiscal_year", "sequence");

-- CreateIndex
CREATE INDEX "compliance_policy_pack_lookup_idx" ON "compliance_policy_pack"("tenant_id", "status", "jurisdiction", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "compliance_policy_pack_version_unique" ON "compliance_policy_pack"("tenant_id", "pack_key", "version");

-- CreateIndex
CREATE INDEX "compliance_policy_pack_event_pack_idx" ON "compliance_policy_pack_event"("tenant_id", "policy_pack_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "compliance_policy_decision_recent_idx" ON "compliance_policy_decision"("tenant_id", "decided_at" DESC);

-- CreateIndex
CREATE INDEX "compliance_policy_decision_version_idx" ON "compliance_policy_decision"("tenant_id", "pack_key", "pack_version");

-- CreateIndex
CREATE INDEX "compliance_policy_decision_hash_idx" ON "compliance_policy_decision"("tenant_id", "decision_hash");

-- CreateIndex
CREATE INDEX "assurance_eval_run_recent_idx" ON "assurance_eval_run"("tenant_id", "run_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "assurance_eval_run_provenance_unique" ON "assurance_eval_run"("tenant_id", "provenance_hash");

-- CreateIndex
CREATE INDEX "assurance_eval_result_domain_idx" ON "assurance_eval_result"("tenant_id", "domain", "passed");

-- CreateIndex
CREATE UNIQUE INDEX "assurance_eval_result_case_unique" ON "assurance_eval_result"("eval_run_id", "case_id");

-- CreateIndex
CREATE UNIQUE INDEX "assurance_eval_domain_gate_unique" ON "assurance_eval_domain_gate"("eval_run_id", "domain");

-- CreateIndex
CREATE INDEX "assurance_feedback_candidate_queue_idx" ON "assurance_feedback_candidate"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "assurance_eval_fixture_dataset_idx" ON "assurance_eval_fixture"("tenant_id", "dataset_version", "retired_at");

-- CreateIndex
CREATE UNIQUE INDEX "assurance_eval_fixture_key_unique" ON "assurance_eval_fixture"("tenant_id", "fixture_key");

-- CreateIndex
CREATE INDEX "budget_v1_candidate_source_document_idx" ON "budget_extraction_candidate_v1"("source_document_id");

-- CreateIndex
CREATE INDEX "budget_v1_candidate_status_idx" ON "budget_extraction_candidate_v1"("status");

-- CreateIndex
CREATE INDEX "budget_v1_candidate_cycle_idx" ON "budget_extraction_candidate_v1"("cycle_id");

-- CreateIndex
CREATE INDEX "budget_v1_candidate_cycle_family_idx" ON "budget_extraction_candidate_v1"("cycle_id", "family");

-- CreateIndex
CREATE UNIQUE INDEX "budget_v1_candidate_identity_key" ON "budget_extraction_candidate_v1"("cycle_id", "manifest_content_sha256", "manifest_document_key", "source_document_id", "source_sha256", "extraction_artifact_id", "extraction_artifact_sha256", "verifier_version", "policy_version", "policy_sha256");

-- CreateIndex
CREATE INDEX "budget_v1_run_candidate_idx" ON "budget_verification_run_v1"("candidate_id", "created_at");

-- CreateIndex
CREATE INDEX "budget_v1_check_run_idx" ON "budget_verification_check_v1"("run_id", "code");

-- CreateIndex
CREATE INDEX "budget_v1_proof_run_idx" ON "budget_verification_proof"("run_id");

-- CreateIndex
CREATE INDEX "budget_v1_discrepancy_candidate_idx" ON "budget_verification_discrepancy_v1"("candidate_id", "created_at");

-- CreateIndex
CREATE INDEX "budget_v1_discrepancy_run_idx" ON "budget_verification_discrepancy_v1"("run_id");

-- CreateIndex
CREATE INDEX "budget_v1_review_candidate_idx" ON "budget_review_decision_v1"("candidate_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "budget_scoped_fact_review_v1_review_generation_unique" ON "budget_scoped_fact_review_v1"("review_generation");

-- CreateIndex
CREATE INDEX "budget_scoped_fact_review_v1_candidate_idx" ON "budget_scoped_fact_review_v1"("candidate_id", "created_at");

-- CreateIndex
CREATE INDEX "budget_scoped_fact_review_v1_scope_idx" ON "budget_scoped_fact_review_v1"("scope_kind", "scope_key", "status");

-- CreateIndex
CREATE INDEX "budget_scoped_fact_review_v1_ack_revoked_idx" ON "budget_scoped_fact_review_v1"("acknowledged_revoked_review_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_candidate_correction_v1_one_per_old_candidate" ON "budget_candidate_correction_v1"("old_candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_candidate_correction_v1_one_per_new_candidate" ON "budget_candidate_correction_v1"("new_candidate_id");

-- CreateIndex
CREATE INDEX "budget_candidate_correction_v1_old_idx" ON "budget_candidate_correction_v1"("old_candidate_id", "created_at");

-- CreateIndex
CREATE INDEX "budget_candidate_correction_v1_new_idx" ON "budget_candidate_correction_v1"("new_candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_canonical_snapshot_key_unique" ON "defense_budget_canonical_snapshot"("snapshot_key");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_snapshot_status_idx" ON "defense_budget_canonical_snapshot"("domain", "environment", "status");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_snapshot_cycle_idx" ON "defense_budget_canonical_snapshot"("cycle_id", "fiscal_year");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_active_snapshot_singleton_unique" ON "defense_budget_active_snapshot"("domain", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_plan_plan_id_unique" ON "defense_budget_promotion_plan"("plan_id");

-- CreateIndex
CREATE INDEX "defense_budget_promotion_plan_cycle_idx" ON "defense_budget_promotion_plan"("cycle_id", "fiscal_year");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_plan_identity_unique" ON "defense_budget_promotion_plan"("plan_id", "plan_hash");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_projection_plan_identity_unique" ON "defense_budget_projection_plan"("projection_plan_id");

-- CreateIndex
CREATE INDEX "defense_budget_projection_plan_scope_idx" ON "defense_budget_projection_plan"("cycle_id", "family", "fiscal_year");

-- CreateIndex
CREATE INDEX "defense_budget_projection_plan_content_idx" ON "defense_budget_projection_plan"("content_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_eligibility_hash_unique" ON "defense_budget_promotion_eligibility"("eligibility_hash");

-- CreateIndex
CREATE INDEX "defense_budget_promotion_eligibility_cycle_idx" ON "defense_budget_promotion_eligibility"("cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_eligibility_identity_unique" ON "defense_budget_promotion_eligibility"("eligibility_id", "eligibility_hash");

-- CreateIndex
CREATE INDEX "defense_budget_manual_override_target_idx" ON "defense_budget_manual_override"("canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_authorization_id_unique" ON "defense_budget_promotion_authorization"("authorization_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_run_key_unique" ON "defense_budget_promotion_run"("run_key");

-- CreateIndex
CREATE INDEX "defense_budget_promotion_run_status_idx" ON "defense_budget_promotion_run"("status");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_item_identity_unique" ON "defense_budget_promotion_item"("run_id", "canonical_entity", "canonical_natural_key");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_activation_key_unique" ON "defense_budget_promotion_activation"("activation_key");

-- CreateIndex
CREATE INDEX "defense_budget_promotion_activation_new_snapshot_idx" ON "defense_budget_promotion_activation"("new_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_rollback_record_key_unique" ON "defense_budget_rollback_record"("rollback_key");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_promotion_outbox_dedupe_unique" ON "defense_budget_promotion_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "defense_budget_promotion_outbox_drain_idx" ON "defense_budget_promotion_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "defense_budget_promotion_outbox_activation_idx" ON "defense_budget_promotion_outbox"("activation_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_side_effect_drain_pause_scope_unique" ON "defense_budget_side_effect_drain_pause"("domain", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_canonical_delta_key_unique" ON "defense_budget_canonical_delta"("delta_key");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_canonical_delta_outbox_unique" ON "defense_budget_canonical_delta"("outbox_id");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_delta_snapshot_idx" ON "defense_budget_canonical_delta"("new_snapshot_id", "family", "fiscal_year");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_delta_identity_idx" ON "defense_budget_canonical_delta"("canonical_entity", "canonical_natural_key");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_delta_activation_idx" ON "defense_budget_canonical_delta"("activation_id");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_row_snapshot_entity_idx" ON "defense_budget_canonical_row"("snapshot_id", "canonical_entity");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_row_parent_idx" ON "defense_budget_canonical_row"("snapshot_id", "canonical_entity", "parent_natural_key");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_row_fy_idx" ON "defense_budget_canonical_row"("snapshot_id", "family", "fiscal_year");

-- CreateIndex
CREATE INDEX "defense_budget_canonical_row_run_idx" ON "defense_budget_canonical_row"("promotion_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_canonical_row_identity_unique" ON "defense_budget_canonical_row"("snapshot_id", "canonical_entity", "canonical_natural_key");

-- CreateIndex
CREATE INDEX "defense_budget_promotion_audit_created_idx" ON "defense_budget_promotion_audit"("created_at");

-- CreateIndex
CREATE INDEX "defense_budget_promotion_audit_plan_idx" ON "defense_budget_promotion_audit"("plan_id");

-- CreateIndex
CREATE INDEX "x_tracked_account_last_fetched_idx" ON "x_tracked_account"("last_fetched_at");

-- CreateIndex
CREATE UNIQUE INDEX "x_tracked_account_x_user_id_unique" ON "x_tracked_account"("x_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "x_tracked_account_username_unique" ON "x_tracked_account"("username");

-- CreateIndex
CREATE INDEX "x_post_cache_account_created_idx" ON "x_post_cache"("account_id", "created_at_x");

-- CreateIndex
CREATE INDEX "x_post_cache_unavailable_idx" ON "x_post_cache"("unavailable");

-- CreateIndex
CREATE UNIQUE INDEX "x_post_cache_account_post_unique" ON "x_post_cache"("account_id", "x_post_id");

-- CreateIndex
CREATE INDEX "x_feed_subscription_tenant_user_idx" ON "x_feed_subscription"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "x_feed_subscription_enabled_idx" ON "x_feed_subscription"("tenant_id", "user_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "x_feed_subscription_unique" ON "x_feed_subscription"("tenant_id", "user_id", "account_id");

-- CreateIndex
CREATE INDEX "knowledge_events_tenant_occurred_idx" ON "knowledge_events"("tenant_id", "occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "knowledge_events_tenant_source_idx" ON "knowledge_events"("tenant_id", "source_type", "source_id", "source_version");

-- CreateIndex
CREATE INDEX "knowledge_events_tenant_type_observed_idx" ON "knowledge_events"("tenant_id", "event_type", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "knowledge_events_actor_refs_gin" ON "knowledge_events" USING GIN ("actor_refs");

-- CreateIndex
CREATE INDEX "knowledge_events_entity_refs_gin" ON "knowledge_events" USING GIN ("entity_refs");

-- CreateIndex
CREATE INDEX "knowledge_events_client_refs_gin" ON "knowledge_events" USING GIN ("client_refs");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_events_tenant_identity_unique" ON "knowledge_events"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_events_idempotency_unique" ON "knowledge_events"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "knowledge_assertions_tenant_subject_idx" ON "knowledge_assertions"("tenant_id", "subject_type", "subject_id", "predicate", "valid_from" DESC);

-- CreateIndex
CREATE INDEX "knowledge_assertions_tenant_object_idx" ON "knowledge_assertions"("tenant_id", "object_type", "object_id");

-- CreateIndex
CREATE INDEX "knowledge_assertions_tenant_class_idx" ON "knowledge_assertions"("tenant_id", "assertion_class", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "knowledge_assertions_origin_event_idx" ON "knowledge_assertions"("tenant_id", "origin_event_id");

-- CreateIndex
CREATE INDEX "knowledge_assertions_conflict_group_idx" ON "knowledge_assertions"("tenant_id", "conflict_group_id");

-- CreateIndex
CREATE INDEX "knowledge_assertions_temporal_idx" ON "knowledge_assertions"("tenant_id", "valid_from" DESC, "valid_until");

-- CreateIndex
CREATE INDEX "knowledge_assertions_object_value_gin" ON "knowledge_assertions" USING GIN ("object_value");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_assertions_tenant_identity_unique" ON "knowledge_assertions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_assertions_idempotency_unique" ON "knowledge_assertions"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "knowledge_evidence_assertion_idx" ON "knowledge_evidence"("tenant_id", "assertion_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "knowledge_evidence_event_idx" ON "knowledge_evidence"("tenant_id", "event_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "knowledge_evidence_source_idx" ON "knowledge_evidence"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_evidence_identity_unique" ON "knowledge_evidence"("tenant_id", "assertion_id", "event_id", "content_hash", "start_offset", "end_offset");

-- CreateIndex
CREATE INDEX "knowledge_mailbox_jobs_tenant_message_idx" ON "knowledge_mailbox_jobs"("tenant_id", "mail_message_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_mailbox_jobs_identity_unique" ON "knowledge_mailbox_jobs"("tenant_id", "mail_message_id", "source_revision");

-- CreateIndex
CREATE INDEX "knowledge_mailbox_extraction_jobs_tenant_message_idx" ON "knowledge_mailbox_extraction_jobs"("tenant_id", "mail_message_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "knowledge_mailbox_extraction_jobs_tenant_event_idx" ON "knowledge_mailbox_extraction_jobs"("tenant_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_mailbox_extraction_jobs_event_unique" ON "knowledge_mailbox_extraction_jobs"("tenant_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_mailbox_extraction_jobs_mailbox_job_unique" ON "knowledge_mailbox_extraction_jobs"("tenant_id", "mailbox_job_id");

-- CreateIndex
CREATE INDEX "knowledge_episodes_tenant_last_event_idx" ON "knowledge_episodes"("tenant_id", "last_event_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "knowledge_episodes_client_refs_gin" ON "knowledge_episodes" USING GIN ("client_refs");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_episodes_identity_unique" ON "knowledge_episodes"("tenant_id", "strategy", "identity_key");

-- CreateIndex
CREATE INDEX "knowledge_episode_events_episode_idx" ON "knowledge_episode_events"("tenant_id", "episode_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_episode_events_membership_unique" ON "knowledge_episode_events"("tenant_id", "episode_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_episode_events_event_unique" ON "knowledge_episode_events"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "knowledge_episode_assertions_episode_idx" ON "knowledge_episode_assertions"("tenant_id", "episode_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "knowledge_episode_assertions_origin_event_idx" ON "knowledge_episode_assertions"("tenant_id", "origin_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_episode_assertions_membership_unique" ON "knowledge_episode_assertions"("tenant_id", "episode_id", "assertion_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_episode_assertions_assertion_unique" ON "knowledge_episode_assertions"("tenant_id", "assertion_id");

-- CreateIndex
CREATE INDEX "knowledge_episode_entities_episode_idx" ON "knowledge_episode_entities"("tenant_id", "episode_id");

-- CreateIndex
CREATE INDEX "knowledge_episode_entities_entity_idx" ON "knowledge_episode_entities"("tenant_id", "canonical_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_episode_entities_membership_unique" ON "knowledge_episode_entities"("tenant_id", "episode_id", "canonical_entity_id");

-- CreateIndex
CREATE INDEX "knowledge_episode_projection_jobs_tenant_event_idx" ON "knowledge_episode_projection_jobs"("tenant_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_episode_projection_jobs_event_unique" ON "knowledge_episode_projection_jobs"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "federal_funding_measure_type_fy_status_idx" ON "federal_funding_measure"("measure_type", "fiscal_year", "status");

-- CreateIndex
CREATE INDEX "federal_funding_measure_public_law_idx" ON "federal_funding_measure"("public_law_number");

-- CreateIndex
CREATE INDEX "federal_funding_measure_source_document_idx" ON "federal_funding_measure"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "federal_funding_measure_dedup_key_key" ON "federal_funding_measure"("dedup_key");

-- CreateIndex
CREATE INDEX "federal_funding_provision_measure_idx" ON "federal_funding_provision"("measure_id");

-- CreateIndex
CREATE INDEX "federal_funding_provision_account_idx" ON "federal_funding_provision"("agency", "component", "tas");

-- CreateIndex
CREATE INDEX "federal_funding_provision_source_document_idx" ON "federal_funding_provision"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "federal_funding_provision_dedup_key_key" ON "federal_funding_provision"("dedup_key");

-- CreateIndex
CREATE INDEX "federal_funding_allocation_provision_idx" ON "federal_funding_allocation"("provision_id");

-- CreateIndex
CREATE INDEX "federal_funding_allocation_target_idx" ON "federal_funding_allocation"("target_type", "target_id", "target_native_key");

-- CreateIndex
CREATE INDEX "federal_funding_allocation_review_idx" ON "federal_funding_allocation"("review_state", "mapping_maturity");

-- CreateIndex
CREATE INDEX "federal_funding_allocation_evidence_document_idx" ON "federal_funding_allocation"("evidence_source_document_id");

-- CreateIndex
CREATE INDEX "federal_funding_allocation_source_event_idx" ON "federal_funding_allocation"("source_event_id");

-- CreateIndex
CREATE INDEX "federal_funding_allocation_correction_idx" ON "federal_funding_allocation"("correction_of_allocation_id");

-- CreateIndex
CREATE INDEX "federal_funding_allocation_execution_time_idx" ON "federal_funding_allocation"("execution_metric", "as_of_date");

-- CreateIndex
CREATE UNIQUE INDEX "federal_funding_allocation_dedup_key_key" ON "federal_funding_allocation"("dedup_key");

-- CreateIndex
CREATE INDEX "federal_funding_source_event_source_time_idx" ON "federal_funding_source_event"("source_system", "source_record_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "federal_funding_source_event_measure_time_idx" ON "federal_funding_source_event"("measure_id", "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "federal_funding_source_event_content_key" ON "federal_funding_source_event"("source_event_key", "content_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "federal_funding_source_event_revision_key" ON "federal_funding_source_event"("source_event_key", "revision");

-- CreateIndex
CREATE INDEX "federal_funding_certification_measure_time_idx" ON "federal_funding_certification"("measure_id", "certified_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "federal_funding_certification_revision_key" ON "federal_funding_certification"("certification_key", "revision");

-- CreateIndex
CREATE INDEX "federal_funding_publication_allocation_time_idx" ON "federal_funding_publication"("allocation_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "federal_funding_publication_allocation_key" ON "federal_funding_publication"("certification_id", "allocation_id");

-- CreateIndex
CREATE INDEX "federal_funding_residual_scope_time_idx" ON "federal_funding_reconciliation_residual"("scope_key", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "federal_funding_residual_content_key" ON "federal_funding_reconciliation_residual"("certification_id", "scope_key", "content_sha256");

-- CreateIndex
CREATE INDEX "defense_budget_cycle_status_idx" ON "defense_budget_cycle"("status", "fiscal_year");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_cycle_fy_track_key" ON "defense_budget_cycle"("fiscal_year", "authority_track");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_cycle_dedup_key_key" ON "defense_budget_cycle"("dedup_key");

-- CreateIndex
CREATE INDEX "defense_budget_expected_source_cycle_idx" ON "defense_budget_expected_source"("cycle_id", "stage");

-- CreateIndex
CREATE INDEX "defense_budget_expected_source_state_idx" ON "defense_budget_expected_source"("expected_state", "fiscal_year");

-- CreateIndex
CREATE INDEX "defense_budget_expected_source_adapter_idx" ON "defense_budget_expected_source"("adapter_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_expected_source_dedup_key_key" ON "defense_budget_expected_source"("dedup_key");

-- CreateIndex
CREATE INDEX "defense_budget_source_bundle_member_status_idx" ON "defense_budget_source_bundle_member"("expected_source_id", "member_status");

-- CreateIndex
CREATE INDEX "defense_budget_source_bundle_member_observation_idx" ON "defense_budget_source_bundle_member"("observation_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_source_bundle_member_expected_key_key" ON "defense_budget_source_bundle_member"("expected_source_id", "member_key");

-- CreateIndex
CREATE INDEX "defense_budget_governed_import_audit_expected_idx" ON "defense_budget_governed_import_audit"("expected_source_id");

-- CreateIndex
CREATE INDEX "defense_budget_governed_import_audit_member_idx" ON "defense_budget_governed_import_audit"("bundle_member_id");

-- CreateIndex
CREATE INDEX "defense_budget_source_observation_cycle_state_idx" ON "defense_budget_source_observation"("cycle_id", "observation_state");

-- CreateIndex
CREATE INDEX "defense_budget_source_observation_sha_idx" ON "defense_budget_source_observation"("content_sha256");

-- CreateIndex
CREATE INDEX "defense_budget_source_observation_source_document_idx" ON "defense_budget_source_observation"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_source_observation_expected_sha_key" ON "defense_budget_source_observation"("expected_source_id", "content_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_source_observation_dedup_key_key" ON "defense_budget_source_observation"("dedup_key");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_source_observation_id_state_key" ON "defense_budget_source_observation"("id", "observation_state");

-- CreateIndex
CREATE INDEX "defense_budget_watcher_adapter_next_check_idx" ON "defense_budget_watcher_adapter"("next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_watcher_adapter_adapter_id_key" ON "defense_budget_watcher_adapter"("adapter_id");

-- CreateIndex
CREATE INDEX "defense_budget_watcher_run_status_idx" ON "defense_budget_watcher_run"("status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_watcher_run_adapter_run_key" ON "defense_budget_watcher_run"("adapter_id", "run_key");

-- CreateIndex
CREATE INDEX "defense_budget_ingestion_outbox_ready_idx" ON "defense_budget_ingestion_outbox"("state", "available_at");

-- CreateIndex
CREATE INDEX "defense_budget_ingestion_outbox_cycle_idx" ON "defense_budget_ingestion_outbox"("cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_ingestion_outbox_observation_job_key" ON "defense_budget_ingestion_outbox"("observation_id", "job_kind");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_ingestion_outbox_dedup_key_key" ON "defense_budget_ingestion_outbox"("dedup_key");

-- CreateIndex
CREATE INDEX "budget_reextraction_operation_v1_claim_idx" ON "budget_reextraction_operation_v1"("status", "leased_until");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_ingestion_manifest_v1_manifest_sha256_key" ON "defense_budget_ingestion_manifest_v1"("manifest_sha256");

-- CreateIndex
CREATE INDEX "defense_budget_ingestion_manifest_item_v1_claim_idx" ON "defense_budget_ingestion_manifest_item_v1"("manifest_id", "status", "next_attempt_at", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_ingestion_manifest_item_v1_manifest_ordinal_key" ON "defense_budget_ingestion_manifest_item_v1"("manifest_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_ingestion_manifest_item_v1_manifest_outbox_key" ON "defense_budget_ingestion_manifest_item_v1"("manifest_id", "outbox_row_id");

-- CreateIndex
CREATE INDEX "defense_budget_lifecycle_signal_cycle_idx" ON "defense_budget_lifecycle_signal"("cycle_id", "signal_kind");

-- CreateIndex
CREATE INDEX "defense_budget_lifecycle_signal_emitted_idx" ON "defense_budget_lifecycle_signal"("emitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "defense_budget_lifecycle_signal_dedup_key_key" ON "defense_budget_lifecycle_signal"("dedup_key");

-- CreateIndex
CREATE INDEX "dbdc_adapter_started_idx" ON "defense_budget_discovery_crawl"("adapter_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "dbdc_run_key_idx" ON "defense_budget_discovery_crawl"("run_key");

-- CreateIndex
CREATE INDEX "dbdc_status_idx" ON "defense_budget_discovery_crawl"("status");

-- CreateIndex
CREATE INDEX "dbdcand_crawl_idx" ON "defense_budget_discovery_candidate"("crawl_id");

-- CreateIndex
CREATE INDEX "dbdcand_resolution_idx" ON "defense_budget_discovery_candidate"("resolution");

-- CreateIndex
CREATE UNIQUE INDEX "dbdcand_run_url_uidx" ON "defense_budget_discovery_candidate"("adapter_id", "run_key", "candidate_url");

-- CreateIndex
CREATE INDEX "dpi_provider_started_idx" ON "defense_provider_invocation"("provider", "started_at" DESC);

-- CreateIndex
CREATE INDEX "dpi_outcome_idx" ON "defense_provider_invocation"("outcome");

-- CreateIndex
CREATE INDEX "dpi_tenant_started_idx" ON "defense_provider_invocation"("tenant_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "dpi_idempotency_idx" ON "defense_provider_invocation"("idempotency_key");

-- CreateIndex
CREATE INDEX "dbst_started_idx" ON "defense_budget_schedule_tick"("started_at" DESC);

-- CreateIndex
CREATE INDEX "dbst_outcome_idx" ON "defense_budget_schedule_tick"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "dbst_worker_tick_key_uidx" ON "defense_budget_schedule_tick"("worker_id", "tick_key");

-- CreateIndex
CREATE INDEX "dbrr_expected_source_idx" ON "defense_budget_review_resolution"("expected_source_id", "resolved_at" DESC);

-- CreateIndex
CREATE INDEX "dbrr_tenant_idx" ON "defense_budget_review_resolution"("tenant_id", "resolved_at" DESC);

-- CreateIndex
CREATE INDEX "dbcmr_cycle_recent_idx" ON "defense_budget_cycle_manifest_registry"("cycle_id", "registered_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "dbcmr_cycle_manifest_hash_key" ON "defense_budget_cycle_manifest_registry"("cycle_id", "manifest_content_sha256");

-- CreateIndex
CREATE INDEX "lw_digest_run_tenant_client_idx" ON "legiwatch_digest_run"("tenant_id", "client_id", "generated_at" DESC);

-- CreateIndex
CREATE INDEX "legiwatch_digest_schedule_tenant_user_client_idx" ON "legiwatch_digest_schedule"("tenant_id", "user_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "gsa_real_property_identity_key" ON "gsa_real_property"("source_hash");

-- CreateIndex
CREATE INDEX "gsa_real_property_district_idx" ON "gsa_real_property"("state_code", "congressional_district", "fiscal_year" DESC);

-- CreateIndex
CREATE INDEX "gsa_real_property_rp_uid_idx" ON "gsa_real_property"("rp_uid", "fiscal_year" DESC);

-- CreateIndex
CREATE INDEX "gsa_real_property_agency_idx" ON "gsa_real_property"("reporting_agency");

-- CreateIndex
CREATE INDEX "gsa_real_property_source_run_latest_idx" ON "gsa_real_property_source_run"("source_dataset", "attempted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "district_nexus_change_identity_key" ON "district_nexus_change"("dedupe_key");

-- CreateIndex
CREATE INDEX "district_nexus_change_district_idx" ON "district_nexus_change"("state_code", "district_code", "boundary_congress", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "district_nexus_change_kind_idx" ON "district_nexus_change"("change_kind", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "district_nexus_change_district_kind_idx" ON "district_nexus_change"("state_code", "district_code", "observation_kind", "observed_at" DESC);

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
CREATE INDEX "business_development_prospect_activity_prospect_idx" ON "business_development_prospect_activity"("tenant_id", "prospect_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "business_development_preferences_tenant_id_key" ON "business_development_preferences"("tenant_id");

-- CreateIndex
CREATE INDEX "business_development_jev_decisions_tenant_task_mode_idx" ON "business_development_jev_decisions"("tenant_id", "task", "mode", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "business_development_jev_decisions_tenant_subject_idx" ON "business_development_jev_decisions"("tenant_id", "subject_type", "subject_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "business_development_jev_decisions_tenant_review_idx" ON "business_development_jev_decisions"("tenant_id", "review_status", "requested_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "business_development_jev_decisions_tenant_idempotency_key" ON "business_development_jev_decisions"("tenant_id", "idempotency_key");

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

-- CreateIndex
CREATE INDEX "business_development_watches_tenant_status_muted_idx" ON "business_development_watches"("tenant_id", "status", "muted_until");

-- CreateIndex
CREATE INDEX "business_development_watches_tenant_owner_idx" ON "business_development_watches"("tenant_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "business_development_watches_tenant_updated_idx" ON "business_development_watches"("tenant_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "business_development_watches_tenant_id_id_key" ON "business_development_watches"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "business_development_watches_tenant_prospect_key" ON "business_development_watches"("tenant_id", "prospect_id");

-- CreateIndex
CREATE INDEX "business_development_watch_source_states_tenant_claim_idx" ON "business_development_watch_source_states"("tenant_id", "source_family", "health", "lease_until");

-- CreateIndex
CREATE INDEX "business_development_watch_source_states_last_success_idx" ON "business_development_watch_source_states"("tenant_id", "last_successful_complete_check_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "business_development_watch_source_states_watch_source_key" ON "business_development_watch_source_states"("tenant_id", "watch_id", "source_family");

-- CreateIndex
CREATE INDEX "business_development_alerts_tenant_watch_observed_idx" ON "business_development_alerts"("tenant_id", "watch_id", "first_observed_at" DESC);

-- CreateIndex
CREATE INDEX "business_development_alerts_tenant_review_state_idx" ON "business_development_alerts"("tenant_id", "review_state", "first_observed_at" DESC);

-- CreateIndex
CREATE INDEX "business_development_alerts_tenant_category_idx" ON "business_development_alerts"("tenant_id", "category", "first_observed_at" DESC);

-- CreateIndex
CREATE INDEX "business_development_alerts_tenant_prospect_idx" ON "business_development_alerts"("tenant_id", "prospect_id", "first_observed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "business_development_alerts_tenant_id_id_key" ON "business_development_alerts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "business_development_alerts_tenant_watch_dedupe_key" ON "business_development_alerts"("tenant_id", "watch_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "business_development_alert_deliveries_tenant_recipient_idx" ON "business_development_alert_deliveries"("tenant_id", "recipient_user_id", "delivered_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "business_development_alert_deliveries_recipient_channel_key" ON "business_development_alert_deliveries"("tenant_id", "alert_id", "recipient_user_id", "channel");

-- CreateIndex
CREATE INDEX "research_portfolios_tenant_lifecycle_updated_idx" ON "research_portfolios"("tenant_id", "lifecycle", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "research_portfolios_tenant_owner_idx" ON "research_portfolios"("tenant_id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolios_tenant_id_key" ON "research_portfolios"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "research_portfolio_grants_tenant_principal_role_idx" ON "research_portfolio_grants"("tenant_id", "principal_user_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_grants_portfolio_user_key" ON "research_portfolio_grants"("tenant_id", "portfolio_id", "principal_user_id");

-- CreateIndex
CREATE INDEX "research_portfolio_client_links_tenant_client_idx" ON "research_portfolio_client_links"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_client_links_portfolio_client_key" ON "research_portfolio_client_links"("tenant_id", "portfolio_id", "client_id");

-- CreateIndex
CREATE INDEX "research_portfolio_members_disposition_idx" ON "research_portfolio_members"("tenant_id", "portfolio_id", "disposition", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_members_target_key" ON "research_portfolio_members"("tenant_id", "portfolio_id", "target_kind", "target_id");

-- CreateIndex
CREATE INDEX "research_portfolio_events_timeline_idx" ON "research_portfolio_events"("tenant_id", "portfolio_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_events_tenant_id_key" ON "research_portfolio_events"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_events_revision_id_key" ON "research_portfolio_events"("tenant_id", "portfolio_id", "aggregate_revision", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_events_idempotency_key" ON "research_portfolio_events"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "research_taxonomy_versions_tenant_published_idx" ON "research_taxonomy_versions"("tenant_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_taxonomy_versions_tenant_id_key" ON "research_taxonomy_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_taxonomy_versions_tenant_version_key" ON "research_taxonomy_versions"("tenant_id", "version");

-- CreateIndex
CREATE INDEX "research_taxonomy_concepts_parent_idx" ON "research_taxonomy_concepts"("tenant_id", "taxonomy_version_id", "parent_key");

-- CreateIndex
CREATE UNIQUE INDEX "research_taxonomy_concepts_version_key" ON "research_taxonomy_concepts"("tenant_id", "taxonomy_version_id", "stable_key");

-- CreateIndex
CREATE INDEX "research_portfolio_templates_tenant_archive_idx" ON "research_portfolio_templates"("tenant_id", "archived_at", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_templates_tenant_id_key" ON "research_portfolio_templates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_templates_tenant_name_key" ON "research_portfolio_templates"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "research_portfolio_template_versions_published_idx" ON "research_portfolio_template_versions"("tenant_id", "template_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_template_versions_number_key" ON "research_portfolio_template_versions"("tenant_id", "template_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_template_versions_tenant_id_key" ON "research_portfolio_template_versions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_template_versions_operation_key" ON "research_portfolio_template_versions"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_rule_versions_published_idx" ON "research_portfolio_rule_versions"("tenant_id", "portfolio_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_rule_versions_number_key" ON "research_portfolio_rule_versions"("tenant_id", "portfolio_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_rule_versions_tenant_id_key" ON "research_portfolio_rule_versions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "research_portfolio_rule_previews_expiry_idx" ON "research_portfolio_rule_previews"("tenant_id", "portfolio_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_rule_previews_hash_key" ON "research_portfolio_rule_previews"("tenant_id", "portfolio_id", "preview_hash");

-- CreateIndex
CREATE INDEX "research_portfolio_recompute_jobs_claim_idx" ON "research_portfolio_recompute_jobs"("tenant_id", "status", "lease_until");

-- CreateIndex
CREATE INDEX "research_portfolio_recompute_jobs_portfolio_idx" ON "research_portfolio_recompute_jobs"("tenant_id", "portfolio_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_recompute_jobs_operation_key" ON "research_portfolio_recompute_jobs"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_reviews_status_idx" ON "research_portfolio_reviews"("tenant_id", "portfolio_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "research_portfolio_reviews_target_idx" ON "research_portfolio_reviews"("tenant_id", "portfolio_id", "target_kind", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_reviews_tenant_id_key" ON "research_portfolio_reviews"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_reviews_trigger_fingerprint_key" ON "research_portfolio_reviews"("tenant_id", "portfolio_id", "trigger_fingerprint");

-- CreateIndex
CREATE INDEX "research_portfolio_decisions_timeline_idx" ON "research_portfolio_decisions"("tenant_id", "portfolio_id", "decision_time" DESC);

-- CreateIndex
CREATE INDEX "research_portfolio_decisions_review_idx" ON "research_portfolio_decisions"("tenant_id", "portfolio_id", "review_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_decisions_tenant_id_key" ON "research_portfolio_decisions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_decisions_target_time_key" ON "research_portfolio_decisions"("tenant_id", "portfolio_id", "target_kind", "target_id", "decision_time", "id");

-- CreateIndex
CREATE INDEX "research_portfolio_continuity_ledger_status_idx" ON "research_portfolio_continuity_ledger"("tenant_id", "portfolio_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_continuity_ledger_key" ON "research_portfolio_continuity_ledger"("tenant_id", "portfolio_id", "continuity_key");

-- CreateIndex
CREATE INDEX "research_portfolio_import_jobs_status_idx" ON "research_portfolio_import_jobs"("tenant_id", "portfolio_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_import_jobs_tenant_id_key" ON "research_portfolio_import_jobs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_import_jobs_operation_key" ON "research_portfolio_import_jobs"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_import_rows_outcome_idx" ON "research_portfolio_import_rows"("tenant_id", "portfolio_id", "import_job_id", "final_outcome");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_import_rows_row_identity_key" ON "research_portfolio_import_rows"("tenant_id", "import_job_id", "row_identity");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_import_mappings_version_key" ON "research_portfolio_import_mapping_versions"("tenant_id", "import_job_id", "version");

-- CreateIndex
CREATE INDEX "research_portfolio_import_attempts_job_idx" ON "research_portfolio_import_attempts"("tenant_id", "import_job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_import_attempts_operation_key" ON "research_portfolio_import_attempts"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_import_effects_row_idx" ON "research_portfolio_import_effects"("tenant_id", "import_row_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_import_effects_fingerprint_key" ON "research_portfolio_import_effects"("tenant_id", "import_job_id", "effect_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_import_effects_target_key" ON "research_portfolio_import_effects"("tenant_id", "import_job_id", "canonical_target_key", "effect_kind");

-- CreateIndex
CREATE INDEX "research_portfolio_import_receipts_job_idx" ON "research_portfolio_import_compensation_receipts"("tenant_id", "import_job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_import_receipts_operation_key" ON "research_portfolio_import_compensation_receipts"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_event_states_recipient_idx" ON "research_portfolio_event_recipient_states"("tenant_id", "portfolio_id", "recipient_user_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_event_states_event_user_key" ON "research_portfolio_event_recipient_states"("tenant_id", "event_id", "recipient_user_id");

-- CreateIndex
CREATE INDEX "research_portfolio_subscriptions_recipient_idx" ON "research_portfolio_subscriptions"("tenant_id", "subscriber_user_id", "active", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "research_portfolio_subscriptions_claim_idx" ON "research_portfolio_subscriptions"("tenant_id", "active", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_subscriptions_identity_key" ON "research_portfolio_subscriptions"("tenant_id", "portfolio_id", "subscriber_user_id", "target_kind", "target_id", "channel", "cadence");

-- CreateIndex
CREATE INDEX "research_portfolio_subscription_deliveries_recipient_idx" ON "research_portfolio_subscription_deliveries"("tenant_id", "recipient_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "research_portfolio_subscription_deliveries_status_idx" ON "research_portfolio_subscription_deliveries"("tenant_id", "portfolio_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_subscription_deliveries_identity_key" ON "research_portfolio_subscription_deliveries"("tenant_id", "subscription_id", "event_id", "recipient_user_id", "channel");

-- CreateIndex
CREATE INDEX "research_portfolio_snapshots_timeline_idx" ON "research_portfolio_snapshots"("tenant_id", "portfolio_id", "captured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_snapshots_tenant_id_key" ON "research_portfolio_snapshots"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_snapshots_operation_key" ON "research_portfolio_snapshots"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_output_requests_status_idx" ON "research_portfolio_output_requests"("tenant_id", "portfolio_id", "status", "requested_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_requests_tenant_id_key" ON "research_portfolio_output_requests"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_requests_operation_key" ON "research_portfolio_output_requests"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_output_jobs_claim_idx" ON "research_portfolio_output_jobs"("tenant_id", "status", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_jobs_tenant_id_key" ON "research_portfolio_output_jobs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_jobs_operation_key" ON "research_portfolio_output_jobs"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_output_attempts_job_idx" ON "research_portfolio_output_attempts"("tenant_id", "job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_attempts_number_key" ON "research_portfolio_output_attempts"("tenant_id", "job_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_attempts_operation_key" ON "research_portfolio_output_attempts"("tenant_id", "operation_key");

-- CreateIndex
CREATE INDEX "research_portfolio_output_artifacts_hash_idx" ON "research_portfolio_output_artifacts"("tenant_id", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_artifacts_tenant_id_key" ON "research_portfolio_output_artifacts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_artifacts_job_key" ON "research_portfolio_output_artifacts"("tenant_id", "job_id");

-- CreateIndex
CREATE INDEX "research_portfolio_output_receipts_artifact_idx" ON "research_portfolio_output_client_file_receipts"("tenant_id", "artifact_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_receipts_operation_key" ON "research_portfolio_output_client_file_receipts"("tenant_id", "operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_receipts_attachment_key" ON "research_portfolio_output_client_file_receipts"("tenant_id", "attachment_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_output_receipts_tenant_id_key" ON "research_portfolio_output_client_file_receipts"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "research_portfolio_bookmarks_user_idx" ON "research_portfolio_bookmarks"("tenant_id", "portfolio_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_bookmarks_unique" ON "research_portfolio_bookmarks"("tenant_id", "portfolio_id", "user_id", "target_kind", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_tour_state_unique" ON "research_portfolio_tour_states"("tenant_id", "user_id", "tour_version");

-- CreateIndex
CREATE INDEX "research_portfolio_review_notes_review_idx" ON "research_portfolio_review_notes"("tenant_id", "review_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "defense_context_documents_source_key_key" ON "defense_context_documents"("source_key");

-- CreateIndex
CREATE UNIQUE INDEX "defense_context_documents_current_revision_key" ON "defense_context_documents"("current_revision_id");

-- CreateIndex
CREATE INDEX "defense_context_documents_family_publisher_idx" ON "defense_context_documents"("family", "publisher", "published_at" DESC);

-- CreateIndex
CREATE INDEX "defense_context_documents_coverage_idx" ON "defense_context_documents"("coverage", "qualification", "eligible");

-- CreateIndex
CREATE INDEX "defense_context_document_revisions_observed_idx" ON "defense_context_document_revisions"("document_id", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "defense_context_document_revisions_source_document_idx" ON "defense_context_document_revisions"("source_document_id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_context_document_revisions_version_hash_key" ON "defense_context_document_revisions"("document_id", "version", "content_hash");

-- CreateIndex
CREATE INDEX "defense_context_sections_locator_idx" ON "defense_context_sections"("revision_id", "native_locator");

-- CreateIndex
CREATE UNIQUE INDEX "defense_context_sections_revision_ordinal_key" ON "defense_context_sections"("revision_id", "ordinal");

-- CreateIndex
CREATE INDEX "defense_reference_occurrences_source_idx" ON "defense_reference_occurrences"("document_id", "revision_id", "section_id");

-- CreateIndex
CREATE INDEX "defense_reference_occurrences_target_idx" ON "defense_reference_occurrences"("resolved_target_document_id", "disposition");

-- CreateIndex
CREATE INDEX "defense_reference_occurrences_type_idx" ON "defense_reference_occurrences"("reference_type", "disposition");

-- CreateIndex
CREATE INDEX "research_portfolio_fit_versions_history_idx" ON "research_portfolio_fit_versions"("tenant_id", "portfolio_id", "client_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_fit_versions_basis_key" ON "research_portfolio_fit_versions"("tenant_id", "portfolio_id", "client_id", "basis_fingerprint");

-- CreateIndex
CREATE INDEX "defense_saved_comparisons_owner_list_idx" ON "defense_saved_comparisons"("tenant_id", "owner_user_id", "archived_at", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "defense_saved_comparisons_portfolio_idx" ON "defense_saved_comparisons"("tenant_id", "portfolio_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "defense_saved_comparisons_tenant_id_key" ON "defense_saved_comparisons"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "defense_saved_compare_versions_timeline_idx" ON "defense_saved_comparison_versions"("tenant_id", "comparison_id", "captured_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "defense_saved_compare_version_parent_id_key" ON "defense_saved_comparison_versions"("tenant_id", "comparison_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "defense_saved_compare_version_number_key" ON "defense_saved_comparison_versions"("tenant_id", "comparison_id", "version");

-- CreateIndex
CREATE INDEX "defense_saved_compare_events_timeline_idx" ON "defense_saved_comparison_events"("tenant_id", "comparison_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "defense_saved_compare_events_idempotency_key" ON "defense_saved_comparison_events"("tenant_id", "actor_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "research_portfolio_client_filing_jobs_status_idx" ON "research_portfolio_client_filing_jobs"("tenant_id", "portfolio_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_client_filing_jobs_tenant_id_key" ON "research_portfolio_client_filing_jobs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_client_filing_jobs_actor_operation_key" ON "research_portfolio_client_filing_jobs"("tenant_id", "actor_user_id", "operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "research_portfolio_client_filing_jobs_receipt_operation_key" ON "research_portfolio_client_filing_jobs"("tenant_id", "receipt_operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "tango_subaward_provider_key_key" ON "tango_subaward"("provider_key");

-- CreateIndex
CREATE INDEX "tango_subaward_award_key_idx" ON "tango_subaward"("award_key");

-- CreateIndex
CREATE INDEX "tango_subaward_prime_uei_idx" ON "tango_subaward"("prime_recipient_uei");

-- CreateIndex
CREATE INDEX "tango_subaward_recipient_uei_idx" ON "tango_subaward"("subawardee_uei");

-- CreateIndex
CREATE INDEX "tango_subaward_action_date_idx" ON "tango_subaward"("action_date" DESC, "provider_key");

-- CreateIndex
CREATE INDEX "tango_subaward_district_idx" ON "tango_subaward"("pop_state", "pop_congressional_district", "action_date" DESC);

-- CreateIndex
CREATE INDEX "tango_subaward_awarding_agency_idx" ON "tango_subaward"("awarding_agency", "action_date" DESC);

-- CreateIndex
CREATE INDEX "tango_subaward_naics_idx" ON "tango_subaward"("naics_code", "action_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "krisp_notetaker_preferences_tenant_id_user_id_key" ON "krisp_notetaker_preferences"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "krisp_meeting_imports_tenant_id_user_id_status_idx" ON "krisp_meeting_imports"("tenant_id", "user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "krisp_meeting_imports_tenant_id_user_id_document_id_key" ON "krisp_meeting_imports"("tenant_id", "user_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_activity_commands_request_key" ON "client_activity_commands"("tenant_id", "actor_user_id", "client_id", "request_id");

-- CreateIndex
CREATE INDEX "prospect_attachment_upload_intents_prospect_idx" ON "prospect_attachment_upload_intents"("tenant_id", "prospect_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_attachment_upload_intents_request_key" ON "prospect_attachment_upload_intents"("tenant_id", "actor_user_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_attachment_upload_intents_s3_key" ON "prospect_attachment_upload_intents"("tenant_id", "s3_key");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_recipient_access_token_key" ON "newsletter_recipient_access"("token");

-- CreateIndex
CREATE INDEX "newsletter_recipient_access_tenant_id_user_id_outreach_reco_idx" ON "newsletter_recipient_access"("tenant_id", "user_id", "outreach_record_id");

-- CreateIndex
CREATE INDEX "newsletter_review_email_deliveries_tenant_id_created_at_idx" ON "newsletter_review_email_deliveries"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "newsletter_review_email_deliveries_status_updated_at_idx" ON "newsletter_review_email_deliveries"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscriptions_tenant_id_user_id_email_key" ON "newsletter_subscriptions"("tenant_id", "user_id", "email");

-- CreateIndex
CREATE INDEX "newsletter_account_invitations_tenant_id_email_organization_idx" ON "newsletter_account_invitations"("tenant_id", "email", "organization_id");

-- CreateIndex
CREATE INDEX "newsletter_account_invitations_tenant_id_document_id_idx" ON "newsletter_account_invitations"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "newsletter_invitation_email_deliveries_tenant_id_created_at_idx" ON "newsletter_invitation_email_deliveries"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "newsletter_invitation_email_deliveries_status_updated_at_idx" ON "newsletter_invitation_email_deliveries"("status", "updated_at");

-- AddForeignKey
ALTER TABLE "canonical_entities" ADD CONSTRAINT "canonical_entities_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_entities" ADD CONSTRAINT "canonical_entities_merged_into_fkey" FOREIGN KEY ("merged_into_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_fkey" FOREIGN KEY ("entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_identifiers" ADD CONSTRAINT "entity_identifiers_entity_fkey" FOREIGN KEY ("entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_identifiers" ADD CONSTRAINT "entity_identifiers_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_resolutions" ADD CONSTRAINT "entity_resolutions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_resolutions" ADD CONSTRAINT "entity_resolutions_selected_entity_fkey" FOREIGN KEY ("selected_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_resolutions" ADD CONSTRAINT "entity_resolutions_correction_fkey" FOREIGN KEY ("correction_of_resolution_id") REFERENCES "entity_resolutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_entity_merges" ADD CONSTRAINT "canonical_entity_merges_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_entity_merges" ADD CONSTRAINT "canonical_entity_merges_source_fkey" FOREIGN KEY ("source_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_entity_merges" ADD CONSTRAINT "canonical_entity_merges_target_fkey" FOREIGN KEY ("target_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_identity_governance_events" ADD CONSTRAINT "entity_identity_governance_events_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_entity_backfill_checkpoints" ADD CONSTRAINT "canonical_entity_backfill_checkpoints_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_broadcasts" ADD CONSTRAINT "admin_broadcasts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_broadcasts" ADD CONSTRAINT "admin_broadcasts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_broadcast_recipients" ADD CONSTRAINT "admin_broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "admin_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_broadcast_recipients" ADD CONSTRAINT "admin_broadcast_recipients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_broadcast_recipients" ADD CONSTRAINT "admin_broadcast_recipients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_usage_meters" ADD CONSTRAINT "tenant_usage_meters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_canonical_entity_fkey" FOREIGN KEY ("canonical_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memory_access" ADD CONSTRAINT "client_memory_access_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memory_access" ADD CONSTRAINT "client_memory_access_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_memory_access" ADD CONSTRAINT "client_memory_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_objectives" ADD CONSTRAINT "client_objectives_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_objectives" ADD CONSTRAINT "client_objectives_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_objective_revisions" ADD CONSTRAINT "client_objective_revisions_tenant_id_client_id_objective_i_fkey" FOREIGN KEY ("tenant_id", "client_id", "objective_id") REFERENCES "client_objectives"("tenant_id", "client_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_ordered_owners" ADD CONSTRAINT "client_ordered_owners_client_fk" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "client_ordered_owners" ADD CONSTRAINT "client_ordered_owners_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "client_team_members" ADD CONSTRAINT "client_team_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_team_members" ADD CONSTRAINT "client_team_members_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_team_members" ADD CONSTRAINT "client_team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_opportunity_searches" ADD CONSTRAINT "saved_opportunity_searches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_opportunity_searches" ADD CONSTRAINT "saved_opportunity_searches_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_opportunity_searches" ADD CONSTRAINT "saved_opportunity_searches_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_contact_notes" ADD CONSTRAINT "directory_contact_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_contact_notes" ADD CONSTRAINT "directory_contact_notes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_contact_favorites" ADD CONSTRAINT "directory_contact_favorites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "directory_contact_favorites" ADD CONSTRAINT "directory_contact_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_connections" ADD CONSTRAINT "engagement_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_connection_tokens" ADD CONSTRAINT "engagement_connection_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_connection_tokens" ADD CONSTRAINT "engagement_connection_tokens_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "engagement_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_contacts" ADD CONSTRAINT "engagement_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_contacts" ADD CONSTRAINT "engagement_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "engagement_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "engagement_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_threads" ADD CONSTRAINT "mail_threads_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "engagement_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "mail_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "engagement_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_device_tokens" ADD CONSTRAINT "mobile_device_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_device_tokens" ADD CONSTRAINT "mobile_device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_attachments" ADD CONSTRAINT "engagement_attachments_superseded_by_attachment_id_fkey" FOREIGN KEY ("superseded_by_attachment_id") REFERENCES "engagement_attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_attachments" ADD CONSTRAINT "engagement_attachments_prospect_fkey" FOREIGN KEY ("tenant_id", "prospect_id") REFERENCES "business_development_prospects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_attachments" ADD CONSTRAINT "engagement_attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_attachments" ADD CONSTRAINT "engagement_attachments_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_attachments" ADD CONSTRAINT "engagement_attachments_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_attachments" ADD CONSTRAINT "engagement_attachments_mail_message_id_fkey" FOREIGN KEY ("mail_message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_attachments" ADD CONSTRAINT "engagement_attachments_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_attachments" ADD CONSTRAINT "engagement_attachments_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_prep_jobs" ADD CONSTRAINT "meeting_prep_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_prep_jobs" ADD CONSTRAINT "meeting_prep_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_prep_jobs" ADD CONSTRAINT "meeting_prep_jobs_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_prep_jobs" ADD CONSTRAINT "meeting_prep_jobs_prep_id_fkey" FOREIGN KEY ("prep_id") REFERENCES "meeting_preps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_prep_monday_mappings" ADD CONSTRAINT "meeting_prep_monday_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_prep_monday_mappings" ADD CONSTRAINT "meeting_prep_monday_mappings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_prep_monday_mappings" ADD CONSTRAINT "meeting_prep_monday_mappings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_preps" ADD CONSTRAINT "meeting_preps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_preps" ADD CONSTRAINT "meeting_preps_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_preps" ADD CONSTRAINT "meeting_preps_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_preps" ADD CONSTRAINT "meeting_preps_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_debriefs" ADD CONSTRAINT "meeting_debriefs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_debriefs" ADD CONSTRAINT "meeting_debriefs_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_debriefs" ADD CONSTRAINT "meeting_debriefs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_debriefs" ADD CONSTRAINT "meeting_debriefs_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_debriefs" ADD CONSTRAINT "meeting_debriefs_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_notetaker_preferences" ADD CONSTRAINT "client_notetaker_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_notetaker_preferences" ADD CONSTRAINT "client_notetaker_preferences_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_notetaker_preferences" ADD CONSTRAINT "client_notetaker_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_bot_sessions" ADD CONSTRAINT "meeting_bot_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_bot_sessions" ADD CONSTRAINT "meeting_bot_sessions_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_bot_sessions" ADD CONSTRAINT "meeting_bot_sessions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_tasks" ADD CONSTRAINT "engagement_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_tasks" ADD CONSTRAINT "engagement_tasks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_tasks" ADD CONSTRAINT "engagement_tasks_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_tasks" ADD CONSTRAINT "engagement_tasks_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "engagement_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_tasks" ADD CONSTRAINT "engagement_tasks_mail_thread_id_fkey" FOREIGN KEY ("mail_thread_id") REFERENCES "mail_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_report_target_offices" ADD CONSTRAINT "engagement_report_target_offices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_report_target_offices" ADD CONSTRAINT "engagement_report_target_offices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_report_target_offices" ADD CONSTRAINT "engagement_report_target_offices_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_report_target_overrides" ADD CONSTRAINT "engagement_report_target_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_report_target_overrides" ADD CONSTRAINT "engagement_report_overrides_target_tenant_fkey" FOREIGN KEY ("target_id", "tenant_id") REFERENCES "engagement_report_target_offices"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_records" ADD CONSTRAINT "outreach_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_records" ADD CONSTRAINT "outreach_records_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_records" ADD CONSTRAINT "outreach_records_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_records" ADD CONSTRAINT "outreach_records_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_templates" ADD CONSTRAINT "outreach_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_templates" ADD CONSTRAINT "outreach_templates_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_audiences" ADD CONSTRAINT "outreach_audiences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_audience_members" ADD CONSTRAINT "outreach_audience_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_audience_members" ADD CONSTRAINT "outreach_audience_members_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "outreach_audiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_ai_template" ADD CONSTRAINT "outreach_ai_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_ai_template" ADD CONSTRAINT "outreach_ai_template_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_association_overrides" ADD CONSTRAINT "client_association_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_association_overrides" ADD CONSTRAINT "client_association_overrides_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_embeddings" ADD CONSTRAINT "context_embeddings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "clio_conversations" ADD CONSTRAINT "clio_conversations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "meri_workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_saved_prompts" ADD CONSTRAINT "meri_saved_prompts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_saved_prompts" ADD CONSTRAINT "meri_saved_prompts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_workspaces" ADD CONSTRAINT "meri_workspaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_workspaces" ADD CONSTRAINT "meri_workspaces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_workspaces" ADD CONSTRAINT "meri_workspaces_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_vnext_preferences" ADD CONSTRAINT "meri_vnext_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_vnext_preferences" ADD CONSTRAINT "meri_vnext_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_messages" ADD CONSTRAINT "clio_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_messages" ADD CONSTRAINT "clio_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_messages" ADD CONSTRAINT "clio_messages_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_messages" ADD CONSTRAINT "clio_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "clio_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_artifacts" ADD CONSTRAINT "clio_artifacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_artifacts" ADD CONSTRAINT "clio_artifacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_artifacts" ADD CONSTRAINT "clio_artifacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_artifacts" ADD CONSTRAINT "clio_artifacts_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "clio_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_artifacts" ADD CONSTRAINT "clio_artifacts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "clio_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_artifacts" ADD CONSTRAINT "clio_artifacts_parent_artifact_id_fkey" FOREIGN KEY ("parent_artifact_id") REFERENCES "clio_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_attachments" ADD CONSTRAINT "clio_attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_attachments" ADD CONSTRAINT "clio_attachments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_research_sessions" ADD CONSTRAINT "clio_research_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_research_sessions" ADD CONSTRAINT "clio_research_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_research_sessions" ADD CONSTRAINT "clio_research_sessions_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_notes" ADD CONSTRAINT "clio_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_notes" ADD CONSTRAINT "clio_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_notes" ADD CONSTRAINT "clio_notes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_notes" ADD CONSTRAINT "clio_notes_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "clio_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_notes" ADD CONSTRAINT "clio_notes_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_memory" ADD CONSTRAINT "clio_memory_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_action_approval" ADD CONSTRAINT "meri_action_approval_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_pending_action" ADD CONSTRAINT "meri_pending_action_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_action_proposals" ADD CONSTRAINT "meri_action_proposals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_scheduled_task" ADD CONSTRAINT "clio_scheduled_task_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_mcp_servers" ADD CONSTRAINT "clio_mcp_servers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_mcp_oauth_credentials" ADD CONSTRAINT "clio_mcp_oauth_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_mcp_oauth_credentials" ADD CONSTRAINT "clio_mcp_oauth_credentials_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "clio_mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_firm_skills" ADD CONSTRAINT "clio_firm_skills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meri_audit_ledger" ADD CONSTRAINT "meri_audit_ledger_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_request" ADD CONSTRAINT "review_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_generation_record" ADD CONSTRAINT "alert_generation_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_generation_record" ADD CONSTRAINT "alert_generation_record_review_request_id_fkey" FOREIGN KEY ("review_request_id") REFERENCES "review_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcome_event" ADD CONSTRAINT "outcome_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_packet" ADD CONSTRAINT "context_packet_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_jobs" ADD CONSTRAINT "outreach_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_job_items" ADD CONSTRAINT "outreach_job_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "outreach_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_job_items" ADD CONSTRAINT "outreach_job_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_artifacts" ADD CONSTRAINT "outreach_draft_artifacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_artifacts" ADD CONSTRAINT "outreach_draft_artifacts_outreach_record_id_fkey" FOREIGN KEY ("outreach_record_id") REFERENCES "outreach_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_artifacts" ADD CONSTRAINT "outreach_draft_artifacts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_versions" ADD CONSTRAINT "outreach_draft_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_versions" ADD CONSTRAINT "outreach_draft_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "outreach_draft_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_versions" ADD CONSTRAINT "outreach_draft_versions_source_version_id_fkey" FOREIGN KEY ("source_version_id") REFERENCES "outreach_draft_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_versions" ADD CONSTRAINT "outreach_draft_versions_review_request_id_fkey" FOREIGN KEY ("review_request_id") REFERENCES "review_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_versions" ADD CONSTRAINT "outreach_draft_versions_context_packet_id_fkey" FOREIGN KEY ("context_packet_id") REFERENCES "context_packet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_draft_versions" ADD CONSTRAINT "outreach_draft_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_send_intents" ADD CONSTRAINT "outreach_send_intents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_send_intents" ADD CONSTRAINT "outreach_send_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_send_intents" ADD CONSTRAINT "outreach_send_intents_outreach_record_id_fkey" FOREIGN KEY ("outreach_record_id") REFERENCES "outreach_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_send_intents" ADD CONSTRAINT "outreach_send_intents_sender_connection_id_fkey" FOREIGN KEY ("sender_connection_id") REFERENCES "engagement_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_deliveries" ADD CONSTRAINT "outreach_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_deliveries" ADD CONSTRAINT "outreach_deliveries_send_intent_id_fkey" FOREIGN KEY ("send_intent_id") REFERENCES "outreach_send_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_deliveries" ADD CONSTRAINT "outreach_deliveries_draft_version_id_fkey" FOREIGN KEY ("draft_version_id") REFERENCES "outreach_draft_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_ai_credentials" ADD CONSTRAINT "tenant_ai_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_proactive_alerts" ADD CONSTRAINT "clio_proactive_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clio_proactive_alerts" ADD CONSTRAINT "clio_proactive_alerts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_capabilities" ADD CONSTRAINT "client_capabilities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_capabilities" ADD CONSTRAINT "client_capabilities_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_submission_history" ADD CONSTRAINT "client_submission_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_submission_history" ADD CONSTRAINT "client_submission_history_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_submission_history" ADD CONSTRAINT "client_submission_history_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "client_capabilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_people" ADD CONSTRAINT "client_people_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_people" ADD CONSTRAINT "client_people_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_people" ADD CONSTRAINT "client_people_reports_to_prisma_fk" FOREIGN KEY ("reports_to_person_id") REFERENCES "client_people"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_activity" ADD CONSTRAINT "client_activity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_activity" ADD CONSTRAINT "client_activity_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_facilities" ADD CONSTRAINT "client_facilities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_facilities" ADD CONSTRAINT "client_facilities_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_targets" ADD CONSTRAINT "client_targets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_targets" ADD CONSTRAINT "client_targets_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_targets" ADD CONSTRAINT "client_targets_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_target_recommendations" ADD CONSTRAINT "client_target_recommendations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_target_recommendations" ADD CONSTRAINT "client_target_recommendations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_capability_fit_recommendations" ADD CONSTRAINT "client_capability_fit_recommendations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_capability_fit_recommendations" ADD CONSTRAINT "client_capability_fit_recommendations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_recommendation" ADD CONSTRAINT "action_recommendation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_recommendation" ADD CONSTRAINT "action_recommendation_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_campaigns" ADD CONSTRAINT "engagement_campaigns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_campaigns" ADD CONSTRAINT "engagement_campaigns_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_campaigns" ADD CONSTRAINT "engagement_campaigns_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_campaign_recipients" ADD CONSTRAINT "engagement_campaign_recipients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_campaign_recipients" ADD CONSTRAINT "engagement_campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "engagement_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "congress_bill_cosponsor" ADD CONSTRAINT "congress_bill_cosponsor_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "congress_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "congress_committee_membership" ADD CONSTRAINT "congress_committee_membership_system_code_fkey" FOREIGN KEY ("system_code") REFERENCES "congress_committee"("system_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_vote" ADD CONSTRAINT "member_vote_vote_id_fkey" FOREIGN KEY ("vote_id") REFERENCES "roll_call_vote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_evidence_passage" ADD CONSTRAINT "federal_evidence_passage_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "federal_evidence_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "congress_bill_action" ADD CONSTRAINT "congress_bill_action_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "congress_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "congress_bill_committee" ADD CONSTRAINT "congress_bill_committee_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "congress_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "congress_bill_subject" ADD CONSTRAINT "congress_bill_subject_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "congress_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_source" ADD CONSTRAINT "program_element_source_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_source" ADD CONSTRAINT "program_element_source_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_project" ADD CONSTRAINT "program_element_project_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_project" ADD CONSTRAINT "program_element_project_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_year" ADD CONSTRAINT "program_element_year_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_line_year" ADD CONSTRAINT "procurement_line_year_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "procurement_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_line_source" ADD CONSTRAINT "procurement_line_source_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "procurement_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_line_source" ADD CONSTRAINT "procurement_line_source_year_id_fkey" FOREIGN KEY ("year_id") REFERENCES "procurement_line_year"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_line_source" ADD CONSTRAINT "procurement_line_source_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_budget_position" ADD CONSTRAINT "program_element_budget_position_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_budget_position" ADD CONSTRAINT "program_element_budget_position_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_project_budget_position" ADD CONSTRAINT "program_element_project_budget_position_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_project_budget_position" ADD CONSTRAINT "program_element_project_budget_position_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_delta" ADD CONSTRAINT "program_element_delta_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_milestone" ADD CONSTRAINT "program_element_milestone_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_milestone_schedule_period" ADD CONSTRAINT "program_element_milestone_schedule_period_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "program_element_milestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_milestone_schedule_period" ADD CONSTRAINT "program_element_milestone_schedule_period_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_milestone_schedule_period" ADD CONSTRAINT "program_element_milestone_schedule_period_source_document__fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_year_source_value" ADD CONSTRAINT "program_element_year_source_value_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_year_source_value" ADD CONSTRAINT "program_element_year_source_value_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_document" ADD CONSTRAINT "source_document_superseded_by_document_id_fkey" FOREIGN KEY ("superseded_by_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_funding_request_source" ADD CONSTRAINT "community_funding_request_source_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "community_funding_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_funding_request_source" ADD CONSTRAINT "community_funding_request_source_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_funding_discovery_candidate" ADD CONSTRAINT "community_funding_discovery_candidate_crawl_id_fkey" FOREIGN KEY ("crawl_id") REFERENCES "community_funding_discovery_crawl"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_parse_job" ADD CONSTRAINT "document_parse_job_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_watch" ADD CONSTRAINT "program_element_watch_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_watch" ADD CONSTRAINT "program_element_watch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_watch" ADD CONSTRAINT "program_element_watch_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_client_watch_event" ADD CONSTRAINT "defense_budget_client_watch_event_watch_id_fkey" FOREIGN KEY ("watch_id") REFERENCES "defense_budget_client_watch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_data_issue" ADD CONSTRAINT "program_element_data_issue_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_data_issue" ADD CONSTRAINT "program_element_data_issue_reported_by_user_id_fkey" FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_data_issue" ADD CONSTRAINT "program_element_data_issue_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_data_issue" ADD CONSTRAINT "program_element_data_issue_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pe_alert_email_pref" ADD CONSTRAINT "pe_alert_email_pref_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pe_alert_email_pref" ADD CONSTRAINT "pe_alert_email_pref_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition_personnel_source" ADD CONSTRAINT "acquisition_personnel_source_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "acquisition_personnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conference_probability" ADD CONSTRAINT "conference_probability_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bls_data_point" ADD CONSTRAINT "bls_data_point_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "bls_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_bill_action" ADD CONSTRAINT "state_bill_action_bill_key_fkey" FOREIGN KEY ("bill_key") REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_bill_sponsor" ADD CONSTRAINT "state_bill_sponsor_bill_key_fkey" FOREIGN KEY ("bill_key") REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_member_vote" ADD CONSTRAINT "state_member_vote_vote_id_fkey" FOREIGN KEY ("vote_id") REFERENCES "state_roll_call_vote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_bill_version" ADD CONSTRAINT "state_bill_version_bill_key_fkey" FOREIGN KEY ("bill_key") REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_bill_link" ADD CONSTRAINT "state_bill_link_bill_key_fkey" FOREIGN KEY ("bill_key") REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_bill_calendar_event" ADD CONSTRAINT "state_bill_calendar_event_bill_key_fkey" FOREIGN KEY ("bill_key") REFERENCES "state_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_committee_membership" ADD CONSTRAINT "state_committee_membership_committee_id_fkey" FOREIGN KEY ("committee_id") REFERENCES "state_committee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_committee_membership" ADD CONSTRAINT "state_committee_membership_legislator_id_fkey" FOREIGN KEY ("legislator_id") REFERENCES "state_legislator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committee_hearing" ADD CONSTRAINT "committee_hearing_canonical_hearing_id_fkey" FOREIGN KEY ("canonical_hearing_id") REFERENCES "committee_hearing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committee_source_exception" ADD CONSTRAINT "committee_source_exception_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "committee_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hearing_source_observation" ADD CONSTRAINT "hearing_source_observation_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "committee_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hearing_stream_candidate" ADD CONSTRAINT "hearing_stream_candidate_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "committee_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_hearing_capture_attempt" ADD CONSTRAINT "public_hearing_capture_attempt_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_hearing_transcript_segment" ADD CONSTRAINT "public_hearing_transcript_segment_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_hearing_speaker" ADD CONSTRAINT "public_hearing_speaker_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committee_site_update" ADD CONSTRAINT "committee_site_update_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "committee_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_hearing_insight" ADD CONSTRAINT "public_hearing_insight_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_hearing_insight" ADD CONSTRAINT "public_hearing_insight_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public_hearing_transcript_segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_hearing_intelligence_job" ADD CONSTRAINT "public_hearing_intelligence_job_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public_hearing_transcript_segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_hearing_relevance" ADD CONSTRAINT "tenant_hearing_relevance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_hearing_relevance" ADD CONSTRAINT "tenant_hearing_relevance_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_hearing_relevance" ADD CONSTRAINT "tenant_hearing_relevance_insight_id_fkey" FOREIGN KEY ("insight_id") REFERENCES "public_hearing_insight"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_hearing_relevance_job" ADD CONSTRAINT "tenant_hearing_relevance_job_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_grant_nexus" ADD CONSTRAINT "client_grant_nexus_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_grant_nexus" ADD CONSTRAINT "client_grant_nexus_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_funding_opportunity" ADD CONSTRAINT "client_funding_opportunity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_funding_opportunity" ADD CONSTRAINT "client_funding_opportunity_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_bookmarks" ADD CONSTRAINT "opportunity_bookmarks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_bookmarks" ADD CONSTRAINT "opportunity_bookmarks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tango_budget_vendor_flow" ADD CONSTRAINT "tango_budget_vendor_flow_budget_account_id_fkey" FOREIGN KEY ("budget_account_id") REFERENCES "tango_budget_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_opportunity_stage_transition" ADD CONSTRAINT "funding_opportunity_stage_transition_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_opportunity_stage_transition" ADD CONSTRAINT "funding_opportunity_stage_transition_client_funding_opport_fkey" FOREIGN KEY ("client_funding_opportunity_id") REFERENCES "client_funding_opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_performer" ADD CONSTRAINT "program_element_performer_pe_code_fkey" FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_element_performer" ADD CONSTRAINT "program_element_performer_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_alias" ADD CONSTRAINT "program_alias_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_identity_crosswalk" ADD CONSTRAINT "program_identity_crosswalk_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_identity_crosswalk" ADD CONSTRAINT "program_identity_crosswalk_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_identity_crosswalk" ADD CONSTRAINT "program_identity_crosswalk_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "program_identity_crosswalk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition_award_transaction_revision" ADD CONSTRAINT "acquisition_award_transaction_revision_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "acquisition_award_transaction_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_acquisition_relationship" ADD CONSTRAINT "program_acquisition_relationship_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "program_acquisition_relationship"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pe_program_match" ADD CONSTRAINT "pe_program_match_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sam_opportunity_match" ADD CONSTRAINT "sam_opportunity_match_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "sam_opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sam_opportunity_match" ADD CONSTRAINT "sam_opportunity_match_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committee_report_provision" ADD CONSTRAINT "committee_report_provision_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provision_pe_link" ADD CONSTRAINT "provision_pe_link_provision_id_fkey" FOREIGN KEY ("provision_id") REFERENCES "committee_report_provision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provision_pe_link" ADD CONSTRAINT "provision_pe_link_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_office" ADD CONSTRAINT "program_office_parent_office_id_fkey" FOREIGN KEY ("parent_office_id") REFERENCES "program_office"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_role" ADD CONSTRAINT "person_role_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "acquisition_personnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_role" ADD CONSTRAINT "person_role_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "program_office"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_role" ADD CONSTRAINT "person_role_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_office_program_link" ADD CONSTRAINT "program_office_program_link_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "program_office"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_office_program_link" ADD CONSTRAINT "program_office_program_link_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "program"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_ingest_run_id_fkey" FOREIGN KEY ("ingest_run_id") REFERENCES "memory_ingest_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_contradicts_id_fkey" FOREIGN KEY ("contradicts_id") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_src_item_id_fkey" FOREIGN KEY ("src_item_id") REFERENCES "memory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "memory_candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_revision_root_fk" FOREIGN KEY ("tenant_id", "revision_root_id") REFERENCES "memory_candidate"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_predecessor_fk" FOREIGN KEY ("tenant_id", "predecessor_candidate_id") REFERENCES "memory_candidate"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_superseded_by_fk" FOREIGN KEY ("tenant_id", "superseded_by_id") REFERENCES "memory_candidate"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_duplicate_memory_item_id_fkey" FOREIGN KEY ("duplicate_memory_item_id") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_contradicts_memory_item_id_fkey" FOREIGN KEY ("contradicts_memory_item_id") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_committed_memory_item_id_fkey" FOREIGN KEY ("committed_memory_item_id") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_ingest_run" ADD CONSTRAINT "memory_ingest_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_access_grant" ADD CONSTRAINT "memory_access_grant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_access_grant" ADD CONSTRAINT "memory_access_grant_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_access_grant" ADD CONSTRAINT "memory_access_grant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_transition_audit" ADD CONSTRAINT "memory_transition_audit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_cleanup_outbox" ADD CONSTRAINT "memory_cleanup_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_signal" ADD CONSTRAINT "learning_signal_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_signal_candidate_outcome" ADD CONSTRAINT "learning_signal_candidate_outcome_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_signal_candidate_outcome" ADD CONSTRAINT "learning_signal_candidate_outcome_learning_signal_id_fkey" FOREIGN KEY ("learning_signal_id") REFERENCES "learning_signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_signal_candidate_outcome" ADD CONSTRAINT "learning_signal_candidate_outcome_memory_candidate_id_fkey" FOREIGN KEY ("memory_candidate_id") REFERENCES "memory_candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_telemetry_event" ADD CONSTRAINT "quality_telemetry_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_telemetry_event" ADD CONSTRAINT "quality_telemetry_event_context_packet_id_fkey" FOREIGN KEY ("context_packet_id") REFERENCES "context_packet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_telemetry_event" ADD CONSTRAINT "quality_telemetry_event_learning_signal_id_fkey" FOREIGN KEY ("learning_signal_id") REFERENCES "learning_signal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_telemetry_event" ADD CONSTRAINT "quality_telemetry_event_memory_candidate_id_fkey" FOREIGN KEY ("memory_candidate_id") REFERENCES "memory_candidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_telemetry_memory_item_use" ADD CONSTRAINT "quality_telemetry_memory_item_use_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_telemetry_memory_item_use" ADD CONSTRAINT "quality_telemetry_memory_item_use_telemetry_event_id_fkey" FOREIGN KEY ("telemetry_event_id") REFERENCES "quality_telemetry_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quality_telemetry_memory_item_use" ADD CONSTRAINT "quality_telemetry_memory_item_use_memory_item_id_fkey" FOREIGN KEY ("memory_item_id") REFERENCES "memory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_record" ADD CONSTRAINT "evaluation_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_record" ADD CONSTRAINT "evaluation_record_context_packet_id_fkey" FOREIGN KEY ("context_packet_id") REFERENCES "context_packet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_record" ADD CONSTRAINT "evaluation_record_quality_telemetry_event_id_fkey" FOREIGN KEY ("quality_telemetry_event_id") REFERENCES "quality_telemetry_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_budget_line_match" ADD CONSTRAINT "capability_budget_line_match_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "capability"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_package_vehicle" ADD CONSTRAINT "budget_package_vehicle_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "budget_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_package_vehicle" ADD CONSTRAINT "budget_package_vehicle_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_position" ADD CONSTRAINT "funding_position_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "budget_package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_position" ADD CONSTRAINT "funding_position_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "budget_package_vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "funding_position" ADD CONSTRAINT "funding_position_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_interim_funding_period" ADD CONSTRAINT "budget_interim_funding_period_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_policy_pack" ADD CONSTRAINT "compliance_policy_pack_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_policy_pack_event" ADD CONSTRAINT "compliance_policy_pack_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_policy_pack_event" ADD CONSTRAINT "compliance_policy_pack_event_policy_pack_id_fkey" FOREIGN KEY ("policy_pack_id") REFERENCES "compliance_policy_pack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_policy_decision" ADD CONSTRAINT "compliance_policy_decision_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_policy_decision" ADD CONSTRAINT "compliance_policy_decision_policy_pack_id_fkey" FOREIGN KEY ("policy_pack_id") REFERENCES "compliance_policy_pack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assurance_eval_run" ADD CONSTRAINT "assurance_eval_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assurance_eval_result" ADD CONSTRAINT "assurance_eval_result_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assurance_eval_result" ADD CONSTRAINT "assurance_eval_result_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "assurance_eval_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assurance_eval_domain_gate" ADD CONSTRAINT "assurance_eval_domain_gate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assurance_eval_domain_gate" ADD CONSTRAINT "assurance_eval_domain_gate_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "assurance_eval_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assurance_feedback_candidate" ADD CONSTRAINT "assurance_feedback_candidate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assurance_eval_fixture" ADD CONSTRAINT "assurance_eval_fixture_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assurance_eval_fixture" ADD CONSTRAINT "assurance_eval_fixture_source_candidate_id_fkey" FOREIGN KEY ("source_candidate_id") REFERENCES "assurance_feedback_candidate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_verification_run_v1" ADD CONSTRAINT "budget_verification_run_v1_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_verification_check_v1" ADD CONSTRAINT "budget_verification_check_v1_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_verification_proof" ADD CONSTRAINT "budget_verification_proof_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_verification_discrepancy_v1" ADD CONSTRAINT "budget_verification_discrepancy_v1_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_verification_discrepancy_v1" ADD CONSTRAINT "budget_verification_discrepancy_v1_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_review_decision_v1" ADD CONSTRAINT "budget_review_decision_v1_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_review_decision_v1" ADD CONSTRAINT "budget_review_decision_v1_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_scoped_fact_review_v1" ADD CONSTRAINT "budget_scoped_fact_review_v1_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_scoped_fact_review_v1" ADD CONSTRAINT "budget_scoped_fact_review_v1_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_scoped_fact_review_v1" ADD CONSTRAINT "budget_scoped_fact_review_v1_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "budget_scoped_fact_review_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_scoped_fact_review_v1" ADD CONSTRAINT "budget_scoped_fact_review_v1_acknowledged_revoked_review_i_fkey" FOREIGN KEY ("acknowledged_revoked_review_id") REFERENCES "budget_scoped_fact_review_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_candidate_correction_v1" ADD CONSTRAINT "budget_candidate_correction_v1_old_candidate_id_fkey" FOREIGN KEY ("old_candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_candidate_correction_v1" ADD CONSTRAINT "budget_candidate_correction_v1_new_candidate_id_fkey" FOREIGN KEY ("new_candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_active_snapshot" ADD CONSTRAINT "defense_budget_active_snapshot_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_plan" ADD CONSTRAINT "defense_budget_promotion_plan_eligibility_hash_fkey" FOREIGN KEY ("eligibility_hash") REFERENCES "defense_budget_promotion_eligibility"("eligibility_hash") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "defense_budget_manual_override" ADD CONSTRAINT "defense_budget_manual_override_prior_override_id_fkey" FOREIGN KEY ("prior_override_id") REFERENCES "defense_budget_manual_override"("override_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_authorization" ADD CONSTRAINT "defense_budget_promotion_authorization_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "defense_budget_promotion_plan"("plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_run" ADD CONSTRAINT "defense_budget_promotion_run_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "defense_budget_promotion_plan"("plan_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_run" ADD CONSTRAINT "defense_budget_promotion_run_authorization_id_fkey" FOREIGN KEY ("authorization_id") REFERENCES "defense_budget_promotion_authorization"("authorization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_run" ADD CONSTRAINT "defense_budget_promotion_run_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_item" ADD CONSTRAINT "defense_budget_promotion_item_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "defense_budget_promotion_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_activation" ADD CONSTRAINT "defense_budget_promotion_activation_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "defense_budget_promotion_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_activation" ADD CONSTRAINT "defense_budget_promotion_activation_new_snapshot_id_fkey" FOREIGN KEY ("new_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_activation" ADD CONSTRAINT "defense_budget_promotion_activation_previous_snapshot_id_fkey" FOREIGN KEY ("previous_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_rollback_record" ADD CONSTRAINT "defense_budget_rollback_record_from_snapshot_id_fkey" FOREIGN KEY ("from_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_rollback_record" ADD CONSTRAINT "defense_budget_rollback_record_to_snapshot_id_fkey" FOREIGN KEY ("to_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_rollback_record" ADD CONSTRAINT "defense_budget_rollback_record_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "defense_budget_promotion_activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_promotion_outbox" ADD CONSTRAINT "defense_budget_promotion_outbox_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "defense_budget_promotion_activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_canonical_delta" ADD CONSTRAINT "defense_budget_canonical_delta_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "defense_budget_promotion_activation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_canonical_delta" ADD CONSTRAINT "defense_budget_canonical_delta_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "defense_budget_promotion_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_canonical_delta" ADD CONSTRAINT "defense_budget_canonical_delta_old_snapshot_id_fkey" FOREIGN KEY ("old_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_canonical_delta" ADD CONSTRAINT "defense_budget_canonical_delta_new_snapshot_id_fkey" FOREIGN KEY ("new_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_compatibility_projection_run" ADD CONSTRAINT "defense_budget_compatibility_projection_run_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_canonical_row" ADD CONSTRAINT "defense_budget_canonical_row_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_canonical_row" ADD CONSTRAINT "defense_budget_canonical_row_promotion_run_id_fkey" FOREIGN KEY ("promotion_run_id") REFERENCES "defense_budget_promotion_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "x_post_cache" ADD CONSTRAINT "x_post_cache_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "x_tracked_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "x_feed_subscription" ADD CONSTRAINT "x_feed_subscription_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "x_tracked_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_events" ADD CONSTRAINT "knowledge_events_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_assertions" ADD CONSTRAINT "knowledge_assertions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_assertions" ADD CONSTRAINT "knowledge_assertions_origin_event_fkey" FOREIGN KEY ("origin_event_id") REFERENCES "knowledge_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_assertions" ADD CONSTRAINT "knowledge_assertions_supersedes_fkey" FOREIGN KEY ("supersedes_assertion_id") REFERENCES "knowledge_assertions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_assertions" ADD CONSTRAINT "knowledge_assertions_contradicts_fkey" FOREIGN KEY ("contradicts_assertion_id") REFERENCES "knowledge_assertions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_assertion_fkey" FOREIGN KEY ("assertion_id") REFERENCES "knowledge_assertions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_evidence" ADD CONSTRAINT "knowledge_evidence_event_fkey" FOREIGN KEY ("event_id") REFERENCES "knowledge_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_mailbox_jobs" ADD CONSTRAINT "knowledge_mailbox_jobs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_mailbox_jobs" ADD CONSTRAINT "knowledge_mailbox_jobs_message_fkey" FOREIGN KEY ("mail_message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_mailbox_jobs" ADD CONSTRAINT "knowledge_mailbox_jobs_event_fkey" FOREIGN KEY ("result_event_id") REFERENCES "knowledge_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_mailbox_extraction_jobs" ADD CONSTRAINT "knowledge_mailbox_extraction_jobs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_mailbox_extraction_jobs" ADD CONSTRAINT "knowledge_mailbox_extraction_jobs_mailbox_job_fkey" FOREIGN KEY ("mailbox_job_id") REFERENCES "knowledge_mailbox_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_mailbox_extraction_jobs" ADD CONSTRAINT "knowledge_mailbox_extraction_jobs_message_fkey" FOREIGN KEY ("mail_message_id") REFERENCES "mail_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_mailbox_extraction_jobs" ADD CONSTRAINT "knowledge_mailbox_extraction_jobs_event_fkey" FOREIGN KEY ("event_id") REFERENCES "knowledge_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episodes" ADD CONSTRAINT "knowledge_episodes_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_events" ADD CONSTRAINT "knowledge_episode_events_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_events" ADD CONSTRAINT "knowledge_episode_events_episode_fkey" FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_events" ADD CONSTRAINT "knowledge_episode_events_event_fkey" FOREIGN KEY ("event_id") REFERENCES "knowledge_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_assertions" ADD CONSTRAINT "knowledge_episode_assertions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_assertions" ADD CONSTRAINT "knowledge_episode_assertions_episode_fkey" FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_assertions" ADD CONSTRAINT "knowledge_episode_assertions_assertion_fkey" FOREIGN KEY ("assertion_id") REFERENCES "knowledge_assertions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_assertions" ADD CONSTRAINT "knowledge_episode_assertions_origin_event_fkey" FOREIGN KEY ("origin_event_id") REFERENCES "knowledge_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_entities" ADD CONSTRAINT "knowledge_episode_entities_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_entities" ADD CONSTRAINT "knowledge_episode_entities_episode_fkey" FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_entities" ADD CONSTRAINT "knowledge_episode_entities_entity_fkey" FOREIGN KEY ("canonical_entity_id") REFERENCES "canonical_entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_projection_jobs" ADD CONSTRAINT "knowledge_episode_projection_jobs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_projection_jobs" ADD CONSTRAINT "knowledge_episode_projection_jobs_event_fkey" FOREIGN KEY ("event_id") REFERENCES "knowledge_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_episode_projection_jobs" ADD CONSTRAINT "knowledge_episode_projection_jobs_episode_fkey" FOREIGN KEY ("episode_id") REFERENCES "knowledge_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_measure" ADD CONSTRAINT "federal_funding_measure_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_provision" ADD CONSTRAINT "federal_funding_provision_measure_id_fkey" FOREIGN KEY ("measure_id") REFERENCES "federal_funding_measure"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_provision" ADD CONSTRAINT "federal_funding_provision_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_allocation" ADD CONSTRAINT "federal_funding_allocation_provision_id_fkey" FOREIGN KEY ("provision_id") REFERENCES "federal_funding_provision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_allocation" ADD CONSTRAINT "federal_funding_allocation_evidence_source_document_id_fkey" FOREIGN KEY ("evidence_source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_allocation" ADD CONSTRAINT "federal_funding_allocation_source_event_id_fkey" FOREIGN KEY ("source_event_id") REFERENCES "federal_funding_source_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_allocation" ADD CONSTRAINT "federal_funding_allocation_correction_of_allocation_id_fkey" FOREIGN KEY ("correction_of_allocation_id") REFERENCES "federal_funding_allocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_source_event" ADD CONSTRAINT "federal_funding_source_event_measure_id_fkey" FOREIGN KEY ("measure_id") REFERENCES "federal_funding_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_source_event" ADD CONSTRAINT "federal_funding_source_event_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_source_event" ADD CONSTRAINT "federal_funding_source_event_correction_of_event_id_fkey" FOREIGN KEY ("correction_of_event_id") REFERENCES "federal_funding_source_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_certification" ADD CONSTRAINT "federal_funding_certification_measure_id_fkey" FOREIGN KEY ("measure_id") REFERENCES "federal_funding_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_publication" ADD CONSTRAINT "federal_funding_publication_certification_id_fkey" FOREIGN KEY ("certification_id") REFERENCES "federal_funding_certification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_publication" ADD CONSTRAINT "federal_funding_publication_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "federal_funding_allocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_reconciliation_residual" ADD CONSTRAINT "federal_funding_reconciliation_residual_certification_id_fkey" FOREIGN KEY ("certification_id") REFERENCES "federal_funding_certification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "federal_funding_reconciliation_residual" ADD CONSTRAINT "federal_funding_reconciliation_residual_evidence_source_do_fkey" FOREIGN KEY ("evidence_source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_expected_source" ADD CONSTRAINT "defense_budget_expected_source_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_source_bundle_member" ADD CONSTRAINT "defense_budget_source_bundle_member_expected_source_id_fkey" FOREIGN KEY ("expected_source_id") REFERENCES "defense_budget_expected_source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_source_bundle_member" ADD CONSTRAINT "defense_budget_source_bundle_member_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "defense_budget_source_observation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_source_bundle_member" ADD CONSTRAINT "defense_budget_source_bundle_member_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_source_observation" ADD CONSTRAINT "defense_budget_source_observation_expected_source_id_fkey" FOREIGN KEY ("expected_source_id") REFERENCES "defense_budget_expected_source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_source_observation" ADD CONSTRAINT "defense_budget_source_observation_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_source_observation" ADD CONSTRAINT "defense_budget_source_observation_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_source_observation" ADD CONSTRAINT "defense_budget_source_observation_superseded_by_observatio_fkey" FOREIGN KEY ("superseded_by_observation_id") REFERENCES "defense_budget_source_observation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_watcher_run" ADD CONSTRAINT "defense_budget_watcher_run_adapter_id_fkey" FOREIGN KEY ("adapter_id") REFERENCES "defense_budget_watcher_adapter"("adapter_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_outbox" ADD CONSTRAINT "defense_budget_ingestion_outbox_observation_id_observation_fkey" FOREIGN KEY ("observation_id", "observation_state") REFERENCES "defense_budget_source_observation"("id", "observation_state") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_outbox" ADD CONSTRAINT "defense_budget_ingestion_outbox_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reextraction_operation_v1" ADD CONSTRAINT "budget_reextraction_operation_v1_outbox_row_id_fkey" FOREIGN KEY ("outbox_row_id") REFERENCES "defense_budget_ingestion_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reextraction_operation_v1" ADD CONSTRAINT "budget_reextraction_operation_v1_old_candidate_id_fkey" FOREIGN KEY ("old_candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reextraction_operation_v1" ADD CONSTRAINT "budget_reextraction_operation_v1_old_verification_run_id_fkey" FOREIGN KEY ("old_verification_run_id") REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reextraction_operation_v1" ADD CONSTRAINT "budget_reextraction_operation_v1_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reextraction_operation_v1" ADD CONSTRAINT "budget_reextraction_operation_v1_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reextraction_operation_v1" ADD CONSTRAINT "budget_reextraction_operation_v1_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_reextraction_operation_v1" ADD CONSTRAINT "budget_reextraction_operation_v1_verification_run_id_fkey" FOREIGN KEY ("verification_run_id") REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_manifest_item_v1" ADD CONSTRAINT "defense_budget_ingestion_manifest_item_v1_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "defense_budget_ingestion_manifest_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_manifest_item_v1" ADD CONSTRAINT "defense_budget_ingestion_manifest_item_v1_outbox_row_id_fkey" FOREIGN KEY ("outbox_row_id") REFERENCES "defense_budget_ingestion_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_manifest_item_v1" ADD CONSTRAINT "defense_budget_ingestion_manifest_item_v1_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "defense_budget_source_observation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_manifest_item_v1" ADD CONSTRAINT "defense_budget_ingestion_manifest_item_v1_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_manifest_item_v1" ADD CONSTRAINT "defense_budget_ingestion_manifest_item_v1_source_document__fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_manifest_item_v1" ADD CONSTRAINT "defense_budget_ingestion_manifest_item_v1_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "budget_extraction_candidate_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_ingestion_manifest_item_v1" ADD CONSTRAINT "defense_budget_ingestion_manifest_item_v1_verification_run_fkey" FOREIGN KEY ("verification_run_id") REFERENCES "budget_verification_run_v1"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_lifecycle_signal" ADD CONSTRAINT "defense_budget_lifecycle_signal_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "defense_budget_cycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_lifecycle_signal" ADD CONSTRAINT "defense_budget_lifecycle_signal_from_observation_id_fkey" FOREIGN KEY ("from_observation_id") REFERENCES "defense_budget_source_observation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_lifecycle_signal" ADD CONSTRAINT "defense_budget_lifecycle_signal_to_observation_id_fkey" FOREIGN KEY ("to_observation_id") REFERENCES "defense_budget_source_observation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_budget_discovery_candidate" ADD CONSTRAINT "defense_budget_discovery_candidate_crawl_id_fkey" FOREIGN KEY ("crawl_id") REFERENCES "defense_budget_discovery_crawl"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_prospects" ADD CONSTRAINT "business_development_prospects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_prospects" ADD CONSTRAINT "business_development_prospects_canonical_fkey" FOREIGN KEY ("canonical_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_prospects" ADD CONSTRAINT "business_development_prospects_client_fkey" FOREIGN KEY ("linked_client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_prospect_activity" ADD CONSTRAINT "business_development_prospect_activity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_prospect_activity" ADD CONSTRAINT "business_development_prospect_activity_prospect_fkey" FOREIGN KEY ("prospect_id") REFERENCES "business_development_prospects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_preferences" ADD CONSTRAINT "business_development_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_jev_decisions" ADD CONSTRAINT "business_development_jev_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "business_development_watches" ADD CONSTRAINT "business_development_watches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_watches" ADD CONSTRAINT "business_development_watches_prospect_fkey" FOREIGN KEY ("tenant_id", "prospect_id") REFERENCES "business_development_prospects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_watch_source_states" ADD CONSTRAINT "business_development_watch_source_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_watch_source_states" ADD CONSTRAINT "business_development_watch_source_states_watch_fkey" FOREIGN KEY ("tenant_id", "watch_id") REFERENCES "business_development_watches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_alerts" ADD CONSTRAINT "business_development_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_alerts" ADD CONSTRAINT "business_development_alerts_watch_fkey" FOREIGN KEY ("tenant_id", "watch_id") REFERENCES "business_development_watches"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_alerts" ADD CONSTRAINT "business_development_alerts_prospect_fkey" FOREIGN KEY ("tenant_id", "prospect_id") REFERENCES "business_development_prospects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_alert_deliveries" ADD CONSTRAINT "business_development_alert_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_development_alert_deliveries" ADD CONSTRAINT "business_development_alert_deliveries_alert_fkey" FOREIGN KEY ("tenant_id", "alert_id") REFERENCES "business_development_alerts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolios" ADD CONSTRAINT "research_portfolios_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolios" ADD CONSTRAINT "research_portfolios_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_grants" ADD CONSTRAINT "research_portfolio_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_grants" ADD CONSTRAINT "research_portfolio_grants_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_grants" ADD CONSTRAINT "research_portfolio_grants_principal_user_id_fkey" FOREIGN KEY ("principal_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_links" ADD CONSTRAINT "research_portfolio_client_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_links" ADD CONSTRAINT "research_portfolio_client_links_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_links" ADD CONSTRAINT "research_portfolio_client_links_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_members" ADD CONSTRAINT "research_portfolio_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_members" ADD CONSTRAINT "research_portfolio_members_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_events" ADD CONSTRAINT "research_portfolio_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_events" ADD CONSTRAINT "research_portfolio_events_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_taxonomy_versions" ADD CONSTRAINT "research_taxonomy_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_taxonomy_concepts" ADD CONSTRAINT "research_taxonomy_concepts_tenant_id_taxonomy_version_id_fkey" FOREIGN KEY ("tenant_id", "taxonomy_version_id") REFERENCES "research_taxonomy_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_templates" ADD CONSTRAINT "research_portfolio_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_template_versions" ADD CONSTRAINT "research_portfolio_template_versions_tenant_id_template_id_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "research_portfolio_templates"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_template_versions" ADD CONSTRAINT "research_portfolio_template_versions_tenant_id_taxonomy_ve_fkey" FOREIGN KEY ("tenant_id", "taxonomy_version_id") REFERENCES "research_taxonomy_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_template_versions" ADD CONSTRAINT "research_portfolio_template_versions_tenant_id_predecessor_fkey" FOREIGN KEY ("tenant_id", "predecessor_id") REFERENCES "research_portfolio_template_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_rule_versions" ADD CONSTRAINT "research_portfolio_rule_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_rule_versions" ADD CONSTRAINT "research_portfolio_rule_versions_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_rule_versions" ADD CONSTRAINT "research_portfolio_rule_versions_tenant_id_taxonomy_versio_fkey" FOREIGN KEY ("tenant_id", "taxonomy_version_id") REFERENCES "research_taxonomy_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_rule_versions" ADD CONSTRAINT "research_portfolio_rule_versions_tenant_id_template_versio_fkey" FOREIGN KEY ("tenant_id", "template_version_id") REFERENCES "research_portfolio_template_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_rule_versions" ADD CONSTRAINT "research_portfolio_rule_versions_tenant_id_predecessor_id_fkey" FOREIGN KEY ("tenant_id", "predecessor_id") REFERENCES "research_portfolio_rule_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_rule_previews" ADD CONSTRAINT "research_portfolio_rule_previews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_rule_previews" ADD CONSTRAINT "research_portfolio_rule_previews_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_recompute_jobs" ADD CONSTRAINT "research_portfolio_recompute_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_recompute_jobs" ADD CONSTRAINT "research_portfolio_recompute_jobs_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_recompute_jobs" ADD CONSTRAINT "research_portfolio_recompute_jobs_tenant_id_rule_version_i_fkey" FOREIGN KEY ("tenant_id", "rule_version_id") REFERENCES "research_portfolio_rule_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_reviews" ADD CONSTRAINT "research_portfolio_reviews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_reviews" ADD CONSTRAINT "research_portfolio_reviews_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_decisions" ADD CONSTRAINT "research_portfolio_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_decisions" ADD CONSTRAINT "research_portfolio_decisions_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_continuity_ledger" ADD CONSTRAINT "research_portfolio_continuity_ledger_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_continuity_ledger" ADD CONSTRAINT "research_portfolio_continuity_ledger_tenant_id_portfolio_i_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_jobs" ADD CONSTRAINT "research_portfolio_import_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_jobs" ADD CONSTRAINT "research_portfolio_import_jobs_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_rows" ADD CONSTRAINT "research_portfolio_import_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_rows" ADD CONSTRAINT "research_portfolio_import_rows_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_rows" ADD CONSTRAINT "research_portfolio_import_rows_tenant_id_import_job_id_fkey" FOREIGN KEY ("tenant_id", "import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_mapping_versions" ADD CONSTRAINT "rp_import_mappings_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_mapping_versions" ADD CONSTRAINT "rp_import_mappings_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_mapping_versions" ADD CONSTRAINT "rp_import_mappings_job_fkey" FOREIGN KEY ("tenant_id", "import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_attempts" ADD CONSTRAINT "research_portfolio_import_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_attempts" ADD CONSTRAINT "research_portfolio_import_attempts_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_attempts" ADD CONSTRAINT "research_portfolio_import_attempts_tenant_id_import_job_id_fkey" FOREIGN KEY ("tenant_id", "import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_effects" ADD CONSTRAINT "research_portfolio_import_effects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_effects" ADD CONSTRAINT "research_portfolio_import_effects_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_effects" ADD CONSTRAINT "research_portfolio_import_effects_tenant_id_import_job_id_fkey" FOREIGN KEY ("tenant_id", "import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_compensation_receipts" ADD CONSTRAINT "rp_import_receipts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_compensation_receipts" ADD CONSTRAINT "rp_import_receipts_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_import_compensation_receipts" ADD CONSTRAINT "rp_import_receipts_job_fkey" FOREIGN KEY ("tenant_id", "import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_event_recipient_states" ADD CONSTRAINT "research_portfolio_event_recipient_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_event_recipient_states" ADD CONSTRAINT "research_portfolio_event_recipient_states_tenant_id_portfo_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_event_recipient_states" ADD CONSTRAINT "research_portfolio_event_recipient_states_tenant_id_event__fkey" FOREIGN KEY ("tenant_id", "event_id") REFERENCES "research_portfolio_events"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_subscriptions" ADD CONSTRAINT "research_portfolio_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_subscriptions" ADD CONSTRAINT "research_portfolio_subscriptions_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_subscription_deliveries" ADD CONSTRAINT "research_portfolio_subscription_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_subscription_deliveries" ADD CONSTRAINT "research_portfolio_subscription_deliveries_tenant_id_portf_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_subscription_deliveries" ADD CONSTRAINT "research_portfolio_subscription_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "research_portfolio_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_subscription_deliveries" ADD CONSTRAINT "research_portfolio_subscription_deliveries_tenant_id_event_fkey" FOREIGN KEY ("tenant_id", "event_id") REFERENCES "research_portfolio_events"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_snapshots" ADD CONSTRAINT "research_portfolio_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_snapshots" ADD CONSTRAINT "research_portfolio_snapshots_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_requests" ADD CONSTRAINT "research_portfolio_output_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_requests" ADD CONSTRAINT "research_portfolio_output_requests_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_requests" ADD CONSTRAINT "research_portfolio_output_requests_tenant_id_snapshot_id_fkey" FOREIGN KEY ("tenant_id", "snapshot_id") REFERENCES "research_portfolio_snapshots"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_jobs" ADD CONSTRAINT "research_portfolio_output_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_jobs" ADD CONSTRAINT "research_portfolio_output_jobs_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_jobs" ADD CONSTRAINT "research_portfolio_output_jobs_tenant_id_request_id_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "research_portfolio_output_requests"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_attempts" ADD CONSTRAINT "research_portfolio_output_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_attempts" ADD CONSTRAINT "research_portfolio_output_attempts_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_attempts" ADD CONSTRAINT "research_portfolio_output_attempts_tenant_id_job_id_fkey" FOREIGN KEY ("tenant_id", "job_id") REFERENCES "research_portfolio_output_jobs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_artifacts" ADD CONSTRAINT "research_portfolio_output_artifacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_artifacts" ADD CONSTRAINT "research_portfolio_output_artifacts_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_artifacts" ADD CONSTRAINT "research_portfolio_output_artifacts_tenant_id_job_id_fkey" FOREIGN KEY ("tenant_id", "job_id") REFERENCES "research_portfolio_output_jobs"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_client_file_receipts" ADD CONSTRAINT "research_portfolio_output_client_file_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_client_file_receipts" ADD CONSTRAINT "research_portfolio_output_client_file_receipts_tenant_id_p_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_output_client_file_receipts" ADD CONSTRAINT "research_portfolio_output_client_file_receipts_tenant_id_a_fkey" FOREIGN KEY ("tenant_id", "artifact_id") REFERENCES "research_portfolio_output_artifacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_bookmarks" ADD CONSTRAINT "research_portfolio_bookmarks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_bookmarks" ADD CONSTRAINT "research_portfolio_bookmarks_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_tour_states" ADD CONSTRAINT "research_portfolio_tour_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_review_notes" ADD CONSTRAINT "research_portfolio_review_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_review_notes" ADD CONSTRAINT "research_portfolio_review_notes_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_review_notes" ADD CONSTRAINT "research_portfolio_review_notes_tenant_id_review_id_fkey" FOREIGN KEY ("tenant_id", "review_id") REFERENCES "research_portfolio_reviews"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_context_documents" ADD CONSTRAINT "defense_context_documents_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "defense_context_document_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_context_document_revisions" ADD CONSTRAINT "defense_context_document_revisions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "defense_context_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_context_document_revisions" ADD CONSTRAINT "defense_context_document_revisions_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_context_sections" ADD CONSTRAINT "defense_context_sections_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "defense_context_document_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_reference_occurrences" ADD CONSTRAINT "defense_reference_occurrences_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "defense_context_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_reference_occurrences" ADD CONSTRAINT "defense_reference_occurrences_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "defense_context_document_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_reference_occurrences" ADD CONSTRAINT "defense_reference_occurrences_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "defense_context_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_reference_occurrences" ADD CONSTRAINT "defense_reference_occurrences_resolved_target_document_id_fkey" FOREIGN KEY ("resolved_target_document_id") REFERENCES "defense_context_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_reference_occurrences" ADD CONSTRAINT "defense_reference_occurrences_resolved_target_revision_id_fkey" FOREIGN KEY ("resolved_target_revision_id") REFERENCES "defense_context_document_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defense_reference_occurrences" ADD CONSTRAINT "defense_reference_occurrences_resolved_target_section_id_fkey" FOREIGN KEY ("resolved_target_section_id") REFERENCES "defense_context_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_portfolio_fit_versions" ADD CONSTRAINT "research_portfolio_fit_versions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_fit_versions" ADD CONSTRAINT "research_portfolio_fit_versions_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_fit_versions" ADD CONSTRAINT "research_portfolio_fit_versions_client_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_fit_versions" ADD CONSTRAINT "research_portfolio_fit_versions_author_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparisons" ADD CONSTRAINT "defense_saved_compare_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparisons" ADD CONSTRAINT "defense_saved_compare_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparisons" ADD CONSTRAINT "defense_saved_compare_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparisons" ADD CONSTRAINT "defense_saved_compare_current_version_fkey" FOREIGN KEY ("tenant_id", "id", "current_version_id") REFERENCES "defense_saved_comparison_versions"("tenant_id", "comparison_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparison_versions" ADD CONSTRAINT "defense_saved_compare_version_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparison_versions" ADD CONSTRAINT "defense_saved_compare_version_parent_fkey" FOREIGN KEY ("tenant_id", "comparison_id") REFERENCES "defense_saved_comparisons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparison_versions" ADD CONSTRAINT "defense_saved_compare_version_creator_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparison_events" ADD CONSTRAINT "defense_saved_compare_event_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparison_events" ADD CONSTRAINT "defense_saved_compare_event_parent_fkey" FOREIGN KEY ("tenant_id", "comparison_id") REFERENCES "defense_saved_comparisons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparison_events" ADD CONSTRAINT "defense_saved_compare_event_version_fkey" FOREIGN KEY ("tenant_id", "comparison_id", "version_id") REFERENCES "defense_saved_comparison_versions"("tenant_id", "comparison_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "defense_saved_comparison_events" ADD CONSTRAINT "defense_saved_compare_event_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_filing_jobs" ADD CONSTRAINT "research_portfolio_client_filing_jobs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_filing_jobs" ADD CONSTRAINT "research_portfolio_client_filing_jobs_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_filing_jobs" ADD CONSTRAINT "research_portfolio_client_filing_jobs_artifact_fkey" FOREIGN KEY ("tenant_id", "artifact_id") REFERENCES "research_portfolio_output_artifacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_filing_jobs" ADD CONSTRAINT "research_portfolio_client_filing_jobs_client_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_filing_jobs" ADD CONSTRAINT "research_portfolio_client_filing_jobs_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "research_portfolio_client_filing_jobs" ADD CONSTRAINT "research_portfolio_client_filing_jobs_receipt_fkey" FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "research_portfolio_output_client_file_receipts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "krisp_notetaker_preferences" ADD CONSTRAINT "krisp_notetaker_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "krisp_notetaker_preferences" ADD CONSTRAINT "krisp_notetaker_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "krisp_notetaker_preferences" ADD CONSTRAINT "krisp_notetaker_preferences_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "clio_mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "krisp_meeting_imports" ADD CONSTRAINT "krisp_meeting_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "krisp_meeting_imports" ADD CONSTRAINT "krisp_meeting_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "krisp_meeting_imports" ADD CONSTRAINT "krisp_meeting_imports_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_activity_commands" ADD CONSTRAINT "client_activity_commands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_activity_commands" ADD CONSTRAINT "client_activity_commands_client_fk" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prospect_attachment_upload_intents" ADD CONSTRAINT "prospect_attachment_upload_intents_prospect_fkey" FOREIGN KEY ("tenant_id", "prospect_id") REFERENCES "business_development_prospects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

