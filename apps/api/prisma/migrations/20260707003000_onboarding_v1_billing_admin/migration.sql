-- Onboarding v1 (docs/plans/onboarding-v1-plan.md):
--   • tenant_memberships.billing_admin — the "Super Admin" permission bit.
--     Only meaningful on role='user_admin'; grantable by capiro_admin or an
--     existing billing admin; no minimum enforced (Ninja decision Q6).
--   • tenants onboarding/lifecycle columns. onboarding_flow_version is NULL
--     for all pre-existing tenants (legacy) and 1 for tenants provisioned by
--     the self-service funnel — every new gate/banner/tour keys off it so
--     legacy tenants see zero change.

ALTER TABLE "tenant_memberships" ADD COLUMN "billing_admin" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tenants" ADD COLUMN "onboarding_flow_version" INTEGER;
ALTER TABLE "tenants" ADD COLUMN "trial_ends_at" TIMESTAMPTZ(6);
ALTER TABLE "tenants" ADD COLUMN "price_lock_expires_at" TIMESTAMPTZ(6);
ALTER TABLE "tenants" ADD COLUMN "import_mode" TEXT;
ALTER TABLE "tenants" ADD COLUMN "courtesy_swap_used" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "deletion_hold" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "canceled_at" TIMESTAMPTZ(6);
