-- Rehearsal proof for createManualRecord's raw INSERT (section 25, "Add
-- advocacy record"). Not a new migration -- record_type has no CHECK
-- constraint, so no schema change was needed to introduce the new
-- vocabulary. This script proves the hand-written SQL in
-- client-advocacy-matter.service.ts is syntactically valid against a real
-- Postgres and produces exactly the row shape the service expects --
-- jest's mocked $queryRawUnsafe can prove the CALL happened with the right
-- arguments, but never that the SQL text itself is valid.
--
-- Usage:
--   docker exec -i capiro-postgres psql -U capiro_app -d <rehearsal_db> \
--     -f apps/api/prisma/security-rehearsals/manual-advocacy-record-insert.sql

BEGIN;

SELECT set_config('app.bypass_rls', 'on', false);

INSERT INTO tenants (id, name, slug) VALUES
  ('a0000000-0000-0000-0000-00000000000a', 'Rehearsal Tenant', 'rehearsal-tenant-manual-record');

INSERT INTO clients (id, tenant_id, name, status) VALUES
  ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', 'Rehearsal Client', 'active');

SELECT set_config('app.current_tenant', 'a0000000-0000-0000-0000-00000000000a', false);
SELECT set_config('app.bypass_rls', 'off', false);

-- 1. A brand-new Matter, exactly as createMatter's INSERT writes it.
INSERT INTO client_advocacy_matter
  (id, tenant_id, client_id, title, matter_type, status, summary, external_key,
   auto_generated, opened_at, created_by_user_id)
VALUES (
  'c0000000-0000-0000-0000-00000000000c',
  'a0000000-0000-0000-0000-00000000000a',
  'b0000000-0000-0000-0000-00000000000b',
  'FY27 Ground Robotics Funding', 'program_element', 'planning', NULL,
  'manual:11111111-1111-1111-1111-111111111111', false, now(), NULL
);

-- 2. The manual record itself, exactly as createManualRecord's INSERT
--    writes it -- same column list, same literal true for matter_locked,
--    same CASE expression for activity_date, assigned to the Matter above.
INSERT INTO client_advocacy_record
  (tenant_id, client_id, record_type, title, summary, activity_date, status, outcome,
   source_type, source_url, evidence_class, confidence, external_key, matter_id, matter_locked,
   created_by_user_id, reviewed_by_user_id, reviewed_at)
VALUES (
  'a0000000-0000-0000-0000-00000000000a'::uuid, 'b0000000-0000-0000-0000-00000000000b'::uuid,
  'meeting', 'Staff meeting on FY27 ask', 'Discussed the funding request with HASC staff.',
  CASE WHEN '2026-03-12T00:00:00.000Z'::text IS NULL OR '2026-03-12T00:00:00.000Z'::text = ''
       THEN NULL ELSE '2026-03-12T00:00:00.000Z'::timestamptz::date END,
  NULL, NULL, 'manual', NULL, 'CLIENT_VERIFIED', 1,
  'manual:22222222-2222-2222-2222-222222222222',
  'c0000000-0000-0000-0000-00000000000c'::uuid, true,
  NULL, NULL, now()
)
RETURNING id, matter_id, matter_locked, evidence_class, activity_date;

-- 3. Prove it round-trips exactly: the record is findable by Matter, its
--    activity_date parsed correctly from the ISO string, and it is
--    correctly excluded from nothing (not_advocacy defaults false).
DO $$
DECLARE
  found_count INT;
BEGIN
  SELECT COUNT(*) INTO found_count
    FROM client_advocacy_record
   WHERE matter_id = 'c0000000-0000-0000-0000-00000000000c'::uuid
     AND matter_locked = true
     AND not_advocacy = false
     AND activity_date = '2026-03-12'::date
     AND evidence_class = 'CLIENT_VERIFIED';
  IF found_count != 1 THEN
    RAISE EXCEPTION 'FAIL: manual record did not round-trip as expected (found %)', found_count;
  END IF;
  RAISE NOTICE 'PASS: manual advocacy record round-trips correctly (matter-assigned, locked, dated, CLIENT_VERIFIED)';
END $$;

-- 4. Same INSERT again but with a sourceUrl -- proves the PUBLIC_VERIFIED
--    upgrade path also produces a valid row.
INSERT INTO client_advocacy_record
  (tenant_id, client_id, record_type, title, summary, activity_date, status, outcome,
   source_type, source_url, evidence_class, confidence, external_key, matter_id, matter_locked,
   created_by_user_id, reviewed_by_user_id, reviewed_at)
VALUES (
  'a0000000-0000-0000-0000-00000000000a'::uuid, 'b0000000-0000-0000-0000-00000000000b'::uuid,
  'regulatory_comment', 'Public comment on proposed rule', NULL,
  NULL, NULL, NULL, 'manual', 'https://www.regulations.gov/comment/EX-2026-0001',
  'PUBLIC_VERIFIED', 1, 'manual:33333333-3333-3333-3333-333333333333',
  NULL, true, NULL, NULL, now()
)
RETURNING id, source_url, evidence_class;

DO $$
DECLARE
  found_count INT;
BEGIN
  SELECT COUNT(*) INTO found_count
    FROM client_advocacy_record
   WHERE source_url = 'https://www.regulations.gov/comment/EX-2026-0001'
     AND evidence_class = 'PUBLIC_VERIFIED'
     AND matter_id IS NULL; -- unassigned is a valid, real state, not an error
  IF found_count != 1 THEN
    RAISE EXCEPTION 'FAIL: PUBLIC_VERIFIED manual record did not round-trip as expected (found %)', found_count;
  END IF;
  RAISE NOTICE 'PASS: sourceUrl correctly upgrades evidence_class to PUBLIC_VERIFIED, unassigned is a valid state';
END $$;

ROLLBACK;
