-- A private reusable brand kit for each verified Workspace owner.
CREATE TABLE "ws_newsletter_brand_kit" (
  "tenant_id" UUID NOT NULL,
  "owner_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "payload" JSONB NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ws_newsletter_brand_kit_pkey" PRIMARY KEY ("tenant_id", "owner_id"),
  CONSTRAINT "ws_newsletter_brand_kit_revision_check" CHECK ("revision" > 0)
);
