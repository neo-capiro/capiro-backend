-- Preserve reviewed first-party URL provenance without labeling it Congress.gov.
-- Retain NULL and both existing authorities; do not change data, grants or RLS.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "congress_committee"
  DROP CONSTRAINT "congress_committee_url_source_chk",
  ADD CONSTRAINT "congress_committee_url_source_chk"
    CHECK ("url_source" IS NULL OR "url_source" IN ('congress_gov', 'community', 'official_review'));

COMMIT;
