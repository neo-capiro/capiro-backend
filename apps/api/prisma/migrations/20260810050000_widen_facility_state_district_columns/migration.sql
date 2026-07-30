-- Widen the two state-legislative district columns on `client_facilities`.
--
-- LIVE BUG (observed 2026-07-30): `geocode-facilities` reported
-- `success_with_errors` with `rows_inserted = rows_updated = 0` on nine
-- consecutive nightly runs (2026-07-21 .. 2026-07-30; last clean run
-- 2026-07-20). Cause: these columns were VARCHAR(8), but the Census Geocoder
-- returns the state legislative district as the layer's BASENAME, which in
-- named-district states is a NAME, not a number:
--
--   151 Martine Street, Fall River, MA 02723
--     SLDL BASENAME = '8th Bristol'                  (11 chars)
--     SLDU BASENAME = 'First Bristol and Plymouth'   (26 chars)
--   107 N Main St, Concord, NH   -> SLDL 'Merrimack 18'  (12)
--   115 State St, Montpelier, VT -> SLDL 'Washington-4'  (12), SLDU 'Washington' (10)
--
-- Writing those threw `value too long for type character varying(8)`. The
-- write that carries the district ALSO carries `geocode_input_hash`, so a
-- throw meant the row was never stamped -- it re-selected and failed again
-- every single night, forever, and no facility in a named-district state
-- could ever be geocoded. MA's longest senate district name
-- ('Berkshire, Hampden, Franklin and Hampshire') is 42 chars, so 64 leaves
-- real headroom; the writer also clamps defensively so an unexpectedly long
-- future value degrades instead of re-poisoning the nightly run.
--
-- Widening a varchar is a metadata-only change in Postgres (no table
-- rewrite, no lock beyond ACCESS EXCLUSIVE for the catalog update) and
-- cannot truncate existing data.
ALTER TABLE "client_facilities"
  ALTER COLUMN "state_house_district" TYPE VARCHAR(64),
  ALTER COLUMN "state_senate_district" TYPE VARCHAR(64);
