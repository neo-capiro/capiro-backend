-- One current editor binding per private draft, across all control instances.
-- This fences editor instances; CODE's opaque WOPI file lock remains separate.
ALTER TABLE meri_office_drafts
  ADD COLUMN editor_id uuid,
  ADD COLUMN editor_epoch integer NOT NULL DEFAULT 0 CHECK (editor_epoch >= 0),
  ADD COLUMN editor_expires_at timestamptz(6),
  ADD CONSTRAINT office_editor_binding CHECK
    ((editor_id IS NULL AND editor_expires_at IS NULL) OR
     (editor_id IS NOT NULL AND editor_expires_at IS NOT NULL AND editor_epoch > 0));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT UPDATE (editor_id,editor_epoch,editor_expires_at) ON meri_office_drafts TO capiro_app;
  END IF;
END $$;
