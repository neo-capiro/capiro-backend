-- Meetings & Meri redesign — Phase 1, Wave 0 foundations.
-- (docs/plans/2026-07-10-meetings-meri-v2-redesign-plan.md §5)
--
-- Adds, to already-RLS-protected tables (no new row-level-security policy is
-- needed — RLS covers rows, not columns):
--   • meetings: derived virtual-meeting classification (is_virtual/join_link/
--     provider) + private-until-shared visibility (visibility/shared_at/
--     shared_by_user_id). Existing rows backfill to visibility='private',
--     is_virtual=false — i.e. the current single-owner/private reality, so no
--     meeting becomes newly visible on deploy.
--   • meeting_debriefs: a lifecycle status mirroring meeting_prep_status.
--     Existing debriefs backfill to 'generated' (unchanged behavior until a
--     user approves — only 'approved' debriefs reach the Library / sharing).
--   • engagement_attachments: indexed_at, stamped when client-KB indexing of a
--     document completes (drives the Documents-tab per-file "Indexed" badge).
--
-- shared_by_user_id / (existing) created_by_user_id are bare UUIDs with no FK,
-- matching the established convention for user-attribution columns on meetings.

CREATE TYPE "meeting_visibility" AS ENUM (
  'private',
  'shared'
);

CREATE TYPE "meeting_debrief_status" AS ENUM (
  'generated',
  'edited',
  'approved'
);

ALTER TABLE "meetings"
  ADD COLUMN "is_virtual" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "join_link" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "visibility" "meeting_visibility" NOT NULL DEFAULT 'private',
  ADD COLUMN "shared_at" TIMESTAMPTZ(6),
  ADD COLUMN "shared_by_user_id" UUID;

ALTER TABLE "meeting_debriefs"
  ADD COLUMN "status" "meeting_debrief_status" NOT NULL DEFAULT 'generated';

ALTER TABLE "engagement_attachments"
  ADD COLUMN "indexed_at" TIMESTAMPTZ(6);
