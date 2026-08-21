-- District Nexus Release 1 (§11): explicit congressional-boundary provenance.
--
-- The Census geocoder's response already carries which Congress its
-- congressional-district field reflects (a `CD<congress>` key, e.g. `CD119`)
-- but that number was discarded on write — only the bare district code was
-- stored. Without it, a facility's district cannot be checked against the
-- Congress actually in session, so a stale or future boundary could be
-- silently presented as current representation.
--
-- Additive and nullable, and DELIBERATELY NOT BACKFILLED here:
--   - a manually-entered district was never geocoder-confirmed, so it must
--     never be stamped with a Congress number it does not actually have;
--   - a facility geocoded before this column existed has no recorded
--     Congress either, and guessing one (e.g. "it must have been the
--     current Congress at the time") is not a fact this migration can
--     support with what was actually stored.
--
-- A future backfill will re-run the geocoder for eligible rows (a real
-- ancestral geocode timestamp is not enough to safely infer Congress after
-- the fact) — see geocode-facilities.ts's updated eligibility selection.
--
-- Rollback: ALTER TABLE "client_facilities" DROP COLUMN "congressional_district_congress";

ALTER TABLE "client_facilities"
  ADD COLUMN "congressional_district_congress" INTEGER;
