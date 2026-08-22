-- Preserve Census standardized addresses and ambiguous alternatives so the
-- facilities UI can show an explicit recommendation instead of discarding the
-- provider's useful match data.
ALTER TABLE "client_facilities"
  ADD COLUMN "geocode_candidates_jsonb" JSONB;

-- Rollback: ALTER TABLE "client_facilities" DROP COLUMN "geocode_candidates_jsonb";
