-- API owns the canonical capture. Intel stores an immutable, checked soft reference.
ALTER TABLE intel_live_hearing_session ADD COLUMN public_capture_id text;
CREATE UNIQUE INDEX intel_live_hearing_public_review_actor_key
  ON intel_live_hearing_session(tenant_id,created_by,public_capture_id);
CREATE FUNCTION guard_public_hearing_review_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.public_capture_id IS DISTINCT FROM NEW.public_capture_id THEN
    RAISE EXCEPTION 'Canonical review source is immutable';
  END IF;
  IF NEW.public_capture_id IS NOT NULL THEN
    IF NEW.status IN ('live','paused') OR NEW.recording_policy<>'transcript_only' THEN
      RAISE EXCEPTION 'Canonical review context cannot start another capture';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public_hearing_capture c WHERE c.id=NEW.public_capture_id AND c.hearing_id=NEW.hearing_id) THEN
      RAISE EXCEPTION 'Canonical review hearing mismatch';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER public_hearing_review_context_guard BEFORE INSERT OR UPDATE ON intel_live_hearing_session
FOR EACH ROW EXECUTE FUNCTION guard_public_hearing_review_context();
