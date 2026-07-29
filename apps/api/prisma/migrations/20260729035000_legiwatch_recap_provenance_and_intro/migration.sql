-- LegiWatch complete closeout: per-user orientation + generated-document provenance.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "legiwatch_intro_seen_at" TIMESTAMPTZ(6);

ALTER TABLE "engagement_attachments"
  ADD COLUMN IF NOT EXISTS "source_entity_type" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "source_entity_id" VARCHAR(128);

CREATE INDEX IF NOT EXISTS "engagement_attachments_generated_source_idx"
  ON "engagement_attachments" (
    "tenant_id",
    "client_id",
    "source",
    "source_entity_type",
    "created_at"
  );
