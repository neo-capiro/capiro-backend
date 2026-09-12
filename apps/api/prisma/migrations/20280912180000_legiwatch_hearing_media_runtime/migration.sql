-- New media maintenance shares the existing runtime registry and starts dark.
ALTER TABLE legiwatch_runtime_heartbeat DROP CONSTRAINT legiwatch_runtime_heartbeat_type_check;
ALTER TABLE legiwatch_runtime_heartbeat ADD CONSTRAINT legiwatch_runtime_heartbeat_type_check CHECK (
  job_type IN ('central_discovery','committee_enrichment','committee_updates','source_probe','coverage_audit',
    'stream_preflight','capture_worker','archive_reconciliation','intelligence_worker','relevance_worker',
    'parallel_comparison','metrics','hearing_media_worker')
);
INSERT INTO legiwatch_runtime_heartbeat(job_key,job_type,status,enabled,schedule_enabled,expected_interval_seconds,max_lag_seconds,metrics)
VALUES ('hearing-media-worker','hearing_media_worker','disabled',false,false,60,300,'{}'::jsonb)
ON CONFLICT(job_key) DO NOTHING;
