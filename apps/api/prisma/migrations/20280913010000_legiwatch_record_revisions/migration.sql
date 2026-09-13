-- API-owned public evidence. Existing observations are preserved verbatim.
ALTER TABLE state_bill_published_record DROP CONSTRAINT published_record_kind;
ALTER TABLE state_bill_published_record ADD CONSTRAINT published_record_kind
  CHECK (kind IN ('action','amendment','vote','document'));
ALTER TABLE state_roll_call_vote ADD COLUMN current_revision_hash TEXT,
  ADD COLUMN provider_bill_hash TEXT, ALTER COLUMN date DROP NOT NULL;

-- Broad owner default ACLs must not grant application evidence rewrite rights.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE UPDATE,DELETE,TRUNCATE ON state_bill_published_record FROM capiro_app;
    GRANT SELECT,INSERT ON state_bill_published_record TO capiro_app;
  END IF;
END $$;
CREATE FUNCTION legiwatch_reject_record_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PUBLISHED_RECORD_IMMUTABLE'; END $$;
CREATE TRIGGER legiwatch_record_no_update BEFORE UPDATE ON state_bill_published_record
  FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();
