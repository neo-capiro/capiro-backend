-- Gate H a-6 (LegiWatch) — a generic, additive version-link for
-- engagement_attachments, so a "regenerate" flow can supersede a document
-- instead of destructively deleting it.
--
-- ADDITIVE ONLY: one nullable, self-referential FK column + an index. No
-- DROP, no type change, no NOT NULL without a DEFAULT. A retry
-- (IF NOT EXISTS) is a no-op. Every existing row gets
-- superseded_by_attachment_id = NULL, i.e. "current" — byte-identical to
-- today's behavior for every reader that doesn't know this column exists.
--
-- ON DELETE SET NULL: if the NEWER attachment is ever hard-deleted via the
-- existing deleteAttachment path, the OLDER row must not be left pointing at
-- a row that no longer exists — it reverts to "current" rather than dangling.

ALTER TABLE "engagement_attachments"
  ADD COLUMN IF NOT EXISTS "superseded_by_attachment_id" UUID;

ALTER TABLE "engagement_attachments"
  DROP CONSTRAINT IF EXISTS "engagement_attachments_superseded_by_attachment_id_fkey";
ALTER TABLE "engagement_attachments"
  ADD CONSTRAINT "engagement_attachments_superseded_by_attachment_id_fkey"
  FOREIGN KEY ("superseded_by_attachment_id") REFERENCES "engagement_attachments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Serves both "find the current version among a group" (superseded_by IS
-- NULL, already covered by existing tenant/client/meeting indexes which this
-- does not duplicate) and "find what an old row was superseded by" lookups.
CREATE INDEX IF NOT EXISTS "engagement_attachments_superseded_by_attachment_id_idx"
  ON "engagement_attachments" ("superseded_by_attachment_id");
