-- Immutable derived bill text. Originals and existing citations are untouched.
CREATE TABLE bill_text_extraction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('federal','state')),
  revision_id UUID NOT NULL,
  parser_version TEXT NOT NULL,
  document_hash CHAR(64) NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  text_hash CHAR(64) NOT NULL CHECK (text_hash ~ '^[a-f0-9]{64}$'),
  structure_hash CHAR(64) NOT NULL CHECK (structure_hash ~ '^[a-f0-9]{64}$'),
  extracted_text TEXT NOT NULL,
  structure_jsonb JSONB NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('complete','partial','unreadable','failed')),
  warnings_jsonb JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT bill_text_extraction_snapshot_key UNIQUE(source_kind,revision_id,parser_version,document_hash,structure_hash),
  CONSTRAINT bill_text_extraction_complete_text CHECK (completeness <> 'complete' OR length(trim(extracted_text)) > 0),
  CONSTRAINT bill_text_extraction_json CHECK (jsonb_typeof(structure_jsonb)='object' AND jsonb_typeof(warnings_jsonb)='array')
);
CREATE INDEX bill_text_extraction_revision_idx ON bill_text_extraction(source_kind,revision_id,parser_version,created_at DESC);

-- The polymorphic owner is always an existing public immutable legislative revision.
CREATE FUNCTION bill_text_extraction_validate_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_kind='federal' THEN
    IF NOT EXISTS (SELECT 1 FROM public.federal_evidence_revision r JOIN public.congress_bill b ON b.id=r.bill_id WHERE r.id=NEW.revision_id
       AND r.collection IN ('BILLS','AMENDMENTS','PLAW') AND r.content_hash=NEW.document_hash) THEN
      RAISE EXCEPTION 'BILL_EXTRACTION_OWNER_MISMATCH';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.state_bill_published_record r WHERE r.id=NEW.revision_id
       AND r.kind='document' AND r.evidence->>'contentHash'=NEW.document_hash) THEN
      RAISE EXCEPTION 'BILL_EXTRACTION_OWNER_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bill_text_extraction_owner BEFORE INSERT ON bill_text_extraction
 FOR EACH ROW EXECUTE FUNCTION bill_text_extraction_validate_owner();
CREATE TRIGGER bill_text_extraction_immutable BEFORE UPDATE OR DELETE ON bill_text_extraction
 FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();

-- Bounded passages keep the generated lexeme vector below PostgreSQL's 1MB limit.
-- All nonempty sections, including headings too short for embedding, are stored.
CREATE TABLE bill_text_passage (
 extraction_id UUID NOT NULL REFERENCES bill_text_extraction(id) ON DELETE RESTRICT,
 chunker_version TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
 start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
 end_offset INTEGER NOT NULL,
 content_text TEXT NOT NULL CHECK (length(content_text) BETWEEN 1 AND 7000),
 metadata_jsonb JSONB NOT NULL,
 search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english',content_text)) STORED,
 PRIMARY KEY(extraction_id,chunker_version,ordinal),
 CHECK (end_offset > start_offset AND end_offset-start_offset <= 7000),
 CHECK (jsonb_typeof(metadata_jsonb)='object')
);
CREATE INDEX bill_text_passage_search_idx ON bill_text_passage USING GIN(search_vector);
CREATE TRIGGER bill_text_passage_immutable BEFORE UPDATE OR DELETE ON bill_text_passage
 FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();
GRANT SELECT, INSERT ON bill_text_extraction,bill_text_passage TO capiro_app;
REVOKE UPDATE, DELETE, TRUNCATE ON bill_text_extraction,bill_text_passage FROM capiro_app;

-- Public identical-content embedding reuse stays bounded as bill versions accumulate.
CREATE INDEX context_embeddings_bill_passage_hash_idx ON context_embeddings(model,content_hash)
 WHERE tenant_id IS NULL AND client_id IS NULL AND owner_user_id IS NULL
 AND source_type IN ('bill_passage','state_bill_passage');
