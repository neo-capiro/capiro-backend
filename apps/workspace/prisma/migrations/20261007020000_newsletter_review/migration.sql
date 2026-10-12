CREATE TABLE "ws_newsletter_reviewer" (
  "id" UUID NOT NULL PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'commenter' CHECK ("role" IN ('owner', 'viewer', 'commenter')),
  "notifications" TEXT NOT NULL DEFAULT 'mentions' CHECK ("notifications" IN ('all', 'mentions', 'none')),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ws_newsletter_reviewer_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ws_newsletter_document"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ws_newsletter_reviewer_document_id_user_id_key" ON "ws_newsletter_reviewer"("document_id", "user_id");
CREATE INDEX "ws_newsletter_reviewer_tenant_id_user_id_idx" ON "ws_newsletter_reviewer"("tenant_id", "user_id");
ALTER TYPE "ws_notification_kind" ADD VALUE IF NOT EXISTS 'newsletter_review';
ALTER TYPE "ws_notification_kind" ADD VALUE IF NOT EXISTS 'newsletter_comment';
ALTER TABLE "ws_notification" ADD COLUMN "newsletter_id" UUID;
