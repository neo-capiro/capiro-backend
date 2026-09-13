-- Generic immutable generated-document provenance, written before indexing.
ALTER TABLE engagement_attachments
  ADD COLUMN source_version integer,
  ADD COLUMN source_content_hash varchar(64),
  ADD CONSTRAINT attachment_source_version CHECK(source_version IS NULL OR source_version>0),
  ADD CONSTRAINT attachment_source_hash CHECK(source_content_hash IS NULL OR source_content_hash ~ '^[0-9a-f]{64}$');
CREATE FUNCTION protect_generated_document_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source_content_hash IS NOT NULL AND
    (NEW.source_content_hash IS DISTINCT FROM OLD.source_content_hash OR NEW.source_version IS DISTINCT FROM OLD.source_version
     OR NEW.source_entity_type IS DISTINCT FROM OLD.source_entity_type OR NEW.source_entity_id IS DISTINCT FROM OLD.source_entity_id) THEN
    RAISE EXCEPTION 'Approved document provenance is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_generated_document_provenance BEFORE UPDATE ON engagement_attachments
  FOR EACH ROW EXECUTE FUNCTION protect_generated_document_provenance();
