-- Client Files: per-file team view access.
-- Default is "all" so existing rows stay visible to every tenant member.
-- 'restricted' + viewer_user_ids limits the Files list (and download) to those
-- users; the uploader always retains access even when not listed.

ALTER TABLE "engagement_attachments"
  ADD COLUMN IF NOT EXISTS "viewer_mode" VARCHAR(16) NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS "viewer_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Guardrail: only the two known modes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'engagement_attachments_viewer_mode_check'
  ) THEN
    ALTER TABLE "engagement_attachments"
      ADD CONSTRAINT engagement_attachments_viewer_mode_check
      CHECK (viewer_mode IN ('all', 'restricted'));
  END IF;
END $$;
