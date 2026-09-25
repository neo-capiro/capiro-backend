-- Business Development Phase 5 watch/alert isolation rehearsal.
--
-- Run against a disposable database with every Prisma migration applied
-- (including 20280928010000_business_development_phase5_watch_alerts).
-- Fixture setup uses the database owner. Every application-role proof runs
-- as non-superuser/non-BYPASSRLS capiro_app. The transaction always rolls
-- back.
--
-- Proves:
--   * watch / state / alert / delivery visibility is tenant-scoped;
--   * cross-tenant reads see zero rows;
--   * cross-tenant writes fail (RLS WITH CHECK);
--   * the tenant-safe composite FKs reject cross-tenant watch/prospect and
--     alert/watch attachments, including a cross-tenant DENORMALIZED
--     prospect_id on an alert;
--   * the semantic dedupe unique blocks a double-recorded alert;
--   * the idempotent delivery unique blocks a double delivery;
--   * the delivery dismiss shape CHECK rejects a half-written dismiss (the
--     delivery row is the authoritative recipient read/dismiss state);
--   * closed-vocabulary CHECKs reject bad status/source_family/change_kind;
--   * the lease shape CHECK rejects a half-written lease;
--   * the quiet backfill invariant: seeding runs with ZERO alert rows and
--     baseline NULL on state rows (checked structurally below).

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO tenants (id, name, slug)
VALUES
  ('ea000000-0000-0000-0000-000000000001', 'BizDev Phase 5 A', 'bizdev-phase5-a'),
  ('eb000000-0000-0000-0000-000000000002', 'BizDev Phase 5 B', 'bizdev-phase5-b')
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_development_prospects (
  id, tenant_id, display_name, stage, status, conflict_excluded, watch_requested
)
VALUES
  (
    'ea100000-0000-0000-0000-000000000001',
    'ea000000-0000-0000-0000-000000000001',
    'Tenant A Private Prospect', 'qualified', 'active', false, true
  ),
  (
    'eb100000-0000-0000-0000-000000000002',
    'eb000000-0000-0000-0000-000000000002',
    'Tenant B Private Prospect', 'researching', 'active', false, true
  )
ON CONFLICT (id) DO NOTHING;

-- The migration's quiet backfill may already have created watches for these
-- watch_requested prospects on a fresh DB; insert defensively/idempotently
-- so this rehearsal also works on a DB where the migration did NOT run its
-- backfill for these fresh fixtures.
INSERT INTO business_development_watches (
  id, tenant_id, prospect_id, status
)
VALUES
  (
    'ea200000-0000-0000-0000-000000000001',
    'ea000000-0000-0000-0000-000000000001',
    'ea100000-0000-0000-0000-000000000001',
    'active'
  ),
  (
    'eb200000-0000-0000-0000-000000000002',
    'eb000000-0000-0000-0000-000000000002',
    'eb100000-0000-0000-0000-000000000002',
    'active'
  )
ON CONFLICT (tenant_id, prospect_id) DO NOTHING;

INSERT INTO business_development_watch_source_states (
  id, tenant_id, watch_id, source_family, health, lease_token, lease_until
)
VALUES
  (
    'ea300000-0000-0000-0000-000000000001',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'federal_award', 'pending', NULL, NULL
  ),
  (
    'eb300000-0000-0000-0000-000000000002',
    'eb000000-0000-0000-0000-000000000002',
    'eb200000-0000-0000-0000-000000000002',
    'lda_filing', 'pending', NULL, NULL
  )
ON CONFLICT (tenant_id, watch_id, source_family) DO NOTHING;

INSERT INTO business_development_alerts (
  id, tenant_id, watch_id, prospect_id, source_family, category,
  change_kind, materiality, record_id, fingerprint, dedupe_key,
  after_state, title, summary, implication, source_locator
)
VALUES
  (
    'ea400000-0000-0000-0000-000000000001',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'ea100000-0000-0000-0000-000000000001',
    'federal_award', 'contract_award', 'new_record', 'high',
    'CONT_TEST_1', repeat('a', 64),
    'federal_award:CONT_TEST_1:' || repeat('a', 64),
    '{}'::jsonb, 'Alert A', 'Summary A', 'Inference A', 'loc-a'
  ),
  (
    'eb400000-0000-0000-0000-000000000002',
    'eb000000-0000-0000-0000-000000000002',
    'eb200000-0000-0000-0000-000000000002',
    'eb100000-0000-0000-0000-000000000002',
    'lda_filing', 'lobbying', 'new_record', 'low',
    'LDA_TEST_2', repeat('b', 64),
    'lda_filing:LDA_TEST_2:' || repeat('b', 64),
    '{}'::jsonb, 'Alert B', 'Summary B', 'Inference B', 'loc-b'
  );

INSERT INTO business_development_alert_deliveries (
  id, tenant_id, alert_id, recipient_user_id, channel
)
VALUES
  (
    'ea500000-0000-0000-0000-000000000001',
    'ea000000-0000-0000-0000-000000000001',
    'ea400000-0000-0000-0000-000000000001',
    'ea600000-0000-0000-0000-000000000001',
    'in_app'
  );

-- Constraint proofs (as table owner, before switching to the app role).

-- Cross-tenant watch attachment: composite FK must reject it.
DO $$
BEGIN
  INSERT INTO business_development_watches (
    id, tenant_id, prospect_id, status
  ) VALUES (
    'ea200000-0000-0000-0000-000000000099',
    'ea000000-0000-0000-0000-000000000001',
    'eb100000-0000-0000-0000-000000000002',
    'active'
  );
  RAISE EXCEPTION 'cross-tenant prospect watch was accepted';
EXCEPTION
  WHEN foreign_key_violation THEN NULL;
END
$$;

-- A dismissal actor does not make a delivery read: dismissed_at itself must
-- have a prior read_at. This exercises the read-shape CHECK independently of
-- the dismissed-actor pair CHECK above.
DO $$
BEGIN
  INSERT INTO business_development_alert_deliveries (
    id, tenant_id, alert_id, recipient_user_id, channel,
    dismissed_at, dismissed_by_user_id
  ) VALUES (
    'ea500000-0000-0000-0000-000000000092',
    'ea000000-0000-0000-0000-000000000001',
    'ea400000-0000-0000-0000-000000000001',
    'ea600000-0000-0000-0000-000000000001',
    'in_app', now(), 'ea600000-0000-0000-0000-000000000001'
  );
  RAISE EXCEPTION 'dismissal without a prior read was accepted';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$$;

-- Cross-tenant alert attachment: composite FK must reject it.
DO $$
BEGIN
  INSERT INTO business_development_alerts (
    id, tenant_id, watch_id, prospect_id, source_family, category,
    change_kind, materiality, record_id, fingerprint, dedupe_key,
    after_state, title, summary, implication, source_locator
  ) VALUES (
    'ea400000-0000-0000-0000-000000000098',
    'ea000000-0000-0000-0000-000000000001',
    'eb200000-0000-0000-0000-000000000002',
    'eb100000-0000-0000-0000-000000000002',
    'lda_filing', 'lobbying', 'new_record', 'low',
    'LDA_X', repeat('c', 64), 'lda_filing:LDA_X:' || repeat('c', 64),
    '{}'::jsonb, 'X', 'X', 'X', 'X'
  );
  RAISE EXCEPTION 'cross-tenant alert watch was accepted';
EXCEPTION
  WHEN foreign_key_violation THEN NULL;
END
$$;

-- Cross-tenant DENORMALIZED prospect_id on an alert: even with a valid
-- same-tenant watch, the alert's prospect_id must name a prospect of the
-- SAME tenant (composite FK), so alert.prospectId can never disagree.
DO $$
BEGIN
  INSERT INTO business_development_alerts (
    id, tenant_id, watch_id, prospect_id, source_family, category,
    change_kind, materiality, record_id, fingerprint, dedupe_key,
    after_state, title, summary, implication, source_locator
  ) VALUES (
    'ea400000-0000-0000-0000-000000000093',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'eb100000-0000-0000-0000-000000000002',
    'federal_award', 'contract_award', 'new_record', 'low',
    'PROSPECT_X', repeat('g', 64), 'federal_award:PROSPECT_X:' || repeat('g', 64),
    '{}'::jsonb, 'X', 'X', 'X', 'X'
  );
  RAISE EXCEPTION 'cross-tenant alert prospect was accepted';
EXCEPTION
  WHEN foreign_key_violation THEN NULL;
END
$$;

-- Delivery dismiss shape: dismissed_at without dismissed_by_user_id must be
-- rejected (the delivery row is the AUTHORITATIVE recipient read/dismiss
-- state).
DO $$
BEGIN
  INSERT INTO business_development_alert_deliveries (
    id, tenant_id, alert_id, recipient_user_id, channel, dismissed_at
  ) VALUES (
    'ea500000-0000-0000-0000-000000000093',
    'ea000000-0000-0000-0000-000000000001',
    'ea400000-0000-0000-0000-000000000001',
    'ea600000-0000-0000-0000-000000000001',
    'in_app', now()
  );
  RAISE EXCEPTION 'half-written delivery dismiss was accepted';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$$;

-- Semantic dedupe unique: the same (tenant, watch, dedupe_key) twice.
DO $$
BEGIN
  INSERT INTO business_development_alerts (
    id, tenant_id, watch_id, prospect_id, source_family, category,
    change_kind, materiality, record_id, fingerprint, dedupe_key,
    after_state, title, summary, implication, source_locator
  ) VALUES (
    'ea400000-0000-0000-0000-000000000097',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'ea100000-0000-0000-0000-000000000001',
    'federal_award', 'contract_award', 'new_record', 'high',
    'CONT_TEST_1', repeat('a', 64),
    'federal_award:CONT_TEST_1:' || repeat('a', 64),
    '{}'::jsonb, 'Dup', 'Dup', 'Dup', 'loc-a'
  );
  RAISE EXCEPTION 'duplicate semantic alert was accepted';
EXCEPTION
  WHEN unique_violation THEN NULL;
END
$$;

-- Idempotent delivery unique: same alert, recipient, channel twice.
DO $$
BEGIN
  INSERT INTO business_development_alert_deliveries (
    id, tenant_id, alert_id, recipient_user_id, channel
  ) VALUES (
    'ea500000-0000-0000-0000-000000000099',
    'ea000000-0000-0000-0000-000000000001',
    'ea400000-0000-0000-0000-000000000001',
    'ea600000-0000-0000-0000-000000000001',
    'in_app'
  );
  RAISE EXCEPTION 'duplicate delivery was accepted';
EXCEPTION
  WHEN unique_violation THEN NULL;
END
$$;

-- Closed vocabularies: bad watch status / source family / change kind /
-- half-written lease must all be rejected.
DO $$
BEGIN
  INSERT INTO business_development_watches (
    id, tenant_id, prospect_id, status
  ) VALUES (
    'ea200000-0000-0000-0000-000000000096',
    'ea000000-0000-0000-0000-000000000001',
    'ea100000-0000-0000-0000-000000000001',
    'sleeping'
  );
  RAISE EXCEPTION 'bad watch status was accepted';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$$;

DO $$
BEGIN
  INSERT INTO business_development_watch_source_states (
    id, tenant_id, watch_id, source_family, health
  ) VALUES (
    'ea300000-0000-0000-0000-000000000096',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'twitter_firehose', 'pending'
  );
  RAISE EXCEPTION 'unallowlisted source family was accepted';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$$;

DO $$
BEGIN
  INSERT INTO business_development_alerts (
    id, tenant_id, watch_id, prospect_id, source_family, category,
    change_kind, materiality, record_id, fingerprint, dedupe_key,
    after_state, title, summary, implication, source_locator
  ) VALUES (
    'ea400000-0000-0000-0000-000000000096',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'ea100000-0000-0000-0000-000000000001',
    'federal_award', 'contract_award', 'vibes', 'high',
    'X', repeat('d', 64), 'federal_award:X:' || repeat('d', 64),
    '{}'::jsonb, 'X', 'X', 'X', 'X'
  );
  RAISE EXCEPTION 'bad change kind was accepted';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$$;

DO $$
BEGIN
  INSERT INTO business_development_watch_source_states (
    id, tenant_id, watch_id, source_family, health, lease_token
  ) VALUES (
    'ea300000-0000-0000-0000-000000000095',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'sam_opportunity', 'pending', 'half-lease'
  );
  RAISE EXCEPTION 'half-written lease was accepted';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$$;

-- Quiet-baseline invariant: a baselined_at without a baseline JSON (or vice
-- versa) must be rejected, so the runner can never claim a quiet baseline it
-- did not write.
DO $$
BEGIN
  INSERT INTO business_development_watch_source_states (
    id, tenant_id, watch_id, source_family, health, baselined_at
  ) VALUES (
    'ea300000-0000-0000-0000-000000000094',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'sam_opportunity', 'pending', now()
  );
  RAISE EXCEPTION 'baselined_at without baseline state was accepted';
EXCEPTION
  WHEN check_violation THEN NULL;
END
$$;

-- Application-role proofs.
SET LOCAL ROLE capiro_app;
SELECT set_config('app.bypass_rls', 'off', true);

DO $$
DECLARE
  v_super BOOLEAN;
  v_bypass BOOLEAN;
  v_count INTEGER;
  v_rows INTEGER;
BEGIN
  SELECT rolsuper, rolbypassrls INTO v_super, v_bypass
    FROM pg_roles WHERE rolname = current_user;
  IF current_user <> 'capiro_app' OR v_super OR v_bypass THEN
    RAISE EXCEPTION 'rehearsal must run as non-superuser/non-BYPASSRLS capiro_app';
  END IF;

  SELECT set_config('app.current_tenant',
    'ea000000-0000-0000-0000-000000000001', true);

  -- Tenant-scoped visibility: exactly own rows, zero foreign rows.
  SELECT count(*) INTO v_count FROM business_development_watches;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A watch visibility failed: expected 1, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_watch_source_states;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A state visibility failed: expected 1, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_alerts;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A alert visibility failed: expected 1, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_alert_deliveries;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A delivery visibility failed: expected 1, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM business_development_watches
   WHERE id = 'eb200000-0000-0000-0000-000000000002';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'tenant A read tenant B watch';
  END IF;

  -- Cross-tenant mutation is invisible AND unwritable.
  UPDATE business_development_watches
     SET status = 'paused'
   WHERE id = 'eb200000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'tenant A updated tenant B watch';
  END IF;

  UPDATE business_development_alerts
     SET title = 'cross-tenant mutation'
   WHERE id = 'eb400000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'tenant A updated tenant B alert';
  END IF;

  -- Cross-tenant INSERT is rejected by the RLS WITH CHECK clause.
  BEGIN
    INSERT INTO business_development_alerts (
      id, tenant_id, watch_id, prospect_id, source_family, category,
      change_kind, materiality, record_id, fingerprint, dedupe_key,
      after_state, title, summary, implication, source_locator
    ) VALUES (
      'ea400000-0000-0000-0000-000000000095',
      'eb000000-0000-0000-0000-000000000002',
      'eb200000-0000-0000-0000-000000000002',
      'eb100000-0000-0000-0000-000000000002',
      'lda_filing', 'lobbying', 'new_record', 'low',
      'LDA_CROSS', repeat('e', 64), 'lda_filing:LDA_CROSS:' || repeat('e', 64),
      '{}'::jsonb, 'X', 'X', 'X', 'X'
    );
    RAISE EXCEPTION 'tenant A inserted tenant B alert';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  -- Same-tenant writes succeed: claim the lease (full shape), then release.
  UPDATE business_development_watch_source_states
     SET lease_token = 'claim-1',
         lease_until = now() + interval '10 minutes',
         updated_at = now()
   WHERE id = 'ea300000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tenant A could not claim own lease';
  END IF;

  UPDATE business_development_watch_source_states
     SET lease_token = NULL,
         lease_until = NULL,
         updated_at = now()
   WHERE id = 'ea300000-0000-0000-0000-000000000001';

  -- Same-tenant alert append works.
  INSERT INTO business_development_alerts (
    id, tenant_id, watch_id, prospect_id, source_family, category,
    change_kind, materiality, record_id, fingerprint, dedupe_key,
    after_state, title, summary, implication, source_locator
  ) VALUES (
    'ea400000-0000-0000-0000-000000000002',
    'ea000000-0000-0000-0000-000000000001',
    'ea200000-0000-0000-0000-000000000001',
    'ea100000-0000-0000-0000-000000000001',
    'federal_award', 'contract_award', 'material_update', 'medium',
    'CONT_TEST_2', repeat('f', 64), 'federal_award:CONT_TEST_2:' || repeat('f', 64),
    '{}'::jsonb, 'Alert A2', 'Summary A2', 'Inference A2', 'loc-a2'
  );
END
$$;

ROLLBACK;
