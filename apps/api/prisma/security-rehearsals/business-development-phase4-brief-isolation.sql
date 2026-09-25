-- Business Development Phase 4 brief/version isolation rehearsal.
--
-- Run against a disposable database with every Prisma migration applied.
-- Fixture setup uses the database owner. Every application-role proof runs as
-- non-superuser/non-BYPASSRLS capiro_app. The transaction always rolls back.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO tenants (id, name, slug)
VALUES
  ('da000000-0000-0000-0000-000000000001', 'BizDev Phase 4 A', 'bizdev-phase4-a'),
  ('db000000-0000-0000-0000-000000000002', 'BizDev Phase 4 B', 'bizdev-phase4-b')
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_development_prospects (
  id, tenant_id, display_name, stage, status, conflict_excluded, watch_requested
)
VALUES
  (
    'da100000-0000-0000-0000-000000000001',
    'da000000-0000-0000-0000-000000000001',
    'Tenant A Private Prospect', 'qualified', 'active', false, false
  ),
  (
    'db100000-0000-0000-0000-000000000002',
    'db000000-0000-0000-0000-000000000002',
    'Tenant B Private Prospect', 'researching', 'active', false, false
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_development_briefs (
  id, tenant_id, prospect_id, title, status
)
VALUES
  (
    'da200000-0000-0000-0000-000000000001',
    'da000000-0000-0000-0000-000000000001',
    'da100000-0000-0000-0000-000000000001',
    'Tenant A Private Brief', 'draft'
  ),
  (
    'db200000-0000-0000-0000-000000000002',
    'db000000-0000-0000-0000-000000000002',
    'db100000-0000-0000-0000-000000000002',
    'Tenant B Private Brief', 'draft'
  );

INSERT INTO business_development_brief_versions (
  id, tenant_id, brief_id, version_number, sections, sections_hash,
  source_snapshot, snapshot_hash, citations, idempotency_key,
  idempotency_op, idempotency_fingerprint
)
VALUES
  (
    'da300000-0000-0000-0000-000000000001',
    'da000000-0000-0000-0000-000000000001',
    'da200000-0000-0000-0000-000000000001',
    1,
    '{"companyAndFirmImplication":{"text":"A","provenance":"generated","citationIndexes":[]},"verifiedEvidence":{"text":"A","provenance":"generated","citationIndexes":[]},"judgment":{"text":"A","provenance":"generated","citationIndexes":[]},"practicalAction":{"text":"A","provenance":"generated","citationIndexes":[]},"missingInformation":{"text":"A","provenance":"generated","citationIndexes":[]}}'::jsonb,
    repeat('a', 64), '{}'::jsonb, repeat('b', 64), '[]'::jsonb,
    'tenant-a-create', 'create', repeat('c', 64)
  ),
  (
    'db300000-0000-0000-0000-000000000002',
    'db000000-0000-0000-0000-000000000002',
    'db200000-0000-0000-0000-000000000002',
    1,
    '{"companyAndFirmImplication":{"text":"B","provenance":"generated","citationIndexes":[]},"verifiedEvidence":{"text":"B","provenance":"generated","citationIndexes":[]},"judgment":{"text":"B","provenance":"generated","citationIndexes":[]},"practicalAction":{"text":"B","provenance":"generated","citationIndexes":[]},"missingInformation":{"text":"B","provenance":"generated","citationIndexes":[]}}'::jsonb,
    repeat('d', 64), '{}'::jsonb, repeat('e', 64), '[]'::jsonb,
    'tenant-b-create', 'create', repeat('f', 64)
  );

UPDATE business_development_briefs
   SET current_version_id = CASE tenant_id
     WHEN 'da000000-0000-0000-0000-000000000001'::uuid
       THEN 'da300000-0000-0000-0000-000000000001'::uuid
     ELSE 'db300000-0000-0000-0000-000000000002'::uuid
   END;

-- The current-version pointer must remain inside the same tenant and brief.
DO $$
BEGIN
  UPDATE business_development_briefs
     SET current_version_id = 'db300000-0000-0000-0000-000000000002'
   WHERE id = 'da200000-0000-0000-0000-000000000001';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'cross-brief/cross-tenant current-version pointer was accepted';
EXCEPTION
  WHEN foreign_key_violation THEN NULL;
END
$$;
SET CONSTRAINTS ALL DEFERRED;

SET LOCAL ROLE capiro_app;
SELECT set_config('app.bypass_rls', 'off', true);

DO $$
DECLARE
  v_super BOOLEAN;
  v_bypass BOOLEAN;
BEGIN
  SELECT rolsuper, rolbypassrls INTO v_super, v_bypass
    FROM pg_roles WHERE rolname = current_user;
  IF current_user <> 'capiro_app' OR v_super OR v_bypass THEN
    RAISE EXCEPTION 'rehearsal must run as non-superuser/non-BYPASSRLS capiro_app';
  END IF;
END
$$;

SELECT set_config('app.current_tenant', 'da000000-0000-0000-0000-000000000001', true);

DO $$
DECLARE
  v_count INTEGER;
  v_rows INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM business_development_briefs;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A brief visibility failed: expected 1, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_brief_versions;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A version visibility failed: expected 1, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_briefs
   WHERE id = 'db200000-0000-0000-0000-000000000002';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'tenant A read tenant B brief';
  END IF;

  UPDATE business_development_briefs
     SET title = 'cross-tenant mutation'
   WHERE id = 'db200000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'tenant A updated tenant B brief';
  END IF;

  BEGIN
    INSERT INTO business_development_brief_versions (
      id, tenant_id, brief_id, version_number, sections, sections_hash,
      source_snapshot, snapshot_hash, citations, idempotency_key,
      idempotency_op, idempotency_fingerprint
    ) VALUES (
      'da300000-0000-0000-0000-000000000099',
      'db000000-0000-0000-0000-000000000002',
      'db200000-0000-0000-0000-000000000002',
      2, '{}'::jsonb, repeat('1', 64), '{}'::jsonb, repeat('2', 64), '[]'::jsonb,
      'cross-tenant-insert', 'edit', repeat('3', 64)
    );
    RAISE EXCEPTION 'tenant A inserted tenant B version';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE business_development_brief_versions
       SET sections_hash = repeat('9', 64)
     WHERE id = 'da300000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'application role updated immutable version';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM business_development_brief_versions
     WHERE id = 'da300000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'application role deleted immutable version';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

-- App role may append a same-tenant version and advance only the mutable root.
INSERT INTO business_development_brief_versions (
  id, tenant_id, brief_id, version_number, sections, sections_hash,
  source_snapshot, snapshot_hash, citations, idempotency_key,
  idempotency_op, idempotency_fingerprint
)
VALUES (
  'da300000-0000-0000-0000-000000000002',
  'da000000-0000-0000-0000-000000000001',
  'da200000-0000-0000-0000-000000000001',
  2, '{}'::jsonb, repeat('4', 64), '{}'::jsonb, repeat('5', 64), '[]'::jsonb,
  'tenant-a-edit', 'edit', repeat('6', 64)
);
UPDATE business_development_briefs
   SET current_version_id = 'da300000-0000-0000-0000-000000000002'
 WHERE id = 'da200000-0000-0000-0000-000000000001';

DO $$
BEGIN
  INSERT INTO business_development_brief_versions (
    tenant_id, brief_id, version_number, sections, sections_hash,
    source_snapshot, snapshot_hash, citations, idempotency_key,
    idempotency_op, idempotency_fingerprint
  ) VALUES (
    'da000000-0000-0000-0000-000000000001',
    'da200000-0000-0000-0000-000000000001',
    3, '{}'::jsonb, repeat('7', 64), '{}'::jsonb, repeat('8', 64), '[]'::jsonb,
    'tenant-a-edit', 'edit', repeat('9', 64)
  );
  RAISE EXCEPTION 'duplicate idempotency key was accepted';
EXCEPTION
  WHEN unique_violation THEN NULL;
END
$$;

SELECT set_config('app.current_tenant', '', true);
DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM business_development_briefs;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'unset tenant exposed % briefs', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_brief_versions;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'unset tenant exposed % versions', v_count;
  END IF;
END
$$;

SELECT set_config('app.current_tenant', 'db000000-0000-0000-0000-000000000002', true);
DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM business_development_briefs;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant B brief visibility failed: expected 1, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_brief_versions;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant B version visibility failed: expected 1, got %', v_count;
  END IF;
END
$$;

ROLLBACK;

SELECT 'BUSINESS DEVELOPMENT PHASE 4 BRIEF RLS REHEARSAL PASSED' AS result;
