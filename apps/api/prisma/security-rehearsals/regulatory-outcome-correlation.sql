\set ON_ERROR_STOP on

BEGIN;
SET LOCAL app.bypass_rls = 'on';

-- Minimal fixture tenant (outcome_event.client_id is nullable, so no client
-- fixture is needed to exercise its two widened CHECK constraints).
INSERT INTO tenants (id, slug, name)
VALUES ('99999999-9999-4999-8999-999999999999', 'regulatory-outcome-rehearsal', 'Regulatory Outcome Rehearsal');

-- outcome_event_kind_chk / outcome_event_source_type_chk actually accept
-- the two new values this migration adds.
INSERT INTO outcome_event (tenant_id, kind, source_type, source_id, evidence_jsonb)
VALUES (
  '99999999-9999-4999-8999-999999999999',
  'regulatory_action_published',
  'regulatory_document',
  '2026-00002',
  '{"docketId":"DOD-2026-OS-0001","documentNumber":"2026-00002","documentType":"PROPOSED_RULE","matchedOn":"docket_id"}'::jsonb
);

-- Every pre-existing kind/source_type value still works (widened, never
-- narrowed) -- same rows the original 20260713040000 migration's own
-- domain already exercised in production.
INSERT INTO outcome_event (tenant_id, kind, source_type, source_id, evidence_jsonb)
VALUES (
  '99999999-9999-4999-8999-999999999999',
  'meeting_held',
  'meeting',
  'meeting-1',
  '{}'::jsonb
);

-- A genuinely bogus kind is still rejected -- the constraint is a real
-- allowlist, not accidentally turned into a no-op by the DROP+ADD.
DO $$
BEGIN
  BEGIN
    INSERT INTO outcome_event (tenant_id, kind, source_type, source_id)
    VALUES ('99999999-9999-4999-8999-999999999999', 'not_a_real_kind', 'manual', 'x');
    RAISE EXCEPTION 'bogus kind was accepted -- outcome_event_kind_chk is not enforcing';
  EXCEPTION
    WHEN check_violation THEN
      NULL; -- expected
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO outcome_event (tenant_id, kind, source_type, source_id)
    VALUES ('99999999-9999-4999-8999-999999999999', 'meeting_held', 'not_a_real_source_type', 'x');
    RAISE EXCEPTION 'bogus source_type was accepted -- outcome_event_source_type_chk is not enforcing';
  EXCEPTION
    WHEN check_violation THEN
      NULL; -- expected
  END;
END $$;

-- client_profile_fill_finding's two widened constraints: introspect rather
-- than INSERT (that table's FK chain -- run_id -> client_profile_fill_run
-- -> client/user -- is deliberately out of scope for this rehearsal; the
-- constraint DEFINITION is the thing this migration actually changed).
DO $$
DECLARE kind_def text;
DECLARE source_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO kind_def
    FROM pg_constraint WHERE conname = 'client_profile_fill_finding_kind_check';
  IF kind_def IS NULL OR kind_def NOT LIKE '%regulatory_outcome%' THEN
    RAISE EXCEPTION 'client_profile_fill_finding_kind_check missing regulatory_outcome: %', kind_def;
  END IF;
  IF kind_def NOT LIKE '%advocacy_outcome%' THEN
    RAISE EXCEPTION 'client_profile_fill_finding_kind_check accidentally narrowed (lost advocacy_outcome): %', kind_def;
  END IF;

  SELECT pg_get_constraintdef(oid) INTO source_def
    FROM pg_constraint WHERE conname = 'client_profile_fill_finding_source_check';
  IF source_def IS NULL OR source_def NOT LIKE '%federal_register%' THEN
    RAISE EXCEPTION 'client_profile_fill_finding_source_check missing federal_register: %', source_def;
  END IF;
  IF source_def NOT LIKE '%advocacy_history%' THEN
    RAISE EXCEPTION 'client_profile_fill_finding_source_check accidentally narrowed (lost advocacy_history): %', source_def;
  END IF;
END $$;

SELECT 'deterministic regulatory outcome correlation rehearsal passed' AS result;
ROLLBACK;
