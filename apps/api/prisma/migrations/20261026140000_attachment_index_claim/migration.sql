-- MG-06 attachment indexing attempt: durable claim, lease and source epoch.
--
-- Additive only: four new nullable/defaulted columns and one index plus one
-- BEFORE UPDATE trigger on the existing engagement_attachments owner. No column
-- is dropped or retyped, no row is rewritten, and no applied migration is edited.
--
-- Why a source epoch is needed at all: the existing indexer fences a purge or
-- stamp on the current (client_id, meeting_id, s3_key) tuple plus readiness. That
-- detects a changed association, but not an A→B→A change that returns the row to
-- the same tuple. metadata_revision cannot be reused as that fence: its trigger
-- fires on EVERY column change, including this indexer's own status writes, so it
-- is neither stable across an attempt nor monotonic in source identity. The epoch
-- below moves only with source identity.

ALTER TABLE "engagement_attachments"
  ADD COLUMN IF NOT EXISTS "index_source_generation" INTEGER NOT NULL DEFAULT 0 CHECK ("index_source_generation" >= 0),
  -- Token of the indexing attempt that currently owns the row (NULL = none).
  ADD COLUMN IF NOT EXISTS "index_claim_token" UUID,
  -- Lease expiry of that attempt; an expired claim is recoverable.
  ADD COLUMN IF NOT EXISTS "index_claim_expires_at" TIMESTAMPTZ(6),
  -- When the row is next due for an indexing attempt (NULL = nothing outstanding).
  ADD COLUMN IF NOT EXISTS "index_next_attempt_at" TIMESTAMPTZ(6);

-- Bounded due-attachment discovery for the worker: oldest due first, finite batch.
CREATE INDEX IF NOT EXISTS "engagement_attachments_index_next_attempt_idx"
  ON "engagement_attachments" ("index_next_attempt_at");

-- Source epoch. The comparison excludes this column, the claim columns and every
-- indexing-status column, so an attempt's own claim, purge and status writes can
-- never invalidate the attempt that is making them ("keep ordinary source status
-- and claim writes from invalidating their own work"), while any change to the
-- document's source identity (association, storage key, provenance, visibility,
-- lifecycle/scan verdict, supersession, approval/sharing of the artifact) moves
-- the epoch and fences every older attempt.
CREATE OR REPLACE FUNCTION engagement_attachment_index_source_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ignored text[] := ARRAY[
    'index_source_generation',
    'index_claim_token',
    'index_claim_expires_at',
    'index_next_attempt_at',
    'indexed_at',
    'extraction_status',
    'extraction_metadata_jsonb',
    'metadata_revision'
  ];
BEGIN
  IF (to_jsonb(NEW) - ignored) IS DISTINCT FROM (to_jsonb(OLD) - ignored) THEN
    NEW.index_source_generation := OLD.index_source_generation + 1;
  ELSE
    NEW.index_source_generation := OLD.index_source_generation;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS engagement_attachments_index_source_generation ON "engagement_attachments";
CREATE TRIGGER engagement_attachments_index_source_generation BEFORE UPDATE ON "engagement_attachments"
  FOR EACH ROW EXECUTE FUNCTION engagement_attachment_index_source_generation();
