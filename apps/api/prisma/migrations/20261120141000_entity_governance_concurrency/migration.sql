-- Phase 5 governance concurrency hardening.
--
-- The initial governance functions check the append-only event ledger before
-- mutating a link. Two simultaneous retries can both observe no event before
-- one acquires the link row lock. Serialize the tenant+idempotency key first so
-- the losing retry observes and returns the event created by the winner.

CREATE OR REPLACE FUNCTION govern_entity_alias(
  p_tenant_id UUID,
  p_alias_id UUID,
  p_action TEXT,
  p_actor_user_id UUID,
  p_reason_code TEXT,
  p_reason TEXT,
  p_idempotency_key TEXT
)
RETURNS UUID AS $$
DECLARE
  v_event_id UUID;
  v_entity_id UUID;
  v_status TEXT;
BEGIN
  PERFORM assert_entity_governance_tenant(p_tenant_id);

  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Entity governance actions require actor_user_id'
      USING ERRCODE = '23514';
  END IF;
  IF p_reason_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'Invalid entity governance reason code'
      USING ERRCODE = '23514';
  END IF;
  IF p_idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid entity governance idempotency key'
      USING ERRCODE = '23514';
  END IF;
  IF p_action NOT IN ('confirm', 'withdraw') THEN
    RAISE EXCEPTION 'Unsupported alias governance action'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0)
  );

  SELECT id INTO v_event_id
  FROM entity_identity_governance_events
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = p_idempotency_key;
  IF v_event_id IS NOT NULL THEN
    RETURN v_event_id;
  END IF;

  SELECT entity_id, status
    INTO v_entity_id, v_status
  FROM entity_aliases
  WHERE id = p_alias_id
    AND tenant_id = p_tenant_id
    AND identity_scope = 'tenant_private'
  FOR UPDATE;

  IF v_entity_id IS NULL THEN
    RAISE EXCEPTION 'Tenant-private entity alias not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Only an active entity alias may be governed'
      USING ERRCODE = '55000';
  END IF;

  IF p_action = 'confirm' THEN
    UPDATE entity_aliases
    SET verified_at = COALESCE(verified_at, CURRENT_TIMESTAMP),
        confidence = 1.0000
    WHERE id = p_alias_id
      AND tenant_id = p_tenant_id;
  ELSE
    UPDATE entity_aliases
    SET status = 'withdrawn'
    WHERE id = p_alias_id
      AND tenant_id = p_tenant_id;
  END IF;

  INSERT INTO entity_identity_governance_events (
    tenant_id,
    idempotency_key,
    action_type,
    subject_type,
    subject_id,
    entity_id,
    actor_user_id,
    reason_code,
    reason,
    metadata
  )
  VALUES (
    p_tenant_id,
    p_idempotency_key,
    CASE p_action WHEN 'confirm' THEN 'alias_confirmed' ELSE 'alias_withdrawn' END,
    'alias',
    p_alias_id,
    v_entity_id,
    p_actor_user_id,
    p_reason_code,
    nullif(btrim(COALESCE(p_reason, '')), ''),
    jsonb_build_object('governanceBoundary', 'govern_entity_alias')
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION govern_entity_identifier(
  p_tenant_id UUID,
  p_identifier_id UUID,
  p_action TEXT,
  p_actor_user_id UUID,
  p_reason_code TEXT,
  p_reason TEXT,
  p_idempotency_key TEXT
)
RETURNS UUID AS $$
DECLARE
  v_event_id UUID;
  v_entity_id UUID;
  v_status TEXT;
BEGIN
  PERFORM assert_entity_governance_tenant(p_tenant_id);

  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Entity governance actions require actor_user_id'
      USING ERRCODE = '23514';
  END IF;
  IF p_reason_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'Invalid entity governance reason code'
      USING ERRCODE = '23514';
  END IF;
  IF p_idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid entity governance idempotency key'
      USING ERRCODE = '23514';
  END IF;
  IF p_action NOT IN ('confirm', 'withdraw') THEN
    RAISE EXCEPTION 'Unsupported identifier governance action'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0)
  );

  SELECT id INTO v_event_id
  FROM entity_identity_governance_events
  WHERE tenant_id = p_tenant_id
    AND idempotency_key = p_idempotency_key;
  IF v_event_id IS NOT NULL THEN
    RETURN v_event_id;
  END IF;

  SELECT entity_id, status
    INTO v_entity_id, v_status
  FROM entity_identifiers
  WHERE id = p_identifier_id
    AND tenant_id = p_tenant_id
    AND identity_scope = 'tenant_private'
  FOR UPDATE;

  IF v_entity_id IS NULL THEN
    RAISE EXCEPTION 'Tenant-private entity identifier not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Only an active entity identifier may be governed'
      USING ERRCODE = '55000';
  END IF;

  IF p_action = 'confirm' THEN
    UPDATE entity_identifiers
    SET verified_at = COALESCE(verified_at, CURRENT_TIMESTAMP),
        confidence = 1.0000
    WHERE id = p_identifier_id
      AND tenant_id = p_tenant_id;
  ELSE
    UPDATE entity_identifiers
    SET status = 'withdrawn'
    WHERE id = p_identifier_id
      AND tenant_id = p_tenant_id;
  END IF;

  INSERT INTO entity_identity_governance_events (
    tenant_id,
    idempotency_key,
    action_type,
    subject_type,
    subject_id,
    entity_id,
    actor_user_id,
    reason_code,
    reason,
    metadata
  )
  VALUES (
    p_tenant_id,
    p_idempotency_key,
    CASE p_action WHEN 'confirm' THEN 'identifier_confirmed' ELSE 'identifier_withdrawn' END,
    'identifier',
    p_identifier_id,
    v_entity_id,
    p_actor_user_id,
    p_reason_code,
    nullif(btrim(COALESCE(p_reason, '')), ''),
    jsonb_build_object('governanceBoundary', 'govern_entity_identifier')
  )
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public;

COMMENT ON FUNCTION govern_entity_alias(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT) IS
  'Audited tenant-private alias governance, serialized by tenant and idempotency key.';
COMMENT ON FUNCTION govern_entity_identifier(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT) IS
  'Audited tenant-private identifier governance, serialized by tenant and idempotency key.';
