-- Onboard API — initial schema.
-- Creates ONLY onboard_* enums/tables. The external tables this service also
-- touches (tenants, users, tenant_memberships, stripe_events,
-- tenant_usage_meters) are owned and migrated by apps/api and MUST NOT be
-- created or altered here.

-- ── enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "onboard_session_state" AS ENUM (
  'registered', 'verified', 'plan_selected', 'legal_accepted',
  'payment_on_file', 'roles_designated', 'import_pref', 'org_setup',
  'provisioning', 'provisioned', 'failed'
);

CREATE TYPE "onboard_plan" AS ENUM ('trial', 'paid');

CREATE TYPE "onboard_pay_method" AS ENUM ('card', 'ach', 'wire');

CREATE TYPE "onboard_task_key" AS ENUM ('it_email', 'import', 'firm_ai', 'invites');

CREATE TYPE "onboard_task_status" AS ENUM ('none', 'waiting', 'verifying', 'done');

CREATE TYPE "onboard_it_invite_status" AS ENUM ('sent', 'granted', 'verified', 'failed', 'revoked');

CREATE TYPE "onboard_legal_doc_type" AS ENUM ('tos', 'sa');

-- ── onboard_purchaser ────────────────────────────────────────────────────────

CREATE TABLE "onboard_purchaser" (
  "id" UUID NOT NULL,
  "clerk_user_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "first_name" TEXT,
  "last_name" TEXT,
  "org_name" TEXT,
  "tenant_id" UUID,
  "stripe_customer_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "onboard_purchaser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboard_purchaser_clerk_user_id_key" ON "onboard_purchaser"("clerk_user_id");
CREATE UNIQUE INDEX "onboard_purchaser_stripe_customer_id_key" ON "onboard_purchaser"("stripe_customer_id");
CREATE INDEX "onboard_purchaser_email_idx" ON "onboard_purchaser"("email");

-- ── onboard_session ──────────────────────────────────────────────────────────

CREATE TABLE "onboard_session" (
  "id" UUID NOT NULL,
  "purchaser_id" UUID NOT NULL,
  "state" "onboard_session_state" NOT NULL DEFAULT 'registered',
  "plan" "onboard_plan",
  "pay_method" "onboard_pay_method",
  "profiles" INTEGER,
  "role_mode" TEXT,
  "role_designations" JSONB NOT NULL DEFAULT '[]',
  "import_mode" TEXT,
  "it_admin_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "org_profile" JSONB NOT NULL DEFAULT '{}',
  "slug_final" TEXT,
  "stripe_setup_intent_id" TEXT,
  "stripe_subscription_id" TEXT,
  "tenant_id" UUID,
  "failure_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "onboard_session_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onboard_session_purchaser_id_fkey" FOREIGN KEY ("purchaser_id")
    REFERENCES "onboard_purchaser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "onboard_session_tenant_id_key" ON "onboard_session"("tenant_id");
CREATE INDEX "onboard_session_purchaser_id_idx" ON "onboard_session"("purchaser_id");
CREATE INDEX "onboard_session_state_idx" ON "onboard_session"("state");

-- ── onboard_consent ──────────────────────────────────────────────────────────

CREATE TABLE "onboard_consent" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "purchaser_id" UUID NOT NULL,
  "clerk_user_id" TEXT NOT NULL,
  "doc_type" "onboard_legal_doc_type" NOT NULL,
  "doc_version" TEXT NOT NULL,
  "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip" TEXT,
  "user_agent" TEXT,

  CONSTRAINT "onboard_consent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onboard_consent_session_id_fkey" FOREIGN KEY ("session_id")
    REFERENCES "onboard_session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "onboard_consent_purchaser_id_fkey" FOREIGN KEY ("purchaser_id")
    REFERENCES "onboard_purchaser"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "onboard_consent_session_id_idx" ON "onboard_consent"("session_id");
CREATE INDEX "onboard_consent_clerk_user_id_idx" ON "onboard_consent"("clerk_user_id");

-- ── onboard_legal_doc ────────────────────────────────────────────────────────

CREATE TABLE "onboard_legal_doc" (
  "id" UUID NOT NULL,
  "doc_type" "onboard_legal_doc_type" NOT NULL,
  "version" TEXT NOT NULL,
  "plan_variant" TEXT NOT NULL DEFAULT 'all',
  "html" TEXT NOT NULL,
  "pdf_s3_key" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT false,
  "effective_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "onboard_legal_doc_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboard_legal_doc_doc_type_plan_variant_version_key"
  ON "onboard_legal_doc"("doc_type", "plan_variant", "version");
CREATE INDEX "onboard_legal_doc_doc_type_active_idx" ON "onboard_legal_doc"("doc_type", "active");

-- ── onboard_setup_task ───────────────────────────────────────────────────────

CREATE TABLE "onboard_setup_task" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "task" "onboard_task_key" NOT NULL,
  "status" "onboard_task_status" NOT NULL DEFAULT 'none',
  "detail" JSONB NOT NULL DEFAULT '{}',
  "completed_by" TEXT,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "onboard_setup_task_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboard_setup_task_tenant_id_task_key" ON "onboard_setup_task"("tenant_id", "task");

-- ── onboard_it_invite ────────────────────────────────────────────────────────

CREATE TABLE "onboard_it_invite" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "provider" TEXT,
  "status" "onboard_it_invite_status" NOT NULL DEFAULT 'sent',
  "entra_tenant_id" TEXT,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "granted_at" TIMESTAMPTZ(6),
  "verified_at" TIMESTAMPTZ(6),
  "created_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "onboard_it_invite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboard_it_invite_token_hash_key" ON "onboard_it_invite"("token_hash");
CREATE INDEX "onboard_it_invite_tenant_id_idx" ON "onboard_it_invite"("tenant_id");

-- ── onboard_email_log ────────────────────────────────────────────────────────

CREATE TABLE "onboard_email_log" (
  "id" UUID NOT NULL,
  "tenant_id" UUID,
  "purchaser_id" UUID,
  "kind" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "to_email" TEXT NOT NULL,
  "ses_message_id" TEXT,
  "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "onboard_email_log_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboard_email_log_dedupe_key_key" ON "onboard_email_log"("dedupe_key");
CREATE INDEX "onboard_email_log_tenant_id_kind_idx" ON "onboard_email_log"("tenant_id", "kind");

-- ── onboard_billing_event ────────────────────────────────────────────────────

CREATE TABLE "onboard_billing_event" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "actor" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "onboard_billing_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "onboard_billing_event_tenant_id_type_idx" ON "onboard_billing_event"("tenant_id", "type");

-- ── application-role grants ──────────────────────────────────────────────────
-- The services connect as `capiro_app` (created by apps/api's
-- 20260502020000_capiro_app_role migration). Migrations may run as a more
-- privileged role, so grant explicitly — conditional so local scratch DBs
-- without the role still migrate cleanly (mirrors apps/intel-api's pattern).

DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'onboard_purchaser', 'onboard_session', 'onboard_consent',
      'onboard_legal_doc', 'onboard_setup_task', 'onboard_it_invite',
      'onboard_email_log', 'onboard_billing_event'
    ]
    LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO capiro_app', t);
    END LOOP;
  END IF;
END $$;
