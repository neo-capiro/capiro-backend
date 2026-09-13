-- API-owned searchable projection over the existing immutable document owner.
-- No duplicate provider poller, source bytes or private tenant data.
CREATE VIEW legiwatch_keyword_document_source AS
SELECT r.id::text AS document_id,r.bill_key AS bill_id,r.source_identity,
  r.revision_hash,r.event_date,r.evidence->>'documentKind' AS document_kind,
  r.evidence->>'url' AS source_url,r.evidence->>'parserVersion' AS extractor_version,
  r.evidence->>'extractionState' AS extraction_state,r.evidence->>'coverage' AS coverage,
  r.evidence->'sections' AS sections,o.observation_id,o.observed_at
FROM state_bill_published_record r JOIN published_record_source_current o ON o.state_record_id=r.id
WHERE r.kind='document';
GRANT SELECT ON legiwatch_keyword_document_source TO capiro_app;
