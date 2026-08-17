-- CreateEnum
CREATE TYPE "ws_theme_version_status" AS ENUM ('draft', 'published', 'retired');

-- CreateTable
CREATE TABLE "ws_theme" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_theme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_theme_version" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "theme_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ws_theme_version_status" NOT NULL DEFAULT 'draft',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "settings_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "ws_theme_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ws_brand_asset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_brand_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ws_theme_tenant_id_slug_key" ON "ws_theme"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "ws_theme_tenant_id_idx" ON "ws_theme"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ws_theme_version_theme_id_version_key" ON "ws_theme_version"("theme_id", "version");

-- CreateIndex
CREATE INDEX "ws_theme_version_tenant_id_status_idx" ON "ws_theme_version"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "ws_brand_asset_tenant_id_idx" ON "ws_brand_asset"("tenant_id");

-- AddForeignKey
ALTER TABLE "ws_theme_version" ADD CONSTRAINT "ws_theme_version_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "ws_theme"("id") ON DELETE CASCADE;
