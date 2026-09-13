CREATE TABLE official_hearing_transcript_revision (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), package_id TEXT NOT NULL REFERENCES official_hearing_transcript(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL, extraction_hash TEXT NOT NULL, parser_version TEXT NOT NULL,
  source_url TEXT NOT NULL, source_modified_at TEXT, published_date TEXT, observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_content TEXT NOT NULL, extracted_text TEXT NOT NULL, metadata JSONB NOT NULL,
  UNIQUE(package_id,content_hash,extraction_hash,parser_version)
);
CREATE TABLE official_hearing_transcript_event (
  revision_id UUID NOT NULL REFERENCES official_hearing_transcript_revision(id) ON DELETE RESTRICT,
  hearing_id TEXT NOT NULL REFERENCES committee_hearing(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK(method IN ('explicit_source_url','qualified_body_held_date')),
  held_date TEXT, PRIMARY KEY(revision_id,hearing_id)
);
CREATE TRIGGER official_transcript_no_update BEFORE UPDATE ON official_hearing_transcript_revision
  FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();
GRANT SELECT,INSERT ON official_hearing_transcript_revision,official_hearing_transcript_event TO capiro_app;
REVOKE UPDATE,DELETE,TRUNCATE ON official_hearing_transcript_revision,official_hearing_transcript_event FROM capiro_app;
