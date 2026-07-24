-- LegiStorm Legislative Districts ingestion (WS-B, LegiStorm gaps/enrichment
-- plan). New, standalone table — no FK to any tenant-scoped table (global
-- reference data, same trust tier as census_district). Safe on a live
-- database: this CREATEs a brand-new table, touches nothing existing, and
-- requires no backfill (the sync job populates it after this migration runs).
--
-- One row per (legistorm district id, status): a district can have BOTH a
-- current ('C') and a future/enacted-not-yet-effective ('F') row
-- simultaneously across a redistricting cycle — WS-C's redistricting-watch
-- alerting diffs the 'F' rows against the 'C' rows for the same state/chamber.
CREATE TABLE "legislative_district" (
  "id" TEXT NOT NULL,
  "legistorm_district_id" INTEGER NOT NULL,
  "chamber" TEXT NOT NULL,
  "state" VARCHAR(2) NOT NULL,
  "district_no" TEXT,
  "senate_class" INTEGER,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "effective_date" DATE,
  "enacted_date" DATE,
  "current_member_bioguides" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "kml_s3_key" TEXT,
  "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "legislative_district_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "legislative_district_state_chamber_status_idx" ON "legislative_district" ("state", "chamber", "status");
CREATE INDEX "legislative_district_legistorm_district_id_idx" ON "legislative_district" ("legistorm_district_id");
