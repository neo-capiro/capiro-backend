-- District Impact Engine (Phase 1 M1.1) — additive geocode columns on
-- client_facilities. Safe on a live table: all nullable, no backfill required
-- (the geocode-facilities verb populates them idempotently after deploy).

ALTER TABLE "client_facilities"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "state_house_district" VARCHAR(8),
  ADD COLUMN "state_senate_district" VARCHAR(8),
  ADD COLUMN "geocoded_at" TIMESTAMPTZ(6),
  ADD COLUMN "geocode_status" VARCHAR(16);

CREATE INDEX "client_facilities_state_house_idx" ON "client_facilities" ("state", "state_house_district");
CREATE INDEX "client_facilities_state_senate_idx" ON "client_facilities" ("state", "state_senate_district");
