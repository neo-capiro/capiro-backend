-- Additive-only: adds Phase 4 capture-runtime fields to public_hearing_capture.
-- No drops, no renames, no data migration needed (all new columns are
-- nullable or have a default so existing rows remain valid).
ALTER TABLE "public_hearing_capture"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "fencing_token" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lease_acquired_at" TIMESTAMPTZ(6),
  ADD COLUMN "resolution_state" TEXT NOT NULL DEFAULT 'NOT_CHECKED',
  ADD COLUMN "last_resolution_at" TIMESTAMPTZ(6),
  ADD COLUMN "consecutive_source_errors" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_preflight_at" TIMESTAMPTZ(6),
  ADD COLUMN "captured_ms" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "gaps" JSONB NOT NULL DEFAULT '[]';
