-- Release R1, Step 1.3: editable client-bill context on the tracked bill.
--
-- Additive, nullable, backward-compatible — existing rows are untouched and the
-- existing `note` column is PRESERVED (the PUT /clients/:c/bills/:b/context write
-- never touches `note`; analyst context reads fall back to `note` when
-- `analyst_note` is null, per plan §1.3). No RLS work is needed here:
-- intel_tracked_bill already carries its `_isolation` policy + capiro_app GRANT
-- (see 20260701090000_intel_tracker_unified_schema / 20260706010000_intel_full_rls_hold).
--
-- Analyst outlook fields are ORIGIN=analyst context only; they NEVER overwrite
-- the canonical bill status, which lives on the apps/api-owned congress_bill.

-- AlterTable
ALTER TABLE "intel_tracked_bill" ADD COLUMN "position" TEXT;                          -- 'support'|'oppose'|'monitor'
ALTER TABLE "intel_tracked_bill" ADD COLUMN "priority" TEXT;                          -- 'low'|'med'|'high'
ALTER TABLE "intel_tracked_bill" ADD COLUMN "analyst_note" TEXT;
ALTER TABLE "intel_tracked_bill" ADD COLUMN "expected_milestone_type" TEXT;           -- @capiro/shared EXPECTED_MILESTONE_TYPES
ALTER TABLE "intel_tracked_bill" ADD COLUMN "expected_window_start" TIMESTAMP(3);
ALTER TABLE "intel_tracked_bill" ADD COLUMN "expected_window_end" TIMESTAMP(3);
ALTER TABLE "intel_tracked_bill" ADD COLUMN "expected_confidence" TEXT;               -- 'low'|'medium'|'high'
ALTER TABLE "intel_tracked_bill" ADD COLUMN "expected_rationale" TEXT;
ALTER TABLE "intel_tracked_bill" ADD COLUMN "expected_updated_by" TEXT;               -- clerk user id
ALTER TABLE "intel_tracked_bill" ADD COLUMN "expected_updated_at" TIMESTAMP(3);
