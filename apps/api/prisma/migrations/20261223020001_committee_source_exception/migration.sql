-- LegiWatch: generic, reviewed source-level operational exceptions.
--
-- A source (e.g. jstx00 / https://www.jct.gov/) can be genuinely, durably
-- unprobable for reasons that are NOT a parser defect or transient upstream
-- blip — e.g. an unconditional Cloudflare WAF block on automated access, with
-- no compliant RSS/feed/API alternative. `sourceHealth = failing` must stay
-- ACCURATE (never faked to healthy), but readiness needs a way to understand
-- "this failure is reviewed and accepted" vs. "this failure is unexplained
-- and needs investigation" — without special-casing any specific source in
-- code.
--
-- This is a small, generic table: any committee_source row may have zero or
-- one active exception. Readiness code queries by source_id + is the
-- exception still valid (not expired), never by hardcoded source identity.
--
-- committee_source.id is TEXT (application-generated uuid string, not a
-- native pg UUID column) — this table matches that exactly so the FK works.
CREATE TABLE IF NOT EXISTS "committee_source_exception" (
  "id" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "exception_type" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "evidence" TEXT NOT NULL,
  "reviewed_by" TEXT NOT NULL,
  "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "committee_source_exception_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "committee_source_exception_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "committee_source"("id") ON DELETE CASCADE,
  CONSTRAINT "committee_source_exception_type_chk"
    CHECK ("exception_type" IN (
      'UPSTREAM_ACCESS_BLOCKED', 'EXPECTED_UNAVAILABLE', 'POLICY_STATE',
      'UNDER_INVESTIGATION'
    ))
);

-- One active exception per source at a time: a source that needs a NEW
-- exception recorded should have the old row's expiry set, not accumulate
-- ambiguous duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "committee_source_exception_source_active_idx"
  ON "committee_source_exception" ("source_id")
  WHERE "expires_at" IS NULL;

CREATE INDEX IF NOT EXISTS "committee_source_exception_source_idx"
  ON "committee_source_exception" ("source_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "committee_source_exception" TO capiro_app;
  END IF;
END
$$;
