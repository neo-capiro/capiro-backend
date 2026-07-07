-- Onboarding v1 (Flow 2B.4): first-login guided tour completion, per user.
-- NULL = the 7-step tour auto-launches on the next dashboard load.
ALTER TABLE "users" ADD COLUMN "tour_completed_at" TIMESTAMPTZ(6);
