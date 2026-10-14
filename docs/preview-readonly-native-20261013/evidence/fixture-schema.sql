CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE "tenant_status" AS ENUM ('active','suspended','pending');

CREATE TYPE "billing_status" AS ENUM ('none','trialing','active','past_due','canceled','comped');

CREATE TYPE "tenant_role" AS ENUM ('capiro_admin','user_admin','standard_user','client_portal_user');

CREATE TYPE "membership_status" AS ENUM ('invited','active','removed');

CREATE TABLE "tenants" ("id" UUID NOT NULL PRIMARY KEY,
"slug" CITEXT NOT NULL,
"name" TEXT NOT NULL,
"status" "tenant_status" NOT NULL,
"plan" TEXT,
"settings_jsonb" JSONB NOT NULL,
"kms_key_arn" TEXT,
"soc2_audit_window" JSONB,
"clerk_org_id" TEXT,
"logo_s3_key" TEXT,
"logo_content_type" TEXT,
"logo_uploaded_at" TIMESTAMPTZ,
"account_type" TEXT,
"plan_tier" TEXT NOT NULL,
"lda_registrant_id" INTEGER,
"lda_registrant_name" TEXT,
"stripe_customer_id" TEXT,
"stripe_subscription_id" TEXT,
"billing_status" "billing_status" NOT NULL,
"client_slots" INTEGER NOT NULL,
"llm_allowance_usd_per_slot" DECIMAL NOT NULL,
"llm_hard_cap_usd" DECIMAL,
"current_period_end" TIMESTAMPTZ,
"onboarding_flow_version" INTEGER,
"trial_ends_at" TIMESTAMPTZ,
"price_lock_expires_at" TIMESTAMPTZ,
"import_mode" TEXT,
"courtesy_swap_used" BOOLEAN NOT NULL,
"deletion_hold" BOOLEAN NOT NULL,
"canceled_at" TIMESTAMPTZ,
"locked_at" TIMESTAMPTZ,
"created_at" TIMESTAMPTZ NOT NULL,
"updated_at" TIMESTAMPTZ NOT NULL);

CREATE TABLE "users" ("id" UUID NOT NULL PRIMARY KEY,
"clerk_user_id" TEXT NOT NULL,
"email" CITEXT NOT NULL,
"first_name" TEXT,
"last_name" TEXT,
"title" TEXT,
"email_signature_html" TEXT,
"email_signature_enabled" BOOLEAN NOT NULL,
"tour_completed_at" TIMESTAMPTZ,
"legiwatch_intro_seen_at" TIMESTAMPTZ,
"legiwatch_prefs" JSONB,
"last_seen_at" TIMESTAMPTZ,
"created_at" TIMESTAMPTZ NOT NULL,
"updated_at" TIMESTAMPTZ NOT NULL);

CREATE TABLE "tenant_memberships" ("id" UUID NOT NULL PRIMARY KEY,
"tenant_id" UUID NOT NULL,
"user_id" UUID NOT NULL,
"role" "tenant_role" NOT NULL,
"status" "membership_status" NOT NULL,
"billing_admin" BOOLEAN NOT NULL,
"invited_by" UUID,
"joined_at" TIMESTAMPTZ,
"created_at" TIMESTAMPTZ NOT NULL,
"updated_at" TIMESTAMPTZ NOT NULL);

CREATE TABLE "clients" ("id" UUID NOT NULL PRIMARY KEY,
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
"logo_uploaded_at" TIMESTAMPTZ,
"intake_data_jsonb" JSONB NOT NULL,
"status" TEXT NOT NULL,
"sector_tag" TEXT,
"profile_type" TEXT,
"profile_status" TEXT NOT NULL,
"submission_tracks" TEXT[] NOT NULL,
"issue_codes" TEXT[] NOT NULL,
"uei" TEXT,
"cage_code" TEXT,
"naics_codes" TEXT[] NOT NULL,
"psc_codes" TEXT[] NOT NULL,
"tango_entity_last_synced_at" TIMESTAMPTZ,
"tango_entity_last_attempt_at" TIMESTAMPTZ,
"tango_entity_last_error" TEXT,
"applicant_types" TEXT[] NOT NULL,
"set_aside_certifications" TEXT[] NOT NULL,
"lda_client_ids" INTEGER[] NOT NULL,
"memory_wall" BOOLEAN NOT NULL,
"created_by_user_id" UUID,
"created_at" TIMESTAMPTZ NOT NULL,
"updated_at" TIMESTAMPTZ NOT NULL,
"account_owner_version" INTEGER NOT NULL,
"canonical_entity_id" UUID);

CREATE UNIQUE INDEX ON users (clerk_user_id);

CREATE UNIQUE INDEX ON tenants (clerk_org_id);

CREATE UNIQUE INDEX ON tenant_memberships (tenant_id,user_id);

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

-- Helper: bypass flag for trusted server-internal contexts (cross-tenant
-- admin work, webhook ingestion, migrations). Set explicitly via
-- `SET LOCAL app.bypass_rls = 'on'`. Off by default.
CREATE OR REPLACE FUNCTION rls_bypass() RETURNS BOOLEAN AS $$
BEGIN
  RETURN current_setting('app.bypass_rls', true) = 'on';
END;
$$ LANGUAGE plpgsql STABLE;

-- tenants: a row is visible if it is the current tenant, or bypass is on.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenants_isolation" ON "tenants"
  USING (rls_bypass() OR id = current_tenant_id())
  WITH CHECK (rls_bypass() OR id = current_tenant_id());

-- tenant_memberships: scoped by tenant_id.
ALTER TABLE "tenant_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_memberships_isolation" ON "tenant_memberships"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());



ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clients_isolation" ON "clients"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

GRANT SELECT ("id","slug","status","clerk_org_id","name","settings_jsonb","plan_tier") ON "tenants" TO capiro_app;

GRANT SELECT ("id","clerk_user_id","email","first_name","last_name","title","email_signature_html","email_signature_enabled","tour_completed_at","legiwatch_intro_seen_at","legiwatch_prefs") ON "users" TO capiro_app;

GRANT SELECT ("id","tenant_id","user_id","role","status","updated_at","billing_admin") ON "tenant_memberships" TO capiro_app;

GRANT SELECT ("id","tenant_id","name","website","description","product_description","primary_contact_name","primary_contact_email","primary_contact_phone","logo_s3_key","logo_content_type","logo_uploaded_at","intake_data_jsonb","status","sector_tag","profile_type","profile_status","submission_tracks","issue_codes","uei","cage_code","naics_codes","psc_codes","tango_entity_last_synced_at","tango_entity_last_attempt_at","tango_entity_last_error","applicant_types","set_aside_certifications","lda_client_ids","memory_wall","created_by_user_id","created_at","updated_at","account_owner_version","canonical_entity_id") ON "clients" TO capiro_app;
