-- Provider-neutral message-removal state for mail_messages.
--
-- Additive only: two nullable columns plus a covering index. Gmail Trash/Spam/
-- delete and Microsoft Graph "@removed" events currently only ever write
-- metadata_jsonb.googleRemoved / .graphRemoved, which is not queryable and is
-- invisible to the timeline and AI evidence queries. removed_at / removed_reason
-- give both providers one first-class column pair; nothing is dropped, no row is
-- deleted, no body is cleared.
--
-- The backfill below is a one-time historical repair for rows that were already
-- marked removed via the old metadata-only path before this migration existed.
-- It is idempotent: re-running it is a no-op because the WHERE clause only
-- touches rows where removed_at IS NULL.
ALTER TABLE "mail_messages" ADD COLUMN "removed_at" TIMESTAMPTZ(6);
ALTER TABLE "mail_messages" ADD COLUMN "removed_reason" VARCHAR(32);

-- Backfill historical Gmail/Outlook removal markers from updated_at (the only
-- trustworthy timestamp available for these legacy rows — never cast an
-- arbitrary JSON timestamp).
UPDATE mail_messages
SET
  removed_at = updated_at,
  removed_reason = CASE
    WHEN metadata_jsonb ? 'googleRemoved'
      THEN CASE
        WHEN metadata_jsonb #>> '{googleRemoved,reason}' IN ('deleted', 'trashed', 'spam')
          THEN metadata_jsonb #>> '{googleRemoved,reason}'
        ELSE 'provider_removed'
      END
    WHEN metadata_jsonb ? 'graphRemoved'
      THEN 'provider_removed'
    ELSE NULL
  END
WHERE
  removed_at IS NULL
  AND (
    metadata_jsonb ? 'googleRemoved'
    OR metadata_jsonb ? 'graphRemoved'
  );

CREATE INDEX "mail_messages_thread_removed_received_idx"
  ON "mail_messages" ("thread_id", "removed_at", "received_at");
