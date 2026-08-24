-- Advocacy Matter rehearsal: proves RLS isolation, uniqueness, and cascade
-- behavior for the new tables against a live disposable Postgres. Mirrors
-- the exact SQL shapes ClientAdvocacyMatterService issues.

BEGIN;

INSERT INTO tenants (id, slug, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'tenant-a', 'Tenant A'),
  ('22222222-2222-2222-2222-222222222222', 'tenant-b', 'Tenant B')
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (id, tenant_id, name) VALUES
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Overland AI'),
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'Other Tenant Client')
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- 1. As tenant A: create a Matter for PE 0605053A, insert a durable advocacy
--    record, assign it to the matter (the exact UPDATE the service issues).
SET SESSION AUTHORIZATION capiro_app;
BEGIN;
SELECT set_config('app.current_tenant', '11111111-1111-1111-1111-111111111111', true);

INSERT INTO client_advocacy_matter (tenant_id, client_id, title, matter_type, external_key, primary_pe_code)
VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
        '0605053A Program Element', 'program_element', 'pe:0605053A', '0605053A')
ON CONFLICT (tenant_id, client_id, external_key) DO NOTHING;

INSERT INTO client_advocacy_record
  (tenant_id, client_id, record_type, title, source_type, evidence_class, confidence, external_key)
VALUES
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
   'client_submission', 'FY27 ground robotics funding ask', 'client_submission', 'CLIENT_VERIFIED', 1,
   'client-submission:test-1')
ON CONFLICT (tenant_id, client_id, external_key) DO NOTHING;

UPDATE client_advocacy_record
   SET matter_id = (SELECT id FROM client_advocacy_matter WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND external_key = 'pe:0605053A')
 WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND external_key = 'client-submission:test-1';

-- 2. Idempotent re-run: ON CONFLICT DO NOTHING must not create a duplicate Matter.
INSERT INTO client_advocacy_matter (tenant_id, client_id, title, matter_type, external_key, primary_pe_code)
VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
        '0605053A Program Element (re-run)', 'program_element', 'pe:0605053A', '0605053A')
ON CONFLICT (tenant_id, client_id, external_key) DO UPDATE SET updated_at = now();

DO $$
DECLARE
  matter_count int;
BEGIN
  SELECT count(*) INTO matter_count FROM client_advocacy_matter
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND external_key = 'pe:0605053A';
  IF matter_count <> 1 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: expected exactly 1 matter for pe:0605053A, found %', matter_count;
  END IF;
  RAISE NOTICE 'PASS: idempotent matter upsert (count=%)', matter_count;
END $$;

-- 3. Link a bill and an outcome event into the matter.
INSERT INTO client_advocacy_matter_link (tenant_id, matter_id, link_type, link_key, label)
SELECT '11111111-1111-1111-1111-111111111111', id, 'bill', '119-hr-1234', 'NDAA autonomous systems language'
  FROM client_advocacy_matter WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND external_key = 'pe:0605053A'
ON CONFLICT (matter_id, link_type, link_key) DO NOTHING;

INSERT INTO client_advocacy_matter_link (tenant_id, matter_id, link_type, link_key, label, metadata_jsonb)
SELECT '11111111-1111-1111-1111-111111111111', id, 'outcome_event', 'outcome-uuid-1', 'Observed outcome: funding_changed', '{"causationClaimed": false}'::jsonb
  FROM client_advocacy_matter WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND external_key = 'pe:0605053A'
ON CONFLICT (matter_id, link_type, link_key) DO NOTHING;

DO $$
DECLARE
  link_count int;
  record_count int;
BEGIN
  SELECT count(*) INTO link_count FROM client_advocacy_matter_link lk
    JOIN client_advocacy_matter m ON m.id = lk.matter_id
   WHERE m.external_key = 'pe:0605053A';
  SELECT count(*) INTO record_count FROM client_advocacy_record r
    JOIN client_advocacy_matter m ON m.id = r.matter_id
   WHERE m.external_key = 'pe:0605053A';
  IF link_count <> 2 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: expected 2 links, found %', link_count;
  END IF;
  IF record_count <> 1 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: expected 1 linked record, found %', record_count;
  END IF;
  RAISE NOTICE 'PASS: matter groups the bill link, outcome link, and advocacy record together (links=%, records=%)', link_count, record_count;
END $$;

-- 4. RLS isolation: switch to tenant B and confirm tenant A's matter/links/
--    records are invisible even though the same physical rows exist.
SELECT set_config('app.current_tenant', '22222222-2222-2222-2222-222222222222', true);

DO $$
DECLARE
  visible_matters int;
  visible_records int;
  visible_links int;
BEGIN
  SELECT count(*) INTO visible_matters FROM client_advocacy_matter;
  SELECT count(*) INTO visible_records FROM client_advocacy_record;
  SELECT count(*) INTO visible_links FROM client_advocacy_matter_link;
  IF visible_matters <> 0 OR visible_records <> 0 OR visible_links <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: RLS leak — tenant B saw matters=%, records=%, links=%', visible_matters, visible_records, visible_links;
  END IF;
  RAISE NOTICE 'PASS: RLS isolates tenant B from tenant A''s matters/records/links';
END $$;

-- 5. Cascade: deleting the Matter must SET NULL the record's matter_id (not
--    cascade-delete the record — the advocacy record survives independent
--    of Matter grouping) and CASCADE-delete the links.
SELECT set_config('app.current_tenant', '11111111-1111-1111-1111-111111111111', true);

DELETE FROM client_advocacy_matter
 WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND external_key = 'pe:0605053A';

DO $$
DECLARE
  remaining_record_matter_id uuid;
  remaining_links int;
BEGIN
  SELECT matter_id INTO remaining_record_matter_id FROM client_advocacy_record
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND external_key = 'client-submission:test-1';
  SELECT count(*) INTO remaining_links FROM client_advocacy_matter_link WHERE tenant_id = '11111111-1111-1111-1111-111111111111';
  IF remaining_record_matter_id IS NOT NULL THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: expected matter_id SET NULL after matter delete, got %', remaining_record_matter_id;
  END IF;
  IF remaining_links <> 0 THEN
    RAISE EXCEPTION 'REHEARSAL FAILED: expected matter_link rows to CASCADE delete, found %', remaining_links;
  END IF;
  RAISE NOTICE 'PASS: deleting a matter SETs NULL the record link and CASCADEs the matter_link rows';
END $$;

ROLLBACK;
RESET SESSION AUTHORIZATION;
