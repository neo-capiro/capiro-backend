ALTER TABLE intel_transcript_segment
  ADD COLUMN analysis_state text NOT NULL DEFAULT 'untracked',
  ADD COLUMN analysis_actor text,
  ADD COLUMN analysis_token text,
  ADD COLUMN analysis_lease_until timestamptz,
  ADD COLUMN analysis_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN analysis_next_attempt timestamptz,
  ADD CONSTRAINT intel_transcript_analysis_state_check CHECK (analysis_state IN ('untracked','pending','processing','ready','failed'));
CREATE INDEX intel_transcript_analysis_due_idx ON intel_transcript_segment(analysis_next_attempt, created_at)
  WHERE analysis_state IN ('pending','processing');

-- Storage enforcement is independent of the caller's policy argument.
CREATE FUNCTION hearing_transcript_storage_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM intel_live_hearing_session s WHERE s.tenant_id=NEW.tenant_id
    AND s.id=NEW.session_id AND s.recording_policy <> 'no_storage') THEN
    RAISE EXCEPTION 'Transcript persistence is unavailable for this session';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hearing_transcript_storage BEFORE INSERT OR UPDATE ON intel_transcript_segment
  FOR EACH ROW EXECUTE FUNCTION hearing_transcript_storage_check();
