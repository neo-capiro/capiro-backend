-- LegiWatch Workstream B: extra change-detection watermarks on intel_tracked_bill
-- (status / cosponsor-count / text-version — signals the action-text watermark
-- can't see) + the intel_bill_match snapshot for the new-match emitter.
-- intel_tracked_bill already has RLS (20260706010000_intel_full_rls_hold); the
-- new table gets the identical tenant-isolation policy + GRANT.

ALTER TABLE "intel_tracked_bill" ADD COLUMN "last_seen_status" TEXT;
ALTER TABLE "intel_tracked_bill" ADD COLUMN "last_seen_cosponsors" INTEGER;
ALTER TABLE "intel_tracked_bill" ADD COLUMN "last_seen_text_date" TIMESTAMP(3);
-- Fiscal (last-alerted CBO estimate id) and hearing (last-alerted hearing id)
-- watermarks: without these the derived-baseline can't suppress a PRE-EXISTING
-- estimate/hearing (false alert on the 2nd sweep) and the emitter re-fires every
-- time the 14-day alert-dedup window lapses. They gate B7/B3 to fire only on a
-- genuinely new id.
ALTER TABLE "intel_tracked_bill" ADD COLUMN "last_seen_fiscal_id" TEXT;
ALTER TABLE "intel_tracked_bill" ADD COLUMN "last_seen_hearing_key" TEXT;

CREATE TABLE "intel_bill_match" (
  "id"            TEXT NOT NULL,
  "tenant_id"     TEXT NOT NULL,
  "client_id"     TEXT NOT NULL,
  "bill_id"       TEXT NOT NULL,
  "fit"           DOUBLE PRECISION NOT NULL,
  "matched_tags"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "congress"      INTEGER NOT NULL,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_fit_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intel_bill_match_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "intel_bill_match_client_id_bill_id_key"
  ON "intel_bill_match" ("client_id", "bill_id");
CREATE INDEX "intel_bill_match_tenant_client_idx"
  ON "intel_bill_match" ("tenant_id", "client_id");

-- Tenant isolation — identical to the other intel_* tables. tenant_id is TEXT;
-- current_tenant_id() returns UUID, so the predicate casts ::text (PG 42883).
ALTER TABLE "intel_bill_match" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_bill_match" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intel_bill_match_isolation" ON "intel_bill_match"
  USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_bill_match" TO capiro_app;
  END IF;
END
$$;
