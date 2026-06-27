-- CreateEnum
CREATE TYPE "ws_author_kind" AS ENUM ('meri', 'person');

-- CreateTable
CREATE TABLE "ws_doc_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "label" TEXT,
    "author_id" TEXT NOT NULL,
    "author_kind" "ws_author_kind" NOT NULL DEFAULT 'person',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_doc_version_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ws_doc_version_tenant_id_idx" ON "ws_doc_version"("tenant_id");

-- CreateIndex
CREATE INDEX "ws_doc_version_draft_id_idx" ON "ws_doc_version"("draft_id");

-- CreateIndex
CREATE INDEX "ws_doc_version_draft_id_created_at_idx" ON "ws_doc_version"("draft_id", "created_at");

-- AddForeignKey
ALTER TABLE "ws_doc_version" ADD CONSTRAINT "ws_doc_version_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
