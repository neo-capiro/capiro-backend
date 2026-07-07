-- Bucket-#3 C6.P6.1 remainder: sponsor bioguide on bills, cosponsor rows,
-- canonical committee registry + membership rosters, entity crosswalk.
-- All GLOBAL public-record tables (congress_bill class). Additive only.

-- 1. Canonical sponsor identity on congress_bill
ALTER TABLE "congress_bill" ADD COLUMN "sponsor_bioguide_id" TEXT;
CREATE INDEX "congress_bill_sponsor_bioguide_idx" ON "congress_bill"("sponsor_bioguide_id");

-- 2. Cosponsor rows
CREATE TABLE "congress_bill_cosponsor" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "bill_id"          TEXT NOT NULL,
  "bioguide_id"      TEXT NOT NULL,
  "full_name"        TEXT NOT NULL,
  "party"            TEXT,
  "state"            TEXT,
  "district"         INTEGER,
  "sponsorship_date" DATE,
  "is_original"      BOOLEAN NOT NULL DEFAULT false,
  "withdrawn_date"   DATE,
  "last_synced_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "congress_bill_cosponsor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "congress_bill_cosponsor_bill_id_fkey" FOREIGN KEY ("bill_id")
    REFERENCES "congress_bill"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "congress_bill_cosponsor_bill_id_bioguide_id_key"
  ON "congress_bill_cosponsor"("bill_id", "bioguide_id");
CREATE INDEX "congress_bill_cosponsor_bioguide_id_idx"
  ON "congress_bill_cosponsor"("bioguide_id");

-- 3. Canonical committee registry (keyed by Congress.gov systemCode)
CREATE TABLE "congress_committee" (
  "system_code"        TEXT NOT NULL,
  "thomas_id"          TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "chamber"            TEXT NOT NULL,
  "parent_system_code" TEXT,
  "url"                TEXT,
  "jurisdiction"       TEXT,
  "is_current"         BOOLEAN NOT NULL DEFAULT true,
  "last_synced_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "congress_committee_pkey" PRIMARY KEY ("system_code")
);
CREATE INDEX "congress_committee_chamber_idx" ON "congress_committee"("chamber");
CREATE INDEX "congress_committee_parent_system_code_idx"
  ON "congress_committee"("parent_system_code");

-- 4. Committee membership rosters
CREATE TABLE "congress_committee_membership" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "system_code"    TEXT NOT NULL,
  "bioguide_id"    TEXT NOT NULL,
  "side"           TEXT NOT NULL,
  "rank"           INTEGER,
  "title"          TEXT,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "congress_committee_membership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "congress_committee_membership_system_code_fkey" FOREIGN KEY ("system_code")
    REFERENCES "congress_committee"("system_code") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "congress_committee_membership_system_code_bioguide_id_key"
  ON "congress_committee_membership"("system_code", "bioguide_id");
CREATE INDEX "congress_committee_membership_bioguide_id_idx"
  ON "congress_committee_membership"("bioguide_id");

-- 5. Generic external-id -> canonical-entity crosswalk
CREATE TABLE "entity_crosswalk" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "id_type"        TEXT NOT NULL,
  "id_value"       TEXT NOT NULL,
  "entity_type"    TEXT NOT NULL,
  "entity_key"     TEXT NOT NULL,
  "source"         TEXT NOT NULL,
  "confidence"     DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "entity_crosswalk_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "entity_crosswalk_id_type_id_value_key"
  ON "entity_crosswalk"("id_type", "id_value");
CREATE INDEX "entity_crosswalk_entity_type_entity_key_idx"
  ON "entity_crosswalk"("entity_type", "entity_key");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "congress_bill_cosponsor" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "congress_committee" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "congress_committee_membership" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "entity_crosswalk" TO capiro_app;
  END IF;
END
$$;
