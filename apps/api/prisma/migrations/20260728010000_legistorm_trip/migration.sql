-- LegiStorm Privately Funded Travel ingestion (WS-F, LegiStorm gaps/
-- enrichment plan). New, standalone table — no FK to any tenant-scoped
-- table (global reference data, same trust tier as census_district /
-- congress_member). Safe on a live database: this CREATEs a brand-new
-- table, touches nothing existing, and requires no backfill (the sync job
-- populates it after this migration runs).
--
-- id is LegiStorm's own trip id (natural PK). No retired-ids endpoint exists
-- for trips, so there is no deletion/reconciliation logic anywhere for this
-- table — rows are upserted by id only and never removed by a sync run.
CREATE TABLE "legistorm_trip" (
  "id" INTEGER NOT NULL,
  "approver_member_id" INTEGER,
  "approver_name" TEXT,
  "traveler_member_id" INTEGER,
  "traveler_staff_id" INTEGER,
  "traveler_name" TEXT,
  "companion_name" TEXT,
  "companion_status" TEXT,
  "start_date" DATE,
  "end_date" DATE,
  "duration_days" INTEGER,
  "purpose" TEXT,
  "comment" TEXT,
  "total_cost" DOUBLE PRECISION,
  "transportation_expenses" DOUBLE PRECISION,
  "lodging_expenses" DOUBLE PRECISION,
  "meal_expenses" DOUBLE PRECISION,
  "other_expenses" DOUBLE PRECISION,
  "companion_transportation_expenses" DOUBLE PRECISION,
  "companion_lodging_expenses" DOUBLE PRECISION,
  "companion_other_expenses" DOUBLE PRECISION,
  "destinations" JSONB NOT NULL DEFAULT '[]',
  "sponsors" JSONB NOT NULL DEFAULT '[]',
  "filed_date" DATE,
  "amended_date" DATE,
  "vendor_updated_at" TIMESTAMPTZ(6),
  "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "legistorm_trip_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "legistorm_trip_approver_member_id_idx" ON "legistorm_trip" ("approver_member_id");
CREATE INDEX "legistorm_trip_traveler_member_id_idx" ON "legistorm_trip" ("traveler_member_id");
CREATE INDEX "legistorm_trip_traveler_staff_id_idx" ON "legistorm_trip" ("traveler_staff_id");
