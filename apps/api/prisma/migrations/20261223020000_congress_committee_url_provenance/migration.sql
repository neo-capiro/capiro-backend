-- LegiWatch: committee URL source-precedence (generic, not committee-specific).
--
-- sync-committees.ts ingests `congress_committee.url` from the community-
-- maintained unitedstates/congress-legislators dataset every run. That feed
-- can go stale for a specific committee (verified live for jslc00/jspr00:
-- it still points at a cha.house.gov path that now 404s) while Congress.gov's
-- own API already reports the committee's current official page.
--
-- `url_source` records WHICH authority last wrote `url`, so a subsequent
-- lower-authority sync (community feed) can never silently overwrite a URL
-- that a higher-authority source (Congress.gov API) already confirmed
-- current. This is a generic precedence rule keyed on provenance, not a
-- hardcoded list of committee system codes.
ALTER TABLE "congress_committee"
  ADD COLUMN IF NOT EXISTS "url_source" TEXT,
  ADD COLUMN IF NOT EXISTS "url_verified_at" TIMESTAMPTZ(6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'congress_committee_url_source_chk'
  ) THEN
    ALTER TABLE "congress_committee"
      ADD CONSTRAINT "congress_committee_url_source_chk"
      CHECK ("url_source" IS NULL OR "url_source" IN ('congress_gov', 'community'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "congress_committee_url_source_idx"
  ON "congress_committee" ("url_source");
