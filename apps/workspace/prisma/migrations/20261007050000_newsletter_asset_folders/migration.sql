-- Image-library folders do not connect saved bill/news content to newsletters.
CREATE TABLE "ws_newsletter_asset_folder" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ws_newsletter_asset_folder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ws_newsletter_asset_folder_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 100),
  CONSTRAINT "ws_newsletter_asset_folder_scope_key" UNIQUE ("id", "tenant_id", "owner_id")
);
CREATE INDEX "ws_newsletter_asset_folder_tenant_id_owner_id_idx"
  ON "ws_newsletter_asset_folder" ("tenant_id", "owner_id");
ALTER TABLE "ws_newsletter_asset" ADD COLUMN "folder_id" UUID;
ALTER TABLE "ws_newsletter_asset" ADD CONSTRAINT "ws_newsletter_asset_folder_scope_fkey"
  FOREIGN KEY ("folder_id", "tenant_id", "owner_id")
  REFERENCES "ws_newsletter_asset_folder" ("id", "tenant_id", "owner_id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
CREATE INDEX "ws_newsletter_asset_tenant_id_owner_id_folder_id_idx"
  ON "ws_newsletter_asset" ("tenant_id", "owner_id", "folder_id");
