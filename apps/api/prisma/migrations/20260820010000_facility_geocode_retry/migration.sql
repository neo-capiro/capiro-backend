-- Facility geocoding reliability: retain retry state and provider diagnostics.
ALTER TABLE "client_facilities"
  ADD COLUMN "geocode_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "geocode_next_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "geocode_last_error" TEXT,
  ADD COLUMN "geocode_matched_address" TEXT;

CREATE INDEX "client_facilities_geocode_retry_idx"
  ON "client_facilities" ("geocode_next_attempt_at", "geocode_status");

-- Existing failures were previously stamped as complete by the hash-based job.
-- Make them eligible for the first retry after deployment.
UPDATE "client_facilities"
SET "geocode_next_attempt_at" = NOW()
WHERE "geocode_status" IN ('error', 'no_match', 'ambiguous')
  AND "geocode_next_attempt_at" IS NULL;
