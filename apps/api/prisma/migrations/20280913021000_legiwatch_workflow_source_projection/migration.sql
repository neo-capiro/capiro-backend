-- Public committed transitions only. Intel owns private subscriptions/checkpoints.
CREATE VIEW legiwatch_workflow_source_event AS
SELECT 'calendar:'||t.id::text AS event_key,'calendar'::text AS kind,t.hearing_id,
 h.geographic_jurisdiction AS jurisdiction,h.legislative_session AS session_key,t.observed_at,
 ARRAY(SELECT DISTINCT a->'bill'->>'id' FROM jsonb_array_elements(
   coalesce(t."before"->'agenda','[]'::jsonb)||coalesce(t."after"->'agenda','[]'::jsonb)) a
   WHERE jsonb_typeof(a->'bill'->'id')='string') AS bill_ids
FROM legislative_calendar_transition t JOIN committee_hearing h ON h.id=t.hearing_id WHERE h.visibility='public'
UNION ALL
SELECT 'published:'||o.id::text||':'||h.id,'published',h.id,h.geographic_jurisdiction,h.legislative_session,o.observed_at,
 ARRAY(SELECT DISTINCT coalesce(a.state_bill_key,a.federal_bill_id) FROM legislative_agenda_item a WHERE a.hearing_id=h.id AND a.active AND coalesce(a.state_bill_key,a.federal_bill_id) IS NOT NULL)
FROM published_record_source_observation o JOIN committee_hearing h ON h.visibility='public' AND (
 EXISTS(SELECT 1 FROM state_bill_published_record r JOIN legislative_agenda_item a ON a.state_bill_key=r.bill_key AND a.active WHERE r.id=o.state_record_id AND a.hearing_id=h.id)
 OR EXISTS(SELECT 1 FROM official_hearing_transcript_event e WHERE e.revision_id=o.official_revision_id AND e.hearing_id=h.id));
GRANT SELECT ON legiwatch_workflow_source_event TO capiro_app;
