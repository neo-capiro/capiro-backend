-- Existing exports retain their actual bytes and have no invented request ID.
ALTER TABLE "ws_hillday_export"
  ADD COLUMN "request_id" UUID,
  ADD COLUMN "request_hash" VARCHAR(64),
  ADD COLUMN "render_input_sha256" VARCHAR(64),
  ADD COLUMN "content_sha256" VARCHAR(64),
  ADD COLUMN "source_updated_at" TIMESTAMP(3);

ALTER TABLE "ws_hillday_export" ADD CONSTRAINT "ws_hillday_export_request_binding"
  CHECK (("request_id" IS NULL) = ("request_hash" IS NULL));
ALTER TABLE "ws_hillday_export" ADD CONSTRAINT "ws_hillday_export_hashes"
  CHECK (("request_hash" IS NULL OR "request_hash" ~ '^[a-f0-9]{64}$')
    AND ("render_input_sha256" IS NULL OR "render_input_sha256" ~ '^[a-f0-9]{64}$')
    AND ("content_sha256" IS NULL OR "content_sha256" ~ '^[a-f0-9]{64}$'));

CREATE UNIQUE INDEX "ws_hillday_export_request_key"
  ON "ws_hillday_export" ("tenant_id", "actor_id", "request_id");
