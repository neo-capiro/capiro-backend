-- AlterEnum
-- 'skipped' lets an invited Google Workspace admin defer verification (Google
-- Testing-mode publishing can't yet serve every customer) without blocking
-- onboarding. Additive only — existing rows/values are untouched.
ALTER TYPE "onboard_task_status" ADD VALUE 'skipped';
ALTER TYPE "onboard_it_invite_status" ADD VALUE 'skipped';
