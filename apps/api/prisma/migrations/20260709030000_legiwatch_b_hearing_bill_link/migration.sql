-- LegiWatch B3: hearing → bill agenda link. GLOBAL public-record table (same
-- posture as committee_hearing) — no tenant_id, no RLS. sync-hearings reads the
-- committee-meeting detail's relatedItems.bills[] (already fetched, previously
-- dropped) and writes one row per (hearing, bill). intel-api's detector joins
-- tracked bills × upcoming hearings here for the bill_hearing_scheduled alert.

CREATE TABLE "committee_hearing_bill" (
  "id"         TEXT NOT NULL,
  "hearing_id" TEXT NOT NULL,
  "bill_id"    TEXT NOT NULL,
  "congress"   INTEGER NOT NULL,
  "synced_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "committee_hearing_bill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "committee_hearing_bill_hearing_id_bill_id_key"
  ON "committee_hearing_bill"("hearing_id", "bill_id");
CREATE INDEX "committee_hearing_bill_bill_id_idx" ON "committee_hearing_bill"("bill_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "committee_hearing_bill" TO capiro_app;
  END IF;
END
$$;
