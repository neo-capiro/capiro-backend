-- Knowledge Plane — Phase 5 governance actions.
--
-- Canonical entity resolution is precision-first and append-only. Human review
-- must therefore be represented as attributable actions rather than silent row
-- rewrites. This migration adds a tenant-scoped governance ledger and the only
-- application-role mutation boundary for tenant-private aliases/identifiers.
--
-- Resolution confirmation remains an append-only corrected EntityResolution.
-- Resolution rejection creates a new rejected EntityResolution plus a governance
-- event. Alias/identifier confirmation or withdrawal is performed through the
-- SECURITY DEFINER functions below; direct UPDATE is revoked from capiro_app.

CREATE TABLE "entity_identity_governance_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(64) NOT NULL,
  "action_type" VARCHAR(40) NOT NULL,
  "subject_type" VARCHAR(24) NOT NULL,
  "subject_id" UUID NOT NULL,
  "entity_id" UUID,
  "actor_user_id" UUID NOT NULL,
  "reason_code" VARCHAR(64) NOT NULL,
  "reason" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "entity_identity_governance_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "entity_identity_governance_events_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "entity_identity_governance_events_identity_unique"
    UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "entity_identity_governance_events_idempotency_check"
    CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "entity_identity_governance_events_action_check"
    CHECK ("action_type" IN (
      'resolution_confirmed',
      'resolution_rejected',
      'alias_confirmed',
      'alias_withdrawn',
      'identifier_confirmed',
      'identifier_withdrawn'
    )),
  CONSTRAINT "entity_identity_governance_events_subject_check"
    CHECK ("subject_type" IN ('resolution', 'alias', 'identifier')),
  CONSTRAINT "entity_identity_governance_events_reason_code_check"
    CHECK ("reason_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "entity_identity_governance_events_metadata_check"
    CHECK (jsonb_typeof("metadata") = 'object')
);

CREATE INDEX "entity_identity_governance_events_subject_idx"
  ON "entity_identity_governance_events"
    ("tenant_id", "subject_type", "subject_id", "created_at" DESC);
CREATE INDEX "entity_identity_governance_events_entity_idx"
  ON "entity_identity_governance_events"
    ("tenant_id", "entity_id", "created_at" DESC)
  WHERE "entity_id" IS NOT NULL;
CREATE INDEX "entity_identity_governance_events_actor_idx"
  ON "entity_identity_governance_events"
    ("tenant_id", "actor_user_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION entity_governance_purge_allowed()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT rls_bypass()
     AND COALESCE(current_setting('app.knowledge_purge', true), '') = 'on'
$$;

CREATE OR REPLACE FUNCTION reject_entity_governance_event_mutation()
RETURNS trigger AS $$
BEGIN
  IF entity_governance_purge_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Entity identity governance events are append-only'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entity_identity_governance_events_reject_update"
  BEFORE UPDATE ON "entity_identity_governance_events"
  FOR EACH ROW EXECUTE FUNCTION reject_entity_governance_event_mutation();
CREATE TRIGGER "entity_identity_governance_events_reject_delete"
  BEFORE DELETE ON "entity_identity_governance_events"
  FOR EACH ROW EXECUTE FUNCTION reject_entity_governance_event_mutation();

ALTER TABLE "entity_identity_governance_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entity_identity_governance_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "entity_identity_governance_events_tenant_isolation"
  ON "entity_identity_governance_events"
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());

CREATE OR REPLACE FUNCTION assert_entity_governance_tenant(p_tenant_id UUID)
RETURNS VOID AS $$
BEGIN
  IF NOT rls_bypass()
     AND current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Entity governance action cannot cross tenants'
      USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

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

REVOKE UPDATE ON TABLE "entity_aliases" FROM capiro_app;
REVOKE UPDATE ON TABLE "entity_identifiers" FROM capiro_app;
REVOKE UPDATE, DELETE, TRUNCATE
  ON TABLE "entity_identity_governance_events" FROM capiro_app;

GRANT SELECT, INSERT ON TABLE "entity_identity_governance_events" TO capiro_app;
GRANT EXECUTE ON FUNCTION govern_entity_alias(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT
) TO capiro_app;
GRANT EXECUTE ON FUNCTION govern_entity_identifier(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT
) TO capiro_app;

COMMENT ON TABLE "entity_identity_governance_events" IS
  'Append-only tenant-scoped human governance actions for canonical resolution and identity links.';
COMMENT ON FUNCTION govern_entity_alias(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT) IS
  'The only capiro_app boundary for confirming or withdrawing tenant-private aliases.';
COMMENT ON FUNCTION govern_entity_identifier(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT) IS
  'The only capiro_app boundary for confirming or withdrawing tenant-private identifiers.';
