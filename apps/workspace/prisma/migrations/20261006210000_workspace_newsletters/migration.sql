-- CreateTable
CREATE TABLE "ws_newsletter_document" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "config" JSONB NOT NULL,
    "design" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_newsletter_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_library_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_newsletter_library_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_comment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "author_id" TEXT NOT NULL,
    "block_id" TEXT,
    "parent_id" UUID,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_asset" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_newsletter_stage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "design" JSONB NOT NULL,
    "html" TEXT NOT NULL,
    "plain_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_newsletter_stage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ws_newsletter_document_tenant_id_owner_id_updated_at_idx" ON "ws_newsletter_document"("tenant_id", "owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "ws_newsletter_library_item_tenant_id_owner_id_kind_idx" ON "ws_newsletter_library_item"("tenant_id", "owner_id", "kind");

-- CreateIndex
CREATE INDEX "ws_newsletter_comment_tenant_id_document_id_created_at_idx" ON "ws_newsletter_comment"("tenant_id", "document_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_asset_token_key" ON "ws_newsletter_asset"("token");

-- CreateIndex
CREATE INDEX "ws_newsletter_asset_tenant_id_owner_id_idx" ON "ws_newsletter_asset"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "ws_newsletter_stage_tenant_id_owner_id_created_at_idx" ON "ws_newsletter_stage"("tenant_id", "owner_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ws_newsletter_stage_document_id_revision_key" ON "ws_newsletter_stage"("document_id", "revision");

-- AddForeignKey
ALTER TABLE "ws_newsletter_comment" ADD CONSTRAINT "ws_newsletter_comment_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_newsletter_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ws_newsletter_stage" ADD CONSTRAINT "ws_newsletter_stage_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_newsletter_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
