-- Hill Day workflow (Workspace vNext, 2026-09): meeting-structured documents,
-- per-meeting resolution + carry-over records, generation jobs, PDF exports.

-- CreateEnum
CREATE TYPE "ws_hillday_doc_status" AS ENUM ('draft', 'generating', 'generated', 'partial', 'delivered');

-- CreateTable
CREATE TABLE "ws_hillday_document" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "blueprint_slug" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "client_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ws_hillday_doc_status" NOT NULL DEFAULT 'draft',
    "lookback_days" INTEGER NOT NULL DEFAULT 90,
    "time_zone" TEXT NOT NULL DEFAULT 'America/New_York',
    "week_start" DATE,
    "resolution_status" TEXT,
    "provenance" JSONB,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_hillday_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_hillday_meeting" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "event" JSONB NOT NULL DEFAULT '{}',
    "resolution" JSONB,
    "context" JSONB,
    "section" JSONB,
    "source_set" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_hillday_meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_hillday_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "units" JSONB NOT NULL DEFAULT '[]',
    "events" JSONB NOT NULL DEFAULT '[]',
    "quality" DOUBLE PRECISION,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_hillday_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_hillday_export" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "page_size" TEXT NOT NULL DEFAULT 'letter',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "filename" TEXT,
    "file" BYTEA,
    "size_bytes" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "ws_hillday_export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ws_hillday_document_tenant_id_updated_at_idx" ON "ws_hillday_document"("tenant_id", "updated_at");

-- CreateIndex
CREATE INDEX "ws_hillday_document_tenant_id_client_id_idx" ON "ws_hillday_document"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_hillday_meeting_document_id_event_id_key" ON "ws_hillday_meeting"("document_id", "event_id");

-- CreateIndex
CREATE INDEX "ws_hillday_meeting_tenant_id_document_id_idx" ON "ws_hillday_meeting"("tenant_id", "document_id");

-- CreateIndex
CREATE INDEX "ws_hillday_job_tenant_id_document_id_created_at_idx" ON "ws_hillday_job"("tenant_id", "document_id", "created_at");

-- CreateIndex
CREATE INDEX "ws_hillday_export_tenant_id_document_id_idx" ON "ws_hillday_export"("tenant_id", "document_id");

-- AddForeignKey
ALTER TABLE "ws_hillday_meeting" ADD CONSTRAINT "ws_hillday_meeting_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_hillday_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_hillday_job" ADD CONSTRAINT "ws_hillday_job_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_hillday_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_hillday_export" ADD CONSTRAINT "ws_hillday_export_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_hillday_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
