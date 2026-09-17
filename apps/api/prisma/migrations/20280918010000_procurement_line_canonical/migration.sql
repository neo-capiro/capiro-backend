-- Canonical PROCUREMENT budget line items (P-1 lines / BLINs) with no Program
-- Element parent. Additive only: three new global tables (no tenant_id / RLS —
-- public-domain J-book data, read-only via API), mirroring program_element /
-- program_element_year / program_element_source. Nothing existing is touched.
--
-- Written ONLY by ProcurementLineWriterService
-- (apps/api/src/defense-budget/procurement/) from composer output whose
-- verification decision is PASS, and ONLY when
-- DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES=1. Dark by default.

-- CreateTable
CREATE TABLE "procurement_line" (
    "id" UUID NOT NULL,
    "appropriation_code" VARCHAR(16) NOT NULL,
    "appropriation_title" TEXT,
    "component" TEXT,
    "budget_activity" TEXT,
    "budget_sub_activity" TEXT,
    "p1_line_number" INTEGER,
    "line_item_number" VARCHAR(32) NOT NULL,
    "title" TEXT NOT NULL,
    "related_pe_code" VARCHAR(16),
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procurement_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- subline_key is NOT NULL with a '' sentinel for the line-level (P-1 total) row:
-- Postgres treats NULLs as distinct in UNIQUE constraints, which would let a re-run
-- insert a duplicate line-level row and break the writer's idempotency.
-- Money columns are $ millions at Decimal(18,6) so $K-printed P-1 values are exact.
CREATE TABLE "procurement_line_year" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "fy" INTEGER NOT NULL,
    "subline_key" VARCHAR(32) NOT NULL DEFAULT '',
    "subline_title" TEXT,
    "p1_line_number" INTEGER,
    "request" DECIMAL(18,6),
    "hasc_mark" DECIMAL(18,6),
    "sasc_mark" DECIMAL(18,6),
    "hac_d_mark" DECIMAL(18,6),
    "sac_d_mark" DECIMAL(18,6),
    "conference" DECIMAL(18,6),
    "enacted" DECIMAL(18,6),
    "actuals" DECIMAL(18,6),
    "quantity" INTEGER,
    "raw_jsonb" JSONB NOT NULL DEFAULT '{}',
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procurement_line_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_line_source" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "year_id" UUID,
    "doc_type" VARCHAR(8) NOT NULL,
    "exhibit_type" VARCHAR(16),
    "fy" INTEGER,
    "source_url" TEXT NOT NULL,
    "page_number" INTEGER,
    "page_end" INTEGER,
    "snippet" TEXT,
    "publisher" VARCHAR(64),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "extractor_version" TEXT,
    "source_span_hash" CHAR(64) NOT NULL,
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "source_document_id" UUID,

    CONSTRAINT "procurement_line_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "procurement_line_appropriation_line_item_key" ON "procurement_line"("appropriation_code", "line_item_number");

-- CreateIndex
CREATE INDEX "procurement_line_line_item_number_idx" ON "procurement_line"("line_item_number");

-- CreateIndex
CREATE INDEX "procurement_line_component_idx" ON "procurement_line"("component");

-- CreateIndex
CREATE INDEX "procurement_line_related_pe_code_idx" ON "procurement_line"("related_pe_code");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_line_year_line_fy_subline_key" ON "procurement_line_year"("line_id", "fy", "subline_key");

-- CreateIndex
CREATE INDEX "procurement_line_year_fy_idx" ON "procurement_line_year"("fy");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_line_source_line_span_hash_key" ON "procurement_line_source"("line_id", "source_span_hash");

-- CreateIndex
CREATE INDEX "procurement_line_source_line_idx" ON "procurement_line_source"("line_id");

-- CreateIndex
CREATE INDEX "procurement_line_source_line_fy_idx" ON "procurement_line_source"("line_id", "fy");

-- CreateIndex
CREATE INDEX "procurement_line_source_year_idx" ON "procurement_line_source"("year_id");

-- CreateIndex
CREATE INDEX "procurement_line_source_source_document_idx" ON "procurement_line_source"("source_document_id");

-- AddForeignKey
ALTER TABLE "procurement_line_year" ADD CONSTRAINT "procurement_line_year_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "procurement_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_line_source" ADD CONSTRAINT "procurement_line_source_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "procurement_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_line_source" ADD CONSTRAINT "procurement_line_source_year_id_fkey" FOREIGN KEY ("year_id") REFERENCES "procurement_line_year"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_line_source" ADD CONSTRAINT "procurement_line_source_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
