-- 2026-07-10 hot-fix (State Legislation Platform S5.3 emit-windowing bug):
-- `emit-state-changes.ts` windowed material transitions on `status_at`, the
-- legislative EVENT date (@db.Date, midnight granularity) — but the sweep's
-- `since` is the last successful run's `startedAt` timestamp, which on any
-- given day is almost always LATER than that same day's midnight-dated
-- `status_at`. Nearly every transition was silently dropped from the
-- Needs-Attention / intelligence_change inbox.
--
-- Fix: a dedicated INGESTION-time anchor, `status_derived_at`, set by
-- derive-state-bill-status.ts at the exact moment it writes a status change.
-- `emit-state-changes.ts` now windows on this column instead.
--
-- Backfill: existing rows get `status_derived_at = status_at` (their OLD,
-- historical legislative date) rather than `now()`. Since the next emit
-- run's `since` will be a RECENT timestamp, every backfilled (historical)
-- row's `status_derived_at` sorts BEFORE it and is correctly excluded from
-- the first post-deploy sweep — only genuinely NEW transitions (which the
-- deriver will stamp with a fresh `status_derived_at` going forward) surface.
-- This intentionally avoids flooding the changes inbox with a backlog of
-- historical transitions on first deploy.

-- AlterTable
ALTER TABLE "state_bill" ADD COLUMN "status_derived_at" TIMESTAMPTZ(6);

-- Backfill (one-time, historical rows only — see rationale above)
UPDATE "state_bill" SET "status_derived_at" = "status_at" WHERE "status_at" IS NOT NULL;

-- CreateIndex
CREATE INDEX "state_bill_status_derived_at_idx" ON "state_bill"("status_derived_at");
