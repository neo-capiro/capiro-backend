-- Engagement Phase 2 §d — per-artifact approval + sharing lifecycle.
-- (docs/plans/…engagement-phase-2-ux-completion-plan.md §d)
--
-- Today, sharing is WHOLE-MEETING only (meetings.visibility/shared_at/
-- shared_by_user_id, added by 20260710120000_meetings_v2_visibility), and
-- "approval" exists only for meeting_preps/meeting_debriefs (their own status
-- column, added by 20260505002000_meeting_debriefs_and_prep_approval /
-- 20260710120000). meeting_notes and engagement_attachments have NO approval
-- concept at all — a note is (wrongly) treated as "approved" the instant it
-- exists (see EngagementService.libraryArtifactWhere's `notes: { some: {} }`
-- and decorateMeetings' `notesApproved: row.notes.length > 0`). This migration
-- adds the missing per-artifact approval + sharing columns so the API can gate
-- the Library and the client-facing shared feed on REAL approval, and can
-- share/unshare individual artifacts instead of only the whole meeting.
--
-- Purely additive: no table is created or dropped, and no existing column,
-- index, or RLS policy is touched. All four tables already have tenant-
-- isolation RLS policies (ADD COLUMN does not disturb them) and capiro_app
-- already holds table-level DML grants — column privileges are inherited from
-- the table grant, so no GRANT is re-issued (same reasoning as
-- 20260803010000_engagement_generation_gateway's header).
--
--   meeting_notes            gains its FIRST lifecycle status ('draft' by
--                            default — existing notes stay unapproved, never
--                            inferred-approved from mere existence) plus
--                            approval + sharing columns.
--   meeting_preps            already has its own `status` (meeting_prep_status
--                            enum) — left untouched here. Gains ONLY the
--                            sharing columns.
--   meeting_debriefs         already has its own `status`
--                            (meeting_debrief_status enum) — left untouched
--                            here. Gains ONLY the sharing columns.
--   engagement_attachments   gains its FIRST approval concept (attachments had
--                            no status/approval field at all before this) plus
--                            sharing columns.
--
-- FK convention note (deliberate judgment call — flagged for review): some
-- existing user-attribution columns in this schema are INTENTIONALLY bare
-- UUIDs with no FK (meetings.created_by_user_id / shared_by_user_id — see
-- 20260710120000's header: "matching the established convention for
-- user-attribution columns on meetings"; also meeting_preps.edited_by_user_id
-- and client_memory_access.granted_by, the latter commented "survives the
-- granter's departure"), while others DO carry a real FK (meeting_notes.
-- author_user_id / meeting_debriefs.author_user_id, both ON DELETE SET NULL,
-- from 20260505002000). The six *_user_id columns added below get a REAL FK,
-- ON DELETE SET NULL — following the author_user_id precedent rather than the
-- meetings.shared_by_user_id precedent, because these are brand-new columns
-- and referential integrity is worth the small extra constraint-check cost.
-- ON UPDATE CASCADE mirrors Prisma's own default codegen for an unqualified
-- `onDelete: SetNull` relation (irrelevant in practice — id columns are
-- immutable UUIDs, so ON UPDATE never actually fires).

-- ---------------------------------------------------------------------------
-- 1. meeting_notes — first-class approval + sharing
-- ---------------------------------------------------------------------------
ALTER TABLE "meeting_notes"
  -- 'draft' (default; captured, never explicitly approved) | 'edited' (was
  -- approved, then a later edit reset it — needs re-approval) | 'approved'
  -- (explicit POST .../notes/:noteId/approve). Plain varchar, not a native
  -- enum — mirrors the house convention used for engagement_attachments'
  -- lifecycle_status/scan_status/extraction_status (documented via comment,
  -- not pg_enum) rather than meeting_prep_status/meeting_debrief_status.
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(24) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "shared_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "shared_by_user_id" UUID;

ALTER TABLE "meeting_notes"
  ADD CONSTRAINT "meeting_notes_approved_by_user_id_fkey"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "meeting_notes"
  ADD CONSTRAINT "meeting_notes_shared_by_user_id_fkey"
    FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "meeting_notes_tenant_shared_idx"
  ON "meeting_notes" ("tenant_id", "shared_at");

-- ---------------------------------------------------------------------------
-- 2. meeting_preps — sharing only (approval already exists: `status` column)
-- ---------------------------------------------------------------------------
ALTER TABLE "meeting_preps"
  ADD COLUMN IF NOT EXISTS "shared_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "shared_by_user_id" UUID;

ALTER TABLE "meeting_preps"
  ADD CONSTRAINT "meeting_preps_shared_by_user_id_fkey"
    FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "meeting_preps_tenant_shared_idx"
  ON "meeting_preps" ("tenant_id", "shared_at");

-- ---------------------------------------------------------------------------
-- 3. meeting_debriefs — sharing only (approval already exists: `status` column)
-- ---------------------------------------------------------------------------
ALTER TABLE "meeting_debriefs"
  ADD COLUMN IF NOT EXISTS "shared_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "shared_by_user_id" UUID;

ALTER TABLE "meeting_debriefs"
  ADD CONSTRAINT "meeting_debriefs_shared_by_user_id_fkey"
    FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "meeting_debriefs_tenant_shared_idx"
  ON "meeting_debriefs" ("tenant_id", "shared_at");

-- ---------------------------------------------------------------------------
-- 4. engagement_attachments — first-class approval + sharing
-- ---------------------------------------------------------------------------
ALTER TABLE "engagement_attachments"
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "shared_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "shared_by_user_id" UUID;

ALTER TABLE "engagement_attachments"
  ADD CONSTRAINT "engagement_attachments_approved_by_user_id_fkey"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "engagement_attachments"
  ADD CONSTRAINT "engagement_attachments_shared_by_user_id_fkey"
    FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "engagement_attachments_tenant_shared_idx"
  ON "engagement_attachments" ("tenant_id", "shared_at");

-- ---------------------------------------------------------------------------
-- 5. Conservative backfill for LEGACY shared meetings
-- ---------------------------------------------------------------------------
-- meetings.visibility is a native Postgres enum (`meeting_visibility`:
-- 'private' | 'shared' — created by 20260710120000_meetings_v2_visibility).
-- It is cast explicitly below (`::"meeting_visibility"`) rather than relying
-- on untyped-literal inference: these UPDATE ... FROM statements are not the
-- simple `column = 'text'` shape Postgres always infers for free, so the
-- comparison is spelled out for clarity and to avoid any ambiguity. Likewise
-- meeting_preps.status / meeting_debriefs.status are native enums
-- (meeting_prep_status / meeting_debrief_status) and are cast the same way.
--
-- Only preps/debriefs that were ALREADY 'approved' (their own pre-existing
-- status column) on an ALREADY-'shared' meeting get backfilled — they reached
-- "approved" through the pre-Phase-2 flow, and the meeting-level shared_at /
-- shared_by_user_id are the only record of when/who shared them, so copying
-- those onto the artifact is the closest honest reconstruction of "this
-- artifact has been shared" available from existing data.
--
-- Deliberately NOT backfilled, for every legacy shared meeting, no matter how
-- long it's been shared: meeting_notes.shared_at and
-- engagement_attachments.shared_at. Neither table had any approval concept
-- before this migration (notes: existence-as-approval was exactly the bug
-- being fixed here; attachments: had no status/approval field at all), so
-- there is no honest signal to backfill "shared" from — inferring approval
-- (and therefore shareability) from mere existence is the bug this migration
-- exists to close, not something to re-introduce via backfill.
--
-- Practical effect: a legacy-shared meeting's notes and attachments will
-- appear to "disappear" from the client-facing shared feed
-- (listSharedMeetingsForClient) until a user explicitly approves + shares
-- them under the new per-artifact flow. This is INTENDED — a deliberately
-- conservative choice — not a bug or data loss (the rows themselves, and
-- their approval-independent visibility in the owner's own Meeting Library,
-- are completely unaffected).
UPDATE "meeting_preps" AS p
SET "shared_at" = m."shared_at",
    "shared_by_user_id" = m."shared_by_user_id"
FROM "meetings" AS m
WHERE p."meeting_id" = m."id"
  AND m."visibility" = 'shared'::"meeting_visibility"
  AND p."status" = 'approved'::"meeting_prep_status";

UPDATE "meeting_debriefs" AS d
SET "shared_at" = m."shared_at",
    "shared_by_user_id" = m."shared_by_user_id"
FROM "meetings" AS m
WHERE d."meeting_id" = m."id"
  AND m."visibility" = 'shared'::"meeting_visibility"
  AND d."status" = 'approved'::"meeting_debrief_status";

-- meeting_notes: no backfill at all. Every existing row stays 'draft' (the
-- new DEFAULT already achieves this) — approval must never be inferred from
-- existence.
--
-- engagement_attachments: no backfill at all. approved_at / approved_by_user_id
-- / shared_at / shared_by_user_id all stay NULL for every existing row.
