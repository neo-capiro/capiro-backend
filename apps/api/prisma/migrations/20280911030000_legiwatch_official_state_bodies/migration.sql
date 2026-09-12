ALTER TABLE state_committee ADD COLUMN official_source_key text;
ALTER TABLE state_committee ADD COLUMN legislative_session text;
ALTER TABLE state_committee ADD COLUMN source_url text;
ALTER TABLE state_committee ADD COLUMN source_evidence jsonb;
CREATE UNIQUE INDEX state_committee_official_source_key_key ON state_committee(official_source_key);
