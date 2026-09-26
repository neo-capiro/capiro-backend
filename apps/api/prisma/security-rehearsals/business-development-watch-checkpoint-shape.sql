-- Local disposable-DB proof for the actual baseline shape constraint.
-- Run before migration with -v expect_initial_checkpoint=false, then after
-- migration with -v expect_initial_checkpoint=true. Both runs roll back.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('bizdev.expected_initial_checkpoint_allowed', :'expect_initial_checkpoint', true);
DO $$
BEGIN
  IF current_database() NOT LIKE 'capiro_bizdev_watch_paging_%' THEN
    RAISE EXCEPTION 'This rehearsal is restricted to the dedicated local disposable database';
  END IF;
END $$;

INSERT INTO tenants (id, name, slug)
VALUES ('ac000000-0000-4000-8000-000000000001', 'Checkpoint rehearsal', 'checkpoint-rehearsal');
INSERT INTO business_development_prospects (id, tenant_id, display_name, stage, status)
VALUES ('ac100000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
        'LOCAL TEST ONLY', 'researching', 'active');
INSERT INTO business_development_watches (id, tenant_id, prospect_id, status)
VALUES ('ac200000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
        'ac100000-0000-4000-8000-000000000001', 'active');
INSERT INTO business_development_watch_source_states (id, tenant_id, watch_id, source_family)
VALUES ('ac300000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
        'ac200000-0000-4000-8000-000000000001', 'federal_award');

DO $$
DECLARE
  accepted BOOLEAN := false;
  expected BOOLEAN := current_setting('bizdev.expected_initial_checkpoint_allowed')::boolean;
  violated_constraint TEXT;
  bad JSONB;
  valid_initial JSONB := '{"initialized":false,"establishedAt":"2026-09-26T00:00:00Z","records":{},"scan":{"version":1,"phase":"initial","stagedRecords":{}}}'::jsonb;
BEGIN
  BEGIN
    UPDATE business_development_watch_source_states
    SET baseline_state = valid_initial, health = 'partial'
    WHERE id = 'ac300000-0000-4000-8000-000000000001';
    accepted := true;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'business_development_watch_source_states_baseline_shape_check' THEN
      RAISE;
    END IF;
  END;
  IF accepted IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Quiet partial checkpoint accepted %, expected %', accepted, expected;
  END IF;
  IF EXISTS (
    SELECT 1 FROM business_development_watch_source_states
    WHERE id = 'ac300000-0000-4000-8000-000000000001'
      AND (baselined_at IS NOT NULL OR last_successful_complete_check_at IS NOT NULL OR source_watermark IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Initial progress falsely advanced a complete-source marker';
  END IF;

  -- Missing-key expressions must not bypass a CHECK via SQL NULL truth.
  FOREACH bad IN ARRAY ARRAY[
    '{}'::jsonb, 'null'::jsonb, '[]'::jsonb,
    '{"initialized":true,"records":{}}'::jsonb,
    '{"initialized":false,"records":{},"scan":{"version":2,"phase":"initial","stagedRecords":{}}}'::jsonb,
    '{"initialized":false,"records":{},"scan":{"version":1,"phase":"cycle","stagedRecords":{}}}'::jsonb,
    '{"initialized":false,"records":{},"scan":{"version":1,"phase":"initial"}}'::jsonb,
    '{"initialized":false,"scan":{"version":1,"phase":"initial","stagedRecords":{}}}'::jsonb,
    '{"initialized":false,"records":{},"scan":{"version":1,"phase":"initial","stagedRecords":[]}}'::jsonb
  ] LOOP
    accepted := false;
    BEGIN
      UPDATE business_development_watch_source_states SET baseline_state = bad
      WHERE id = 'ac300000-0000-4000-8000-000000000001';
      accepted := true;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
      IF violated_constraint <> 'business_development_watch_source_states_baseline_shape_check' THEN RAISE; END IF;
    END;
    IF accepted THEN RAISE EXCEPTION 'Malformed initial checkpoint admitted: %', bad; END IF;
  END LOOP;

  -- Valid legacy completed baselines keep working after the additive change.
  UPDATE business_development_watch_source_states
  SET baseline_state = '{"initialized":true,"establishedAt":"2026-09-26T00:00:00Z","records":{}}',
      baselined_at = now(), last_successful_complete_check_at = now(), source_watermark = now(), health = 'healthy'
  WHERE id = 'ac300000-0000-4000-8000-000000000001';

  accepted := false;
  BEGIN
    UPDATE business_development_watch_source_states SET baseline_state = NULL
    WHERE id = 'ac300000-0000-4000-8000-000000000001';
    accepted := true;
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF accepted THEN RAISE EXCEPTION 'Completed timestamp without baseline JSON admitted'; END IF;
  IF EXISTS (SELECT 1 FROM business_development_alerts WHERE tenant_id = 'ac000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'Quiet checkpoint rehearsal created an alert';
  END IF;
  RAISE NOTICE 'PASS: initial checkpoint acceptance=%, malformed shapes rejected, completion markers honest, legacy compatible, zero alerts', expected;
END $$;
ROLLBACK;
