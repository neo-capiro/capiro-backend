-- Phase 6 (§9.2 step E): additive Board "discussed at hearing" badge columns.
-- Kept SEPARATE from the last_seen_action* congress watermark (owned by
-- detect-bill-changes). Nullable/backward-compatible; no changes to existing rows.

-- AlterTable
ALTER TABLE "intel_tracked_bill" ADD COLUMN "last_hearing_session_id" TEXT;
ALTER TABLE "intel_tracked_bill" ADD COLUMN "last_hearing_at" TIMESTAMP(3);
