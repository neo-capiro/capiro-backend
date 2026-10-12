CREATE UNIQUE INDEX "ws_newsletter_comment_scope_key" ON "ws_newsletter_comment" ("id", "tenant_id", "document_id");
CREATE TABLE "ws_newsletter_thread_watcher" (
  "id" UUID PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "root_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ws_newsletter_thread_watcher_root_scope_fkey" FOREIGN KEY ("root_id", "tenant_id", "document_id") REFERENCES "ws_newsletter_comment" ("id", "tenant_id", "document_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ws_newsletter_thread_watcher_root_id_user_id_key" ON "ws_newsletter_thread_watcher" ("root_id", "user_id");
CREATE INDEX "ws_newsletter_thread_watcher_tenant_id_document_id_idx" ON "ws_newsletter_thread_watcher" ("tenant_id", "document_id");
CREATE TABLE "ws_newsletter_review_email_request" (
  "id" UUID PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "root_id" UUID NOT NULL,
  "comment_id" UUID NOT NULL,
  "recipient_id" TEXT NOT NULL,
  "source_client_ids" UUID[] NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ws_newsletter_review_email_request_comment_scope_fkey" FOREIGN KEY ("comment_id", "tenant_id", "document_id") REFERENCES "ws_newsletter_comment" ("id", "tenant_id", "document_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ws_newsletter_review_email_request_root_scope_fkey" FOREIGN KEY ("root_id", "tenant_id", "document_id") REFERENCES "ws_newsletter_comment" ("id", "tenant_id", "document_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ws_newsletter_review_email_request_comment_id_recipient_id_key" ON "ws_newsletter_review_email_request" ("comment_id", "recipient_id");
CREATE INDEX "ws_newsletter_review_email_request_created_at_idx" ON "ws_newsletter_review_email_request" ("created_at");
CREATE INDEX "ws_newsletter_review_email_request_tenant_id_document_id_idx" ON "ws_newsletter_review_email_request" ("tenant_id", "document_id");
