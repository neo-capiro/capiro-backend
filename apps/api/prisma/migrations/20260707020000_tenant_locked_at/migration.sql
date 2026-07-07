-- Onboarding v1 (Gherkin bridge: wire/ACH lockout): set by onboard-api's
-- lifecycle cron when billing stays past_due beyond the configured window;
-- cleared when payment lands. NULL = not locked. Read by /api/billing/state
-- to drive the full-access lockout screen.
ALTER TABLE "tenants" ADD COLUMN "locked_at" TIMESTAMPTZ(6);
