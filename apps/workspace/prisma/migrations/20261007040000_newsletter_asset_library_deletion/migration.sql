-- Library deletion hides a file from authoring while retaining immutable bytes
-- and its capability URL for saved templates, staged and previously sent email.
ALTER TABLE "ws_newsletter_asset"
  ADD COLUMN "deleted_at" TIMESTAMP(3);
