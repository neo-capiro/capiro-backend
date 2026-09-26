-- Phase 6 dormant capability-shadow sink persistence. This migration creates
-- no route, provider, worker, key loader, clock provider, or runtime caller.
-- Exact authenticated request verification remains in meriv2-core; this
-- database boundary owns only transactional compare-and-append semantics.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "meri_capability_shadow_ledger_heads" (
  "audience" VARCHAR(128) NOT NULL,
  "endpoint_id" VARCHAR(64) NOT NULL,
  "last_sequence" BIGINT NOT NULL DEFAULT 0,
  "last_ledger_entry_digest" CHAR(64),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "meri_capability_shadow_ledger_heads_pkey"
    PRIMARY KEY ("audience", "endpoint_id"),
  CONSTRAINT "meri_capability_shadow_ledger_heads_shape_check" CHECK (
    "audience" ~ '^[a-z][a-z0-9._:/-]{0,127}$' AND
    "endpoint_id" ~ '^[a-z][a-z0-9_-]{0,63}$' AND
    "last_sequence" >= 0 AND
    "last_sequence" <= 9007199254740991::BIGINT AND
    (
      ("last_sequence" = 0 AND "last_ledger_entry_digest" IS NULL) OR
      ("last_sequence" > 0 AND
       "last_ledger_entry_digest" ~ '^[0-9a-f]{64}$')
    )
  )
);

CREATE TABLE "meri_capability_shadow_ledger_entries" (
  -- Internal isolation control only. It is not included in the ledger digest
  -- or any public receipt, and deliberately has no cascading Tenant FK.
  "tenant_id" UUID NOT NULL,
  "audience" VARCHAR(128) NOT NULL,
  "endpoint_id" VARCHAR(64) NOT NULL,
  "sequence" BIGINT NOT NULL,
  "previous_entry_digest" CHAR(64),
  "appended_at" TIMESTAMPTZ(3) NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  "event_id" CHAR(64) NOT NULL,
  "idempotency_key" CHAR(64) NOT NULL,
  "event_payload_digest" CHAR(64) NOT NULL,
  "tenant_pseudonym_hash" CHAR(64) NOT NULL,
  "producer_registry_sha256" CHAR(64) NOT NULL,
  "sink_registry_sha256" CHAR(64) NOT NULL,
  "ledger_entry_digest" CHAR(64) NOT NULL,

  CONSTRAINT "meri_capability_shadow_ledger_entries_pkey"
    PRIMARY KEY ("audience", "endpoint_id", "sequence"),
  CONSTRAINT "meri_capability_shadow_ledger_idempotency_key"
    UNIQUE ("audience", "endpoint_id", "idempotency_key"),
  CONSTRAINT "meri_capability_shadow_ledger_entry_shape_check" CHECK (
    "audience" ~ '^[a-z][a-z0-9._:/-]{0,127}$' AND
    "endpoint_id" ~ '^[a-z][a-z0-9_-]{0,63}$' AND
    "sequence" > 0 AND
    "sequence" <= 9007199254740991::BIGINT AND
    (("sequence" = 1) = ("previous_entry_digest" IS NULL)) AND
    ("previous_entry_digest" IS NULL OR
      "previous_entry_digest" ~ '^[0-9a-f]{64}$') AND
    "request_digest" ~ '^[0-9a-f]{64}$' AND
    "event_id" ~ '^[0-9a-f]{64}$' AND
    "idempotency_key" = "event_id" AND
    "event_payload_digest" ~ '^[0-9a-f]{64}$' AND
    "tenant_pseudonym_hash" ~ '^[0-9a-f]{64}$' AND
    "producer_registry_sha256" ~ '^[0-9a-f]{64}$' AND
    "sink_registry_sha256" ~ '^[0-9a-f]{64}$' AND
    "ledger_entry_digest" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "meri_capability_shadow_ledger_tenant_time_idx"
  ON "meri_capability_shadow_ledger_entries" ("tenant_id", "appended_at");

CREATE FUNCTION meri_phase6_capability_shadow_entry_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'capability-shadow ledger entries are immutable: % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER meri_phase6_capability_shadow_entry_immutable_trigger
  BEFORE UPDATE OR DELETE ON "meri_capability_shadow_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION meri_phase6_capability_shadow_entry_immutable();

ALTER TABLE "meri_capability_shadow_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_capability_shadow_ledger_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_capability_shadow_ledger_tenant_isolation"
  ON "meri_capability_shadow_ledger_entries"
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Historical ambiguity lookup is deliberately separate from append. It may
-- recover an exact immutable row after the producer key expires, but it cannot
-- create one. Neither function is granted to the shared application role.
CREATE FUNCTION lookup_meri_capability_shadow_entry_v1(
  p_tenant_id UUID,
  p_audience TEXT,
  p_endpoint_id TEXT,
  p_idempotency_key TEXT,
  p_processing_not_before TIMESTAMPTZ,
  p_processing_not_after TIMESTAMPTZ
)
RETURNS TABLE (
  disposition TEXT,
  audience VARCHAR(128),
  endpoint_id VARCHAR(64),
  sequence BIGINT,
  previous_entry_digest CHAR(64),
  appended_at TIMESTAMPTZ(3),
  request_digest CHAR(64),
  event_id CHAR(64),
  idempotency_key CHAR(64),
  event_payload_digest CHAR(64),
  ledger_entry_digest CHAR(64)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  v_db_now TIMESTAMPTZ(3);
BEGIN
  IF public.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'capability-shadow lookup tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF p_audience IS NULL OR p_endpoint_id IS NULL OR
     p_idempotency_key IS NULL OR p_processing_not_before IS NULL OR
     p_processing_not_after IS NULL OR
     NOT isfinite(p_processing_not_before) OR
     NOT isfinite(p_processing_not_after) OR
     p_audience !~ '^[a-z][a-z0-9._:/-]{0,127}$' OR
     p_endpoint_id !~ '^[a-z][a-z0-9_-]{0,63}$' OR
     p_idempotency_key !~ '^[0-9a-f]{64}$' OR
     p_processing_not_before >= p_processing_not_after OR
     p_processing_not_after - p_processing_not_before > INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'capability-shadow lookup identity or processing window is malformed'
      USING ERRCODE = '22023';
  END IF;
  v_db_now := date_trunc('milliseconds', clock_timestamp());
  IF v_db_now < p_processing_not_before OR v_db_now >= p_processing_not_after THEN
    RAISE EXCEPTION 'capability-shadow lookup is outside the trusted processing window'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY SELECT
    'replayed'::TEXT,
    e.audience,
    e.endpoint_id,
    e.sequence,
    e.previous_entry_digest,
    e.appended_at,
    e.request_digest,
    e.event_id,
    e.idempotency_key,
    e.event_payload_digest,
    e.ledger_entry_digest
  FROM public.meri_capability_shadow_ledger_entries e
  WHERE e.tenant_id = p_tenant_id
    AND e.audience = p_audience
    AND e.endpoint_id = p_endpoint_id
    AND e.idempotency_key = p_idempotency_key;
END;
$$;

-- Dormant ungranted append. A row lock on the per-generation head serializes
-- first append, an in-window race replay, and every chain transition.
CREATE FUNCTION append_meri_capability_shadow_entry_v1(
  p_tenant_id UUID,
  p_audience TEXT,
  p_endpoint_id TEXT,
  p_request_digest TEXT,
  p_event_id TEXT,
  p_idempotency_key TEXT,
  p_event_payload_digest TEXT,
  p_tenant_pseudonym_hash TEXT,
  p_producer_registry_sha256 TEXT,
  p_sink_registry_sha256 TEXT,
  p_event_occurred_at TIMESTAMPTZ,
  p_processing_not_before TIMESTAMPTZ,
  p_processing_not_after TIMESTAMPTZ
)
RETURNS TABLE (
  disposition TEXT,
  audience VARCHAR(128),
  endpoint_id VARCHAR(64),
  sequence BIGINT,
  previous_entry_digest CHAR(64),
  appended_at TIMESTAMPTZ(3),
  request_digest CHAR(64),
  event_id CHAR(64),
  idempotency_key CHAR(64),
  event_payload_digest CHAR(64),
  ledger_entry_digest CHAR(64)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  v_head public.meri_capability_shadow_ledger_heads%ROWTYPE;
  v_existing public.meri_capability_shadow_ledger_entries%ROWTYPE;
  v_sequence BIGINT;
  v_previous_digest CHAR(64);
  v_appended_at TIMESTAMPTZ(3);
  v_appended_at_json TEXT;
  v_ledger_json TEXT;
  v_ledger_digest CHAR(64);
BEGIN
  IF public.current_tenant_id() IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'capability-shadow append tenant context mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF p_audience IS NULL OR p_endpoint_id IS NULL OR
     p_request_digest IS NULL OR p_event_id IS NULL OR
     p_idempotency_key IS NULL OR p_event_payload_digest IS NULL OR
     p_tenant_pseudonym_hash IS NULL OR
     p_producer_registry_sha256 IS NULL OR p_sink_registry_sha256 IS NULL OR
     p_event_occurred_at IS NULL OR p_processing_not_before IS NULL OR
     p_processing_not_after IS NULL OR
     NOT isfinite(p_event_occurred_at) OR
     NOT isfinite(p_processing_not_before) OR
     NOT isfinite(p_processing_not_after) OR
     p_audience !~ '^[a-z][a-z0-9._:/-]{0,127}$' OR
     p_endpoint_id !~ '^[a-z][a-z0-9_-]{0,63}$' OR
     p_request_digest !~ '^[0-9a-f]{64}$' OR
     p_event_id !~ '^[0-9a-f]{64}$' OR
     p_idempotency_key IS DISTINCT FROM p_event_id OR
     p_event_payload_digest !~ '^[0-9a-f]{64}$' OR
     p_tenant_pseudonym_hash !~ '^[0-9a-f]{64}$' OR
     p_producer_registry_sha256 !~ '^[0-9a-f]{64}$' OR
     p_sink_registry_sha256 !~ '^[0-9a-f]{64}$' OR
     p_processing_not_before >= p_processing_not_after OR
     p_processing_not_after - p_processing_not_before > INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'capability-shadow append identity is malformed'
      USING ERRCODE = '22023';
  END IF;

  v_appended_at := date_trunc('milliseconds', clock_timestamp());
  IF v_appended_at < p_processing_not_before OR
     v_appended_at >= p_processing_not_after THEN
    RAISE EXCEPTION 'capability-shadow database clock is outside the trusted processing window'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.meri_capability_shadow_ledger_heads (
    audience, endpoint_id, last_sequence, last_ledger_entry_digest
  ) VALUES (p_audience, p_endpoint_id, 0, NULL)
  ON CONFLICT DO NOTHING;

  SELECT * INTO STRICT v_head
  FROM public.meri_capability_shadow_ledger_heads h
  WHERE h.audience = p_audience AND h.endpoint_id = p_endpoint_id
  FOR UPDATE;

  -- The explicit tenant predicate plus the current-tenant equality check make
  -- this definer lookup tenant-local even if its owner bypasses RLS. The exact
  -- database uniqueness key remains global, so a cross-tenant collision fails
  -- the later INSERT and cannot be returned as an authorized replay.
  SELECT * INTO v_existing
  FROM public.meri_capability_shadow_ledger_entries e
  WHERE e.tenant_id = p_tenant_id
    AND e.audience = p_audience
    AND e.endpoint_id = p_endpoint_id
    AND e.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.request_digest IS DISTINCT FROM p_request_digest OR
       v_existing.event_id IS DISTINCT FROM p_event_id OR
       v_existing.event_payload_digest IS DISTINCT FROM p_event_payload_digest OR
       v_existing.tenant_pseudonym_hash IS DISTINCT FROM p_tenant_pseudonym_hash OR
       v_existing.producer_registry_sha256 IS DISTINCT FROM p_producer_registry_sha256 OR
       v_existing.sink_registry_sha256 IS DISTINCT FROM p_sink_registry_sha256 THEN
      RAISE EXCEPTION 'capability-shadow idempotency key reused for a different request'
        USING ERRCODE = '23505';
    END IF;
    IF v_existing.appended_at < p_event_occurred_at THEN
      RAISE EXCEPTION 'capability-shadow original append predates its signed event'
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY SELECT
      'replayed'::TEXT,
      v_existing.audience,
      v_existing.endpoint_id,
      v_existing.sequence,
      v_existing.previous_entry_digest,
      v_existing.appended_at,
      v_existing.request_digest,
      v_existing.event_id,
      v_existing.idempotency_key,
      v_existing.event_payload_digest,
      v_existing.ledger_entry_digest;
    RETURN;
  END IF;

  IF v_head.last_sequence >= 9007199254740991::BIGINT THEN
    RAISE EXCEPTION 'capability-shadow JavaScript-safe ledger sequence exhausted'
      USING ERRCODE = '22003';
  END IF;
  v_sequence := v_head.last_sequence + 1;
  v_previous_digest := v_head.last_ledger_entry_digest;
  IF v_appended_at < p_event_occurred_at THEN
    RAISE EXCEPTION 'capability-shadow database append time predates the signed event'
      USING ERRCODE = '22023';
  END IF;
  v_appended_at_json := to_char(
    v_appended_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  -- This exact key order is the lexicographic stable-JSON order used by
  -- capabilityShadowLedgerEntryDigest in meriv2-core.
  v_ledger_json :=
    '{"appendedAt":"' || v_appended_at_json || '"' ||
    ',"eventId":"' || p_event_id || '"' ||
    ',"eventPayloadDigest":"' || p_event_payload_digest || '"' ||
    ',"idempotencyKey":"' || p_idempotency_key || '"' ||
    ',"previousEntryDigest":' ||
      CASE WHEN v_previous_digest IS NULL THEN 'null'
           ELSE '"' || v_previous_digest || '"' END ||
    ',"requestDigest":"' || p_request_digest || '"' ||
    ',"sequence":' || v_sequence::TEXT || '}';
  v_ledger_digest := encode(
    public.digest(
      convert_to('meri.capability_shadow.append_ledger_entry.v1', 'UTF8') ||
      decode('00', 'hex') ||
      convert_to(v_ledger_json, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.meri_capability_shadow_ledger_entries (
    tenant_id, audience, endpoint_id, sequence, previous_entry_digest,
    appended_at, request_digest, event_id, idempotency_key,
    event_payload_digest, tenant_pseudonym_hash,
    producer_registry_sha256, sink_registry_sha256, ledger_entry_digest
  ) VALUES (
    p_tenant_id, p_audience, p_endpoint_id, v_sequence, v_previous_digest,
    v_appended_at, p_request_digest, p_event_id, p_idempotency_key,
    p_event_payload_digest, p_tenant_pseudonym_hash,
    p_producer_registry_sha256, p_sink_registry_sha256, v_ledger_digest
  );

  UPDATE public.meri_capability_shadow_ledger_heads
  SET last_sequence = v_sequence,
      last_ledger_entry_digest = v_ledger_digest,
      updated_at = v_appended_at
  WHERE meri_capability_shadow_ledger_heads.audience = p_audience
    AND meri_capability_shadow_ledger_heads.endpoint_id = p_endpoint_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capability-shadow ledger head update was lost'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT
    'appended'::TEXT,
    p_audience::VARCHAR(128),
    p_endpoint_id::VARCHAR(64),
    v_sequence,
    v_previous_digest,
    v_appended_at,
    p_request_digest::CHAR(64),
    p_event_id::CHAR(64),
    p_idempotency_key::CHAR(64),
    p_event_payload_digest::CHAR(64),
    v_ledger_digest;
END;
$$;

REVOKE ALL ON TABLE "meri_capability_shadow_ledger_heads" FROM PUBLIC;
REVOKE ALL ON TABLE "meri_capability_shadow_ledger_entries" FROM PUBLIC;
REVOKE ALL ON FUNCTION lookup_meri_capability_shadow_entry_v1(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION append_meri_capability_shadow_entry_v1(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    -- Default privileges otherwise expose every new table/function to the
    -- shared API identity. It must have no read, lookup, or append path here.
    REVOKE ALL ON TABLE "meri_capability_shadow_ledger_heads" FROM capiro_app;
    REVOKE ALL ON TABLE "meri_capability_shadow_ledger_entries" FROM capiro_app;
    REVOKE ALL ON FUNCTION lookup_meri_capability_shadow_entry_v1(
      UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM capiro_app;
    REVOKE ALL ON FUNCTION append_meri_capability_shadow_entry_v1(
      UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
      TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
    ) FROM capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "meri_capability_shadow_ledger_entries" IS
  'Dormant Phase 6 immutable content-free shadow evidence; written only through the transactional append function.';
COMMENT ON COLUMN "meri_capability_shadow_ledger_entries"."tenant_id" IS
  'Internal RLS control only; never included in a public ledger entry or receipt.';
COMMENT ON FUNCTION append_meri_capability_shadow_entry_v1(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) IS
  'Dormant ungranted append; grant only to a dedicated non-BYPASS sink identity after DB-enforced tenant-auth mapping exists.';
COMMENT ON FUNCTION lookup_meri_capability_shadow_entry_v1(
  UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ
) IS
  'Dormant historical exact-replay lookup; never authorizes a new append and is not granted to capiro_app.';
