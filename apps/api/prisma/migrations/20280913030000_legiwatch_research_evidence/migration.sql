-- API owns public evidence. No private folder/client/recipient data is stored here.
ALTER TABLE state_rule ALTER COLUMN publication_date DROP NOT NULL;
ALTER TABLE state_rule ADD COLUMN filing_date date;
ALTER TABLE state_rule ADD COLUMN linked_rule_numbers text[] NOT NULL DEFAULT '{}';
ALTER TABLE state_rule ADD COLUMN source_revision text;

CREATE TABLE legal_reference (
 id text PRIMARY KEY, jurisdiction text NOT NULL, code_kind text NOT NULL CHECK(code_kind IN ('statute','constitution','administrative_rule')),
 reference_kind text NOT NULL CHECK(reference_kind IN ('chapter','section','subsection','article','rule')),
 chapter text, section text, subdivisions jsonb NOT NULL DEFAULT '[]', identity jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legal_text_revision (
 id text PRIMARY KEY, reference_id text NOT NULL REFERENCES legal_reference(id), edition text,
 source_url text NOT NULL, content_hash text NOT NULL, extraction_hash text NOT NULL, parser_version text NOT NULL,
 title text NOT NULL, sections jsonb NOT NULL, original_html text, original_bytes_base64 text,
 source_dates jsonb NOT NULL DEFAULT '[]', history_text text, complete boolean NOT NULL,
 coverage jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reference_id,edition,content_hash,extraction_hash)
);
CREATE INDEX legal_revision_reference ON legal_text_revision(reference_id,edition,observed_at);
CREATE TABLE legal_source_receipt (
 id text PRIMARY KEY, source text NOT NULL, scope jsonb NOT NULL, manifest jsonb NOT NULL,
 complete boolean NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE legal_dataset_archive (
 content_hash text PRIMARY KEY CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 original_bytes_base64 text NOT NULL CHECK(length(original_bytes_base64)<=160000000),
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rule_notice_revision (
 id text PRIMARY KEY, notice_id text NOT NULL REFERENCES state_rule(id), source_url text NOT NULL,
 content_hash text NOT NULL, parser_version text NOT NULL, payload jsonb NOT NULL,
 original_html text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(notice_id,content_hash,parser_version)
);
CREATE TABLE rule_notice_reference (
 revision_id text NOT NULL REFERENCES rule_notice_revision(id), reference_id text NOT NULL REFERENCES legal_reference(id),
 source_url text NOT NULL, relation text NOT NULL DEFAULT 'linked' CHECK(relation IN ('linked','proposes_amend','proposes_repeal','adopted','withdrawn','corrected')),
 PRIMARY KEY(revision_id,reference_id)
);
CREATE TABLE legal_published_date (
 id text PRIMARY KEY, notice_revision_id text REFERENCES rule_notice_revision(id), legal_revision_id text REFERENCES legal_text_revision(id),
 kind text NOT NULL, raw_wording text NOT NULL, date_only date, instant timestamptz, timezone text,
 precision text NOT NULL CHECK(precision IN ('date','instant','conditional')), basis text NOT NULL CHECK(basis IN ('explicit','conditional')),
 source_locator text NOT NULL, provision_scope text, supersedes_id text REFERENCES legal_published_date(id), canceled boolean NOT NULL DEFAULT false,
 CHECK(num_nonnulls(notice_revision_id,legal_revision_id)=1), CHECK(NOT(date_only IS NOT NULL AND instant IS NOT NULL))
);
CREATE INDEX legal_date_calendar ON legal_published_date(date_only);
CREATE TABLE legislative_legal_occurrence (
 id text PRIMARY KEY, document_id text NOT NULL, bill_id text NOT NULL, jurisdiction text NOT NULL, session_key text NOT NULL,
 document_revision text NOT NULL, reference_id text NOT NULL REFERENCES legal_reference(id),
 locator text NOT NULL, start_offset integer NOT NULL, end_offset integer NOT NULL, quote text NOT NULL,
 relation text NOT NULL CHECK(relation IN ('cites','proposes_amend','proposes_repeal','proposes_create','proposes_renumber','reenacts','unresolved')),
 basis text NOT NULL, parser_version text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(),
 CHECK(start_offset>=0 AND end_offset>start_offset)
);
CREATE INDEX legal_occurrence_lookup ON legislative_legal_occurrence(reference_id,jurisdiction,session_key,bill_id);
-- All retained revisions, including superseded extractions; currentness is a
-- separate field. No filename/source-order guessing establishes version sequence.
CREATE VIEW legiwatch_research_document_source AS
SELECT r.id::text AS document_id,r.bill_key AS bill_id,b.state AS jurisdiction,b.session_key,
 b.identifier AS bill_identifier,b.title AS bill_title,b.sponsor_name AS bill_sponsor,b.chamber AS bill_chamber,b.legiscan_status AS bill_status,b.latest_action_text,
 r.source_identity,r.revision_hash,r.event_date,r.evidence->>'documentKind' AS document_kind,
 r.evidence->>'providerId' AS provider_id,r.evidence->>'providerHash' AS provider_hash,
 r.evidence->>'versionType' AS version_type,
 r.evidence->>'title' AS title,r.evidence->>'url' AS source_url,r.evidence->>'contentHash' AS content_hash,
 r.evidence->>'parserVersion' AS extractor_version,r.evidence->>'extractionState' AS extraction_state,
 r.evidence->>'coverage' AS coverage,r.evidence->'sections' AS sections,
 r.first_observed_at AS observed_at, EXISTS(SELECT 1 FROM published_record_source_current o WHERE o.state_record_id=r.id) AS is_current
FROM state_bill_published_record r JOIN state_bill b ON b.id=r.bill_key WHERE r.kind='document';
GRANT SELECT ON legiwatch_research_document_source TO capiro_app;
CREATE FUNCTION legal_research_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'LEGAL_RESEARCH_IMMUTABLE'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['legal_reference','legal_text_revision','legal_source_receipt','legal_dataset_archive','rule_notice_revision','rule_notice_reference','legal_published_date','legislative_legal_occurrence'] LOOP
  EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',t);
  EXECUTE format('CREATE TRIGGER legal_research_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION legal_research_immutable()',t);
 END LOOP;
END $$;
