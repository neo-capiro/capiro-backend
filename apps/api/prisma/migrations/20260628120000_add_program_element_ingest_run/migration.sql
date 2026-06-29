-- Program Element ingest-run provenance + completeness ledger.
-- One row per artifact load (committee/conference/enacted/pdoc loaders) so we can
-- prove a parse extracted everything it should have (the missing "denominator").
-- GLOBAL table (no tenant_id / RLS): ingest metadata for public-domain budget data,
-- same convention as program_element / program_element_year.

CREATE TABLE IF NOT EXISTS "program_element_ingest_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source" TEXT NOT NULL,
    "fy" INTEGER,
    "artifact_path" TEXT,
    "artifact_sha256" TEXT,
    "rows_emitted" INTEGER NOT NULL DEFAULT 0,
    "upserted" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "quarantined" INTEGER NOT NULL DEFAULT 0,
    "pe_codes_distinct" INTEGER NOT NULL DEFAULT 0,
    "title_truncated" INTEGER NOT NULL DEFAULT 0,
    "units_anomalies" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "notes" TEXT,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "program_element_ingest_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "program_element_ingest_run_source_idx"
    ON "program_element_ingest_run" ("source");
CREATE INDEX IF NOT EXISTS "program_element_ingest_run_fy_idx"
    ON "program_element_ingest_run" ("fy");
CREATE INDEX IF NOT EXISTS "program_element_ingest_run_created_idx"
    ON "program_element_ingest_run" ("created_at" DESC);
