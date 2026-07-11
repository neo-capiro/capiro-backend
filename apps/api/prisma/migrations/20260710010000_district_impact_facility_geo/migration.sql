-- District Impact Engine (Phase 1 M1.1) — additive geocode columns on
-- client_facilities. Safe on a live table: all nullable, no backfill required
-- (the geocode-facilities verb populates them idempotently after deploy).

ALTER TABLE "client_facilities"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "state_house_district" VARCHAR(8),
  ADD COLUMN "state_senate_district" VARCHAR(8),
  ADD COLUMN "geocoded_at" TIMESTAMPTZ(6),
  ADD COLUMN "geocode_status" VARCHAR(16),
  -- W4.2: change-hash of the normalized address the row was last geocoded at.
  -- geocode-facilities re-geocodes only when this differs from the current
  -- address hash (not on any unrelated updated_at bump), and stamps it on every
  -- attempt (incl. address-less/no-match) so a row can't starve the batch cap.
  -- Nullable; existing rows self-heal on the next scan (NULL → treated as
  -- never-tried), so no backfill is required (D-11).
  ADD COLUMN "geocode_input_hash" TEXT;

CREATE INDEX "client_facilities_state_house_idx" ON "client_facilities" ("state", "state_house_district");
CREATE INDEX "client_facilities_state_senate_idx" ON "client_facilities" ("state", "state_senate_district");
