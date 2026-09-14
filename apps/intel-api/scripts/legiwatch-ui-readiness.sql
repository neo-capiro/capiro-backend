-- Read-only diagnosis for the eight-phase live UI repair.
-- Run with the normal application DB role, never an RLS bypass:
-- psql "$DATABASE_URL" -v tenant_id=... -v clerk_user_id=... \
--   -f apps/intel-api/scripts/legiwatch-ui-readiness.sql
-- Supply the verified current tenant and Clerk subject. No credentials are printed.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT set_config('app.current_tenant', :'tenant_id', true);
SELECT set_config('app.folder_actor', :'clerk_user_id', true);
SELECT set_config('app.hearing_actor', :'clerk_user_id', true);

-- The guard now uses this role only when the verified JWT has no role claim.
SELECT m.status::text AS membership_status, m.role::text AS membership_role
FROM users u JOIN tenant_memberships m ON m.user_id=u.id
WHERE u.clerk_user_id=:'clerk_user_id' AND m.tenant_id=:'tenant_id'::uuid;

-- Missing explicit rows are disabled. Display, preparation, and delivery gates
-- are deliberately distinct; this report does not activate any of them.
WITH features(feature) AS (VALUES
 ('legiwatch_folder_tracker_v1'),('legiwatch_reports_updates_v1'),
 ('legiwatch_state_calendar_v1'),('legiwatch_agenda_alerts_v1'),
 ('legiwatch_hearing_recording_v1'),('legiwatch_hearing_updates_v1'),
 ('legiwatch_hearing_recaps_v1'),('legiwatch_published_records_v1'),
 ('legiwatch_record_briefs_v1'),('legiwatch_record_delivery_v1'),
 ('legiwatch_hearing_sms_v1'),('legiwatch_keyword_discovery_v1'),
 ('legiwatch_keyword_auto_add_v1'),('legiwatch_internal_workflows_v1'),
 ('legiwatch_keyword_delivery_v1'),('legiwatch_research_v1'),
 ('legiwatch_news_v1'),('legiwatch_florida_budget_v1'),
 ('legiwatch_editorial_v1'),('legiwatch_report_delivery_v1'))
SELECT features.feature, coalesce(f.enabled,false) AS explicitly_enabled
FROM features LEFT JOIN intel_feature_flag f
 ON f.tenant_id=:'tenant_id' AND f.feature=features.feature
ORDER BY features.feature;

-- Counts are only those accessible to this actor under normal row security.
SELECT f.client_id, count(DISTINCT f.id) AS accessible_folders,
 count(b.id) AS bill_assignments
FROM intel_legiwatch_folder f LEFT JOIN intel_legiwatch_folder_bill b
 ON b.tenant_id=f.tenant_id AND b.folder_id=f.id
WHERE f.tenant_id=:'tenant_id' AND NOT f.archived
GROUP BY f.client_id ORDER BY f.client_id NULLS FIRST;

SELECT source_key,state,version,last_success_at,last_held_reason,
 standing_approval IS NOT NULL AS has_standing_approval
FROM intel_legiwatch_editorial_config
WHERE tenant_id=:'tenant_id' AND owner_clerk_id=:'clerk_user_id'
ORDER BY source_key;

SELECT state,count(*) AS definitions FROM intel_legiwatch_news_monitor
WHERE tenant_id=:'tenant_id' AND owner_clerk_id=:'clerk_user_id' GROUP BY state;

-- No object keys, signed links, transcript text or permission evidence leave
-- the database. A visible transcript does not imply retained-audio permission.
SELECT s.id AS session_id,s.recording_policy,r.state AS recording_state,
 r.expires_at AS retention_expires_at,p.revoked_at AS permission_revoked_at,
 p.expires_at AS permission_expires_at,
 coalesce(p.mode='browser' AND p.source_url=s.source_url
  AND p.hearing_id IS NOT DISTINCT FROM s.hearing_id
  AND p.operations @> ARRAY['capture','transcription','retention']::text[]
  AND p.retention_days BETWEEN 1 AND 90
  AND p.revoked_at IS NULL AND p.expires_at > now(),false) AS permission_row_matches,
 count(e.id) FILTER (WHERE e.state='ready') AS ready_epochs
FROM intel_live_hearing_session s
LEFT JOIN intel_hearing_recording r ON r.tenant_id=s.tenant_id AND r.session_id=s.id
LEFT JOIN intel_hearing_media_permission p ON p.tenant_id=r.tenant_id AND p.id=r.permission_id
LEFT JOIN intel_hearing_recording_epoch e ON e.tenant_id=r.tenant_id AND e.recording_id=r.id
WHERE s.tenant_id=:'tenant_id' AND s.created_by=:'clerk_user_id'
GROUP BY s.id,s.recording_policy,r.state,r.expires_at,p.id,p.revoked_at,p.expires_at
ORDER BY s.id;

SELECT enabled,mode,count(*) AS schedules,
 count(*) FILTER (WHERE enabled AND next_due_at < now()) AS overdue
FROM intel_legiwatch_report_subscription
WHERE tenant_id=:'tenant_id' AND owner_clerk_id=:'clerk_user_id'
GROUP BY enabled,mode;

SELECT count(*) FILTER (WHERE active AND verified AND NOT opted_out) AS eligible_contacts
FROM intel_legiwatch_report_contact
WHERE tenant_id=:'tenant_id' AND owner_clerk_id=:'clerk_user_id';
SELECT count(*) AS active_lists FROM intel_legiwatch_report_list
WHERE tenant_id=:'tenant_id' AND owner_clerk_id=:'clerk_user_id' AND active;

ROLLBACK;
