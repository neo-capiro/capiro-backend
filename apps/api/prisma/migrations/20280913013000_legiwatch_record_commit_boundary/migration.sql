-- Serialize source commits with reviewed record publication. The delivery
-- transaction holds the shared side until the existing provider attempt ends.
CREATE FUNCTION legiwatch_lock_record_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('legiwatch-published-record-commit-v1',0));
  RETURN NEW;
END $$;
CREATE TRIGGER record_commit_boundary BEFORE INSERT ON state_bill_published_record
FOR EACH STATEMENT EXECUTE FUNCTION legiwatch_lock_record_commit();
CREATE TRIGGER transcript_record_commit_boundary BEFORE INSERT ON official_hearing_transcript_revision
FOR EACH STATEMENT EXECUTE FUNCTION legiwatch_lock_record_commit();
CREATE TRIGGER transcript_event_commit_boundary BEFORE INSERT OR UPDATE OR DELETE ON official_hearing_transcript_event
FOR EACH STATEMENT EXECUTE FUNCTION legiwatch_lock_record_commit();
CREATE TRIGGER calendar_record_commit_boundary BEFORE UPDATE OR DELETE ON committee_hearing
FOR EACH STATEMENT EXECUTE FUNCTION legiwatch_lock_record_commit();
CREATE TRIGGER agenda_record_commit_boundary BEFORE INSERT OR UPDATE OR DELETE ON legislative_agenda_item
FOR EACH STATEMENT EXECUTE FUNCTION legiwatch_lock_record_commit();
