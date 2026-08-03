-- Soft-delete Graph occurrence shells that were stored with empty subject and
-- no organizer/attendees (DualSight: ~1200 "Untitled calendar event" rows).
-- These are not real meetings; the sync path now skips them on ingest.
UPDATE "meetings"
SET "status" = 'deleted',
    "metadata_jsonb" = COALESCE("metadata_jsonb", '{}'::jsonb) || jsonb_build_object(
      'sparseOccurrenceCleanup', true,
      'sparseOccurrenceCleanupAt', now()
    )
WHERE "status" = 'scheduled'
  AND "subject" = 'Untitled calendar event'
  AND "source" = 'outlook'
  AND COALESCE("raw_jsonb"->>'type', '') = 'occurrence'
  AND (COALESCE("raw_jsonb"->>'subject', '') = '')
  AND "organizer_email" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "meeting_attendees" a WHERE a."meeting_id" = "meetings"."id"
  );
