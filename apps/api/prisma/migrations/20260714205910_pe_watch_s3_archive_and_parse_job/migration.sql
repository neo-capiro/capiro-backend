-- AlterTable
ALTER TABLE "source_document" ADD COLUMN     "archive_bucket" TEXT,
ADD COLUMN     "archive_kms_key_arn" TEXT,
ADD COLUMN     "archive_s3_key" TEXT,
ADD COLUMN     "archive_version_id" TEXT,
ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "retain_until" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "document_parse_job" (
    "id" UUID NOT NULL,
    "source_document_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_job_id" TEXT,
    "mode" TEXT NOT NULL,
    "result_type" TEXT NOT NULL,
    "page_start" INTEGER,
    "page_end" INTEGER,
    "input_sha256" CHAR(64) NOT NULL,
    "output_markdown_s3_key" TEXT,
    "output_json_s3_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "credits_used" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "document_parse_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_parse_job_source_document_idx" ON "document_parse_job"("source_document_id");

-- CreateIndex
CREATE INDEX "document_parse_job_status_idx" ON "document_parse_job"("status");

-- CreateIndex
CREATE INDEX "document_parse_job_provider_job_idx" ON "document_parse_job"("provider_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_parse_job_dedup_key" ON "document_parse_job"("source_document_id", "input_sha256", "provider", "page_start", "page_end");

-- CreateIndex
CREATE INDEX "source_document_archive_version_idx" ON "source_document"("archive_version_id");

-- AddForeignKey
ALTER TABLE "document_parse_job" ADD CONSTRAINT "document_parse_job_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

