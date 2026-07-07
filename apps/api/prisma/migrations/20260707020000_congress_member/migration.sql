-- Bucket-#3 C6.P6.1 / C1.V1: canonical congressional-member roster. GLOBAL
-- public-record table (no tenant_id/RLS — congress_bill class). Additive.
CREATE TABLE "congress_member" (
  "bioguide_id"    TEXT NOT NULL,
  "first_name"     TEXT NOT NULL,
  "last_name"      TEXT NOT NULL,
  "full_name"      TEXT NOT NULL,
  "party"          TEXT,
  "state"          TEXT,
  "district"       INTEGER,
  "chamber"        TEXT NOT NULL,
  "lis_id"         TEXT,
  "is_current"     BOOLEAN NOT NULL DEFAULT false,
  "congresses"     INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  "ids_jsonb"      JSONB NOT NULL DEFAULT '{}',
  "update_date"    TIMESTAMPTZ(6),
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "congress_member_pkey" PRIMARY KEY ("bioguide_id")
);
CREATE UNIQUE INDEX "congress_member_lis_id_key" ON "congress_member"("lis_id");
CREATE INDEX "congress_member_chamber_state_idx" ON "congress_member"("chamber", "state");
CREATE INDEX "congress_member_last_name_idx" ON "congress_member"("last_name");
CREATE INDEX "congress_member_is_current_idx" ON "congress_member"("is_current");
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "congress_member" TO capiro_app;
  END IF;
END
$$;
