CREATE TABLE "community_funding_request" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identity_hash" CHAR(64) NOT NULL,
    "chamber" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "congress" INTEGER,
    "fiscal_year" INTEGER NOT NULL,
    "requester_name" TEXT NOT NULL,
    "requester_state" CHAR(2),
    "requester_district" TEXT,
    "recipient_name" TEXT NOT NULL,
    "recipient_normalized" TEXT NOT NULL,
    "recipient_address" TEXT,
    "city" TEXT,
    "state" CHAR(2),
    "zip" TEXT,
    "project_title" TEXT NOT NULL,
    "project_description" TEXT,
    "requested_amount_usd" DECIMAL(18,2) NOT NULL,
    "final_amount_usd" DECIMAL(18,2),
    "amount_stage_raw" TEXT NOT NULL,
    "appropriations_account_raw" TEXT,
    "appropriations_account_normalized" TEXT,
    "subcommittee" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_funding_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_funding_request_chamber_check" CHECK ("chamber" IN ('house', 'senate')),
    CONSTRAINT "community_funding_request_type_check" CHECK (("chamber" = 'house' AND "request_type" = 'cpf') OR ("chamber" = 'senate' AND "request_type" = 'cds')),
    CONSTRAINT "community_funding_request_amount_check" CHECK ("requested_amount_usd" >= 0 AND ("final_amount_usd" IS NULL OR "final_amount_usd" >= 0))
);

CREATE UNIQUE INDEX "community_funding_request_identity_hash_key" ON "community_funding_request"("identity_hash");
CREATE INDEX "community_funding_request_fy_chamber_idx" ON "community_funding_request"("fiscal_year", "chamber");
CREATE INDEX "community_funding_request_recipient_idx" ON "community_funding_request"("recipient_normalized");

-- Provenance: one row per (canonical request x source occurrence). A canonical
-- request can have MULTIPLE authoritative source records — e.g. a House
-- subcommittee CPF PDF row AND the House consolidated CPF XLSX row for the exact
-- same real request. This is the repair of the original #1328 design, where
-- source_document_id/source_page/source_row lived directly on
-- community_funding_request AND were part of its identity hash, so the same real
-- request published in two authoritative documents produced two canonical rows.
CREATE TABLE "community_funding_request_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "source_page" INTEGER,
    "source_row" INTEGER NOT NULL,
    "source_hash" CHAR(64) NOT NULL,
    "retrieved_at" TIMESTAMPTZ(6) NOT NULL,
    "requester_name_raw" TEXT NOT NULL,
    "amount_stage_raw" TEXT NOT NULL,
    "requested_amount_usd" DECIMAL(18,2) NOT NULL,
    "final_amount_usd" DECIMAL(18,2),
    "appropriations_account_raw" TEXT,
    "subcommittee" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_funding_request_source_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_funding_request_source_amount_check" CHECK ("requested_amount_usd" >= 0 AND ("final_amount_usd" IS NULL OR "final_amount_usd" >= 0))
);

-- Idempotent provenance identity: the same document re-run (same page+row within
-- the same source document, for the same canonical request) is a no-op upsert, not
-- a duplicate insert. Genuinely distinct occurrences (different document, or
-- different page/row within one document) always coexist.
CREATE UNIQUE INDEX "community_funding_request_source_occurrence_key" ON "community_funding_request_source"("request_id", "source_document_id", "source_page", "source_row");
CREATE INDEX "community_funding_request_source_request_idx" ON "community_funding_request_source"("request_id");
CREATE INDEX "community_funding_request_source_document_idx" ON "community_funding_request_source"("source_document_id");
ALTER TABLE "community_funding_request_source" ADD CONSTRAINT "community_funding_request_source_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "community_funding_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_funding_request_source" ADD CONSTRAINT "community_funding_request_source_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "community_funding_discovery_crawl" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "adapter_id" TEXT NOT NULL, "run_key" TEXT NOT NULL,
    "request_url" TEXT NOT NULL, "status_code" INTEGER, "status" TEXT NOT NULL, "content_sha256" CHAR(64),
    "byte_size" INTEGER, "items_seen" INTEGER NOT NULL DEFAULT 0, "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL, "failure_reason" TEXT, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_funding_discovery_crawl_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cfdc_adapter_started_idx" ON "community_funding_discovery_crawl"("adapter_id", "started_at" DESC);
CREATE INDEX "cfdc_run_key_idx" ON "community_funding_discovery_crawl"("run_key");

CREATE TABLE "community_funding_discovery_candidate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "crawl_id" UUID NOT NULL, "adapter_id" TEXT NOT NULL,
    "run_key" TEXT NOT NULL, "candidate_url" TEXT NOT NULL, "title" TEXT, "resolution" TEXT NOT NULL,
    "reason" TEXT NOT NULL, "emitted" BOOLEAN NOT NULL, "fiscal_year" INTEGER NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_funding_discovery_candidate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cfdcand_run_url_uidx" ON "community_funding_discovery_candidate"("adapter_id", "run_key", "candidate_url");
CREATE INDEX "cfdcand_crawl_idx" ON "community_funding_discovery_candidate"("crawl_id");
ALTER TABLE "community_funding_discovery_candidate" ADD CONSTRAINT "community_funding_discovery_candidate_crawl_id_fkey" FOREIGN KEY ("crawl_id") REFERENCES "community_funding_discovery_crawl"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "community_funding_ingest_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(), "source" TEXT NOT NULL, "chamber" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL, "subcommittee" TEXT, "artifact_path" TEXT, "artifact_sha256" CHAR(64),
    "rows_emitted" INTEGER NOT NULL DEFAULT 0, "upserted" INTEGER NOT NULL DEFAULT 0, "changed" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0, "status" TEXT NOT NULL DEFAULT 'ok', "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "community_funding_ingest_run_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "community_funding_ingest_run_unit_idx" ON "community_funding_ingest_run"("chamber", "fiscal_year");
CREATE INDEX "community_funding_ingest_run_sha_idx" ON "community_funding_ingest_run"("artifact_sha256");
