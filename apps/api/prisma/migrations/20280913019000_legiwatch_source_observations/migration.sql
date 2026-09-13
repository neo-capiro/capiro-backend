-- Content revisions deduplicate exact bytes. A separate immutable observation
-- records transitions back to an earlier revision without rewriting history.
CREATE TABLE published_record_source_observation (
  id BIGSERIAL PRIMARY KEY,
  source_key TEXT NOT NULL,
  state_record_id UUID REFERENCES state_bill_published_record(id) ON DELETE RESTRICT,
  official_revision_id UUID REFERENCES official_hearing_transcript_revision(id) ON DELETE RESTRICT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state_record_id IS NULL) <> (official_revision_id IS NULL))
);
CREATE INDEX published_record_source_observation_latest ON published_record_source_observation(source_key,id DESC);
INSERT INTO published_record_source_observation(source_key,state_record_id,observed_at)
SELECT 'state:'||r.bill_key||':'||r.kind||':'||r.source_identity,r.id,r.first_observed_at
FROM (SELECT DISTINCT ON(r.bill_key,r.kind,r.source_identity) r.* FROM state_bill_published_record r
  LEFT JOIN state_roll_call_vote v ON r.kind='vote' AND v.id=r.source_identity
  ORDER BY r.bill_key,r.kind,r.source_identity,(r.revision_hash=v.current_revision_hash) DESC NULLS LAST,r.first_observed_at DESC,r.id DESC) r;
INSERT INTO published_record_source_observation(source_key,official_revision_id,observed_at)
SELECT 'govinfo:'||r.package_id,r.id,r.observed_at FROM (SELECT DISTINCT ON(r.package_id) r.*
  FROM official_hearing_transcript_revision r JOIN official_hearing_transcript p ON p.id=r.package_id
  ORDER BY r.package_id,(r.extracted_text=p.text AND r.source_url=p.source_url) DESC,r.observed_at DESC,r.id DESC) r;
CREATE TRIGGER published_record_observation_commit_boundary BEFORE INSERT ON published_record_source_observation
FOR EACH STATEMENT EXECUTE FUNCTION legiwatch_lock_record_commit();
CREATE TRIGGER published_record_observation_immutable BEFORE UPDATE OR DELETE ON published_record_source_observation
FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();
GRANT SELECT,INSERT ON published_record_source_observation TO capiro_app;
GRANT USAGE,SELECT ON SEQUENCE published_record_source_observation_id_seq TO capiro_app;
REVOKE UPDATE,DELETE,TRUNCATE ON published_record_source_observation FROM capiro_app;
CREATE VIEW published_record_source_current AS SELECT DISTINCT ON(source_key)
  source_key,id::text AS observation_id,state_record_id,official_revision_id,observed_at
  FROM published_record_source_observation ORDER BY source_key,id DESC;
GRANT SELECT ON published_record_source_current TO capiro_app;
