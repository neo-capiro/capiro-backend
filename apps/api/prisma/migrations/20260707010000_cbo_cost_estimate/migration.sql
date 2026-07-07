-- Bucket-#3 C4.F1 (SC2.4): CBO cost-estimate spine. GLOBAL public-record
-- table (no tenant_id/RLS — congress_bill class). Additive.
CREATE TABLE "cbo_cost_estimate" (
  "id"             TEXT NOT NULL,
  "bill_id"        TEXT,
  "congress"       INTEGER NOT NULL,
  "bill_type"      TEXT NOT NULL,
  "bill_number"    TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "description"    TEXT,
  "pub_date"       TIMESTAMPTZ(6) NOT NULL,
  "cbo_url"        TEXT NOT NULL,
  "source"         TEXT NOT NULL DEFAULT 'congress-api',
  "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cbo_cost_estimate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cbo_cost_estimate_cbo_url_key" ON "cbo_cost_estimate"("cbo_url");
CREATE INDEX "cbo_cost_estimate_bill_id_idx" ON "cbo_cost_estimate"("bill_id");
CREATE INDEX "cbo_cost_estimate_pub_date_idx" ON "cbo_cost_estimate"("pub_date" DESC);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "cbo_cost_estimate" TO capiro_app;
  END IF;
END
$$;
