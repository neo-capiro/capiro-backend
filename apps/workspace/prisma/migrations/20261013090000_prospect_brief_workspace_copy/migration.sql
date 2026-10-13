-- SOURCE ONLY. Do not execute in this task. Existing owners/tables/privileges retained.
ALTER TABLE ws_document ADD COLUMN source_brief_version jsonb;

ALTER TABLE ws_document ADD CONSTRAINT ws_document_brief_source_shape CHECK (
  source_brief_version IS NULL OR (
    jsonb_typeof(source_brief_version) = 'object'
    AND source_brief_version ?& ARRAY['kind','prospectId','briefId','versionId','versionNumber','sectionsHash','snapshotHash']
    AND source_brief_version - ARRAY['kind','prospectId','briefId','versionId','versionNumber','sectionsHash','snapshotHash'] = '{}'::jsonb
    AND source_brief_version->>'kind' = 'core_prospect_brief_version'
    AND source_brief_version->>'prospectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND source_brief_version->>'briefId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND source_brief_version->>'versionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(source_brief_version->'versionNumber') = 'number'
    AND source_brief_version->>'versionNumber' ~ '^([1-9]|[1-9][0-9]|100)$'
    AND source_brief_version->>'sectionsHash' ~ '^[0-9a-f]{64}$'
    AND source_brief_version->>'snapshotHash' ~ '^[0-9a-f]{64}$'
  ) IS TRUE
);

CREATE FUNCTION ws_document_brief_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_brief_version IS DISTINCT FROM OLD.source_brief_version
     OR (OLD.source_brief_version IS NOT NULL AND
         (NEW.id,NEW.tenant_id,NEW.draft_id) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.draft_id)) THEN
    RAISE EXCEPTION 'Workspace brief copy origin is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ws_document_brief_source_immutable
BEFORE UPDATE ON ws_document FOR EACH ROW EXECUTE FUNCTION ws_document_brief_source_immutable();

CREATE FUNCTION ws_document_brief_source_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_brief_version IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ws_draft d WHERE d.id=NEW.draft_id AND d.tenant_id=NEW.tenant_id
      AND d.prospect_id::text=NEW.source_brief_version->>'prospectId'
  ) THEN
    RAISE EXCEPTION 'Workspace brief copy requires its exact prospect draft origin';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ws_document_brief_source_origin
BEFORE INSERT ON ws_document FOR EACH ROW EXECUTE FUNCTION ws_document_brief_source_origin();
