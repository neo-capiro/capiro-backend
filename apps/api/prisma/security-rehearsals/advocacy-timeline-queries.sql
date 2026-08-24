-- Rehearsal proof for getTimeline's two raw SELECT queries (product spec
-- section 18/19). Not a new migration -- proves the hand-written SQL in
-- client-advocacy-matter.service.ts is syntactically valid against a real
-- Postgres, including the LEFT JOIN (records, unassigned allowed) and the
-- INNER JOIN (links, always Matter-scoped) it depends on.
--
-- Usage:
--   docker exec -i capiro-postgres psql -U capiro_app -d <rehearsal_db> \
--     -f apps/api/prisma/security-rehearsals/advocacy-timeline-queries.sql

BEGIN;

SELECT set_config('app.bypass_rls', 'on', false);

INSERT INTO tenants (id, name, slug) VALUES
  ('a0000000-0000-0000-0000-00000000000a', 'Rehearsal Tenant', 'rehearsal-tenant-timeline');

INSERT INTO clients (id, tenant_id, name, status) VALUES
  ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', 'Rehearsal Client', 'active');

SELECT set_config('app.current_tenant', 'a0000000-0000-0000-0000-00000000000a', false);
SELECT set_config('app.bypass_rls', 'off', false);

INSERT INTO client_advocacy_matter
  (id, tenant_id, client_id, title, matter_type, status, external_key, auto_generated, opened_at, created_by_user_id)
VALUES (
  'c0000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000a',
  'b0000000-0000-0000-0000-00000000000b', 'FY27 Ground Robotics Funding', 'program_element', 'active',
  'manual:11111111-1111-1111-1111-111111111111', false, now(), NULL
);

-- A Matter-assigned record.
INSERT INTO client_advocacy_record
  (tenant_id, client_id, record_type, title, activity_date, source_type, evidence_class, confidence,
   external_key, matter_id, matter_locked)
VALUES (
  'a0000000-0000-0000-0000-00000000000a', 'b0000000-0000-0000-0000-00000000000b',
  'client_submission', 'FY27 ask submission', '2026-02-01', 'client_submission', 'CLIENT_VERIFIED', 1,
  'manual:22222222-2222-2222-2222-222222222222', 'c0000000-0000-0000-0000-00000000000c', true
);

-- A genuinely unassigned record -- must still be returned by the LEFT JOIN.
INSERT INTO client_advocacy_record
  (tenant_id, client_id, record_type, title, activity_date, source_type, evidence_class, confidence, external_key)
VALUES (
  'a0000000-0000-0000-0000-00000000000a', 'b0000000-0000-0000-0000-00000000000b',
  'client_submission', 'Unassigned candidate', '2026-01-05', 'client_submission', 'CLIENT_VERIFIED', 1,
  'manual:33333333-3333-3333-3333-333333333333'
);

-- A dated meeting link on the Matter.
INSERT INTO client_advocacy_matter_link
  (tenant_id, matter_id, link_type, link_key, label, evidence_class, metadata_jsonb)
VALUES (
  'a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c',
  'meeting', 'meeting-1', 'HASC staff meeting', 'PRIVATE_ACTIVITY',
  '{"occurredAt": "2026-03-12T00:00:00.000Z"}'::jsonb
);

-- An undated Strategy link -- must be excluded by getTimeline's own
-- application-level occurredAt filter, not by this query (the raw SQL
-- returns it; the service layer is what drops it).
INSERT INTO client_advocacy_matter_link
  (tenant_id, matter_id, link_type, link_key, label, relationship_type, metadata_jsonb)
VALUES (
  'a0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000c',
  'strategy', 'strategy-1', 'FY27 objective', 'planned_action',
  '{"strategyId": "strategy-1", "causationClaimed": false}'::jsonb
);

-- The exact record query from getTimeline.
SELECT r.id, r.record_type AS "recordType", r.title, r.activity_date AS "activityDate",
       r.evidence_class AS "evidenceClass", r.confidence,
       r.matter_id AS "matterId", m.title AS "matterTitle"
  FROM client_advocacy_record r
  LEFT JOIN client_advocacy_matter m ON m.id = r.matter_id AND m.tenant_id = r.tenant_id
 WHERE r.tenant_id = 'a0000000-0000-0000-0000-00000000000a'::uuid
   AND r.client_id = 'b0000000-0000-0000-0000-00000000000b'::uuid
   AND r.not_advocacy = false
 ORDER BY r.activity_date DESC NULLS LAST, r.created_at DESC
 LIMIT 500;

-- The exact link query from getTimeline.
SELECT l.id, l.link_type AS "linkType", l.label, l.link_key AS "linkKey",
       l.evidence_class AS "evidenceClass", l.confidence, l.metadata_jsonb AS metadata,
       l.matter_id AS "matterId", m.title AS "matterTitle"
  FROM client_advocacy_matter_link l
  JOIN client_advocacy_matter m ON m.id = l.matter_id AND m.tenant_id = l.tenant_id
 WHERE l.tenant_id = 'a0000000-0000-0000-0000-00000000000a'::uuid
   AND m.client_id = 'b0000000-0000-0000-0000-00000000000b'::uuid
 ORDER BY l.created_at DESC
 LIMIT 500;

DO $$
DECLARE
  record_count INT;
  unassigned_count INT;
  link_count INT;
BEGIN
  SELECT COUNT(*) INTO record_count FROM client_advocacy_record
   WHERE client_id = 'b0000000-0000-0000-0000-00000000000b'::uuid AND not_advocacy = false;
  SELECT COUNT(*) INTO unassigned_count FROM client_advocacy_record
   WHERE client_id = 'b0000000-0000-0000-0000-00000000000b'::uuid AND matter_id IS NULL;
  SELECT COUNT(*) INTO link_count FROM client_advocacy_matter_link l
   JOIN client_advocacy_matter m ON m.id = l.matter_id
   WHERE m.client_id = 'b0000000-0000-0000-0000-00000000000b'::uuid;
  IF record_count != 2 OR unassigned_count != 1 OR link_count != 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 records (1 unassigned) and 2 links, got % records (% unassigned), % links',
      record_count, unassigned_count, link_count;
  END IF;
  RAISE NOTICE 'PASS: both getTimeline queries return the expected rows (2 records incl. 1 unassigned, 2 links) against real Postgres';
END $$;

ROLLBACK;
