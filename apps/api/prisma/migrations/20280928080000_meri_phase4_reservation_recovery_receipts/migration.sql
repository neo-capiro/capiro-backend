-- Dormant Phase 4 signed unknown-worker reservation recovery authority.
-- Installs no caller, scheduler, route, key source, or application DML grant.
BEGIN;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
       OR m.member = 'meri_phase4_authority_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner membership pre-existed reservation migration'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'reservation migration executor cannot acquire owner authority'
      USING ERRCODE = '42501';
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
      AND m.member = current_user::regrole AND m.grantor = current_user::regrole
  ) THEN
    RAISE EXCEPTION 'reservation migration owner authority was not self-granted'
      USING ERRCODE = '42501';
  END IF;
END $$;

DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO meri_phase4_authority_owner;

ALTER TABLE public.meri_agent_dispatch_intents
  ADD CONSTRAINT meri_agent_dispatch_intents_reservation_identity_key UNIQUE (
    run_id, tenant_id, request_sha256, idempotency_key, worker_audience,
    worker_ingress_id, worker_generation, worker_credential_id,
    delivery_not_after_epoch_micros, retain_until_epoch_micros
  );

CREATE TABLE public.meri_phase4_reservation_recovery_operations (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  request_sha256 char(64) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  worker_audience varchar(64) NOT NULL,
  worker_ingress_id varchar(128) NOT NULL,
  worker_generation varchar(128) NOT NULL,
  worker_credential_id varchar(128) NOT NULL,
  delivery_not_before_epoch_micros bigint NOT NULL,
  retain_until_epoch_micros bigint NOT NULL,
  outcome varchar(16) NOT NULL,
  worker_run_id varchar(120),
  sealed_at_epoch_micros bigint,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_phase4_reservation_operation_pkey
    PRIMARY KEY (tenant_id, operation_id),
  CONSTRAINT meri_phase4_reservation_operation_identity_key UNIQUE (
    tenant_id, operation_id, run_id, request_sha256, idempotency_key,
    worker_audience, worker_ingress_id, worker_generation,
    worker_credential_id, delivery_not_before_epoch_micros,
    retain_until_epoch_micros, outcome, worker_run_id, sealed_at_epoch_micros
  ),
  CONSTRAINT meri_phase4_reservation_operation_intent_fk FOREIGN KEY (
    run_id, tenant_id, request_sha256, idempotency_key, worker_audience,
    worker_ingress_id, worker_generation, worker_credential_id,
    delivery_not_before_epoch_micros, retain_until_epoch_micros
  ) REFERENCES public.meri_agent_dispatch_intents (
    run_id, tenant_id, request_sha256, idempotency_key, worker_audience,
    worker_ingress_id, worker_generation, worker_credential_id,
    delivery_not_after_epoch_micros, retain_until_epoch_micros
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meri_phase4_reservation_operation_digest_check
    CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT meri_phase4_reservation_operation_idempotency_check
    CHECK (idempotency_key ~ '^[!-~]{1,200}$'),
  CONSTRAINT meri_phase4_reservation_operation_route_check CHECK (
    worker_audience = 'meri-hermes-scope-worker' AND
    worker_ingress_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    worker_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    worker_credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT meri_phase4_reservation_operation_window_check CHECK (
    delivery_not_before_epoch_micros > 0 AND
    retain_until_epoch_micros > delivery_not_before_epoch_micros AND
    (sealed_at_epoch_micros IS NULL OR (
      sealed_at_epoch_micros >= delivery_not_before_epoch_micros AND
      sealed_at_epoch_micros < retain_until_epoch_micros
    ))
  ),
  CONSTRAINT meri_phase4_reservation_operation_outcome_check CHECK (
    (outcome = 'reserved' AND worker_run_id ~ '^[!-~]{1,120}$' AND
      sealed_at_epoch_micros IS NULL) OR
    (outcome = 'sealed_absent' AND worker_run_id IS NULL AND
      sealed_at_epoch_micros IS NOT NULL)
  )
);

CREATE TABLE public.meri_phase4_reservation_recovery_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version smallint NOT NULL,
  receipt_purpose varchar(64) NOT NULL,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  request_sha256 char(64) NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  worker_audience varchar(64) NOT NULL,
  worker_ingress_id varchar(128) NOT NULL,
  worker_generation varchar(128) NOT NULL,
  worker_credential_id varchar(128) NOT NULL,
  delivery_not_before_epoch_micros bigint NOT NULL,
  retain_until_epoch_micros bigint NOT NULL,
  outcome varchar(16) NOT NULL,
  worker_run_id varchar(120),
  worker_status varchar(32),
  sealed_at_epoch_micros bigint,
  operation_id uuid NOT NULL,
  attempt_nonce varchar(22) NOT NULL,
  command_key_id varchar(128) NOT NULL,
  command_sha256 char(64) NOT NULL,
  native_request_body_sha256 char(64) NOT NULL,
  native_response_body_sha256 char(64) NOT NULL,
  receipt_sha256 char(64) NOT NULL,
  native_http_status smallint NOT NULL,
  issued_at_epoch_micros bigint NOT NULL,
  expires_at_epoch_micros bigint NOT NULL,
  observed_at_epoch_micros bigint NOT NULL,
  key_id varchar(128) NOT NULL,
  signature varchar(43) NOT NULL,
  persisted_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_phase4_reservation_receipt_digest_key
    UNIQUE (tenant_id, receipt_sha256),
  CONSTRAINT meri_phase4_reservation_receipt_attempt_key
    UNIQUE (tenant_id, attempt_nonce),
  CONSTRAINT meri_phase4_reservation_receipt_signature_key
    UNIQUE (tenant_id, key_id, signature),
  CONSTRAINT meri_phase4_reservation_receipt_operation_fk FOREIGN KEY (
    tenant_id, operation_id, run_id, request_sha256, idempotency_key,
    worker_audience, worker_ingress_id, worker_generation,
    worker_credential_id, delivery_not_before_epoch_micros,
    retain_until_epoch_micros, outcome, worker_run_id, sealed_at_epoch_micros
  ) REFERENCES public.meri_phase4_reservation_recovery_operations (
    tenant_id, operation_id, run_id, request_sha256, idempotency_key,
    worker_audience, worker_ingress_id, worker_generation,
    worker_credential_id, delivery_not_before_epoch_micros,
    retain_until_epoch_micros, outcome, worker_run_id, sealed_at_epoch_micros
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meri_phase4_reservation_receipt_protocol_check CHECK (
    contract_version = 1 AND
    receipt_purpose = 'meri-hermes-reservation-receipt'
  ),
  CONSTRAINT meri_phase4_reservation_receipt_digest_check CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$' AND
    command_sha256 ~ '^[0-9a-f]{64}$' AND
    native_request_body_sha256 =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' AND
    native_response_body_sha256 ~ '^[0-9a-f]{64}$' AND
    receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT meri_phase4_reservation_receipt_idempotency_check
    CHECK (idempotency_key ~ '^[!-~]{1,200}$'),
  CONSTRAINT meri_phase4_reservation_receipt_route_check CHECK (
    worker_audience = 'meri-hermes-scope-worker' AND
    worker_ingress_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    worker_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    worker_credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT meri_phase4_reservation_receipt_nonce_check
    CHECK (attempt_nonce ~ '^[A-Za-z0-9_-]{21}[AQgw]$'),
  CONSTRAINT meri_phase4_reservation_receipt_key_check CHECK (
    command_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    signature ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
  ),
  CONSTRAINT meri_phase4_reservation_receipt_window_check CHECK (
    delivery_not_before_epoch_micros > 0 AND
    issued_at_epoch_micros >= delivery_not_before_epoch_micros AND
    expires_at_epoch_micros > issued_at_epoch_micros AND
    expires_at_epoch_micros - issued_at_epoch_micros <= 60000000 AND
    observed_at_epoch_micros >= issued_at_epoch_micros AND
    observed_at_epoch_micros < expires_at_epoch_micros AND
    retain_until_epoch_micros > delivery_not_before_epoch_micros
  ),
  CONSTRAINT meri_phase4_reservation_receipt_outcome_check CHECK (
    native_http_status = 200 AND (
      (outcome = 'reserved' AND worker_run_id ~ '^[!-~]{1,120}$' AND
        worker_status IN (
          'queued', 'provisioning', 'running', 'waiting_for_approval',
          'waiting_for_clarification', 'cancelling', 'completed', 'cancelled',
          'failed', 'interrupted', 'expired'
        ) AND sealed_at_epoch_micros IS NULL) OR
      (outcome = 'sealed_absent' AND worker_run_id IS NULL AND
        worker_status IS NULL AND
        sealed_at_epoch_micros >= delivery_not_before_epoch_micros AND
        sealed_at_epoch_micros <= observed_at_epoch_micros AND
        sealed_at_epoch_micros < retain_until_epoch_micros)
    )
  )
);

COMMENT ON TABLE public.meri_phase4_reservation_recovery_operations IS
  'Append-only provenance anchors for authority-fenced late-ID binding or authenticated absence sealing.';
COMMENT ON TABLE public.meri_phase4_reservation_recovery_receipts IS
  'Append-only exact signed reservation receipts; an ordinary claimed intent is never retroactively treated as recovered.';
COMMENT ON COLUMN public.meri_phase4_reservation_recovery_receipts.receipt_sha256 IS
  'SHA-256 of the exact ASCII mhrqr1 token; token and secret bytes are not stored.';

ALTER TABLE public.meri_phase4_reservation_recovery_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_reservation_recovery_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_reservation_operation_owner
  ON public.meri_phase4_reservation_recovery_operations
  TO PUBLIC USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

ALTER TABLE public.meri_phase4_reservation_recovery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_reservation_recovery_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_reservation_receipt_owner
  ON public.meri_phase4_reservation_recovery_receipts
  TO PUBLIC USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

CREATE FUNCTION public.meri_phase4_guard_reservation_operation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Phase 4 reservation operations are append-only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.meri_phase4_guard_reservation_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE anchored public.meri_phase4_reservation_recovery_operations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Phase 4 reservation receipts are append-only'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO STRICT anchored
  FROM public.meri_phase4_reservation_recovery_operations o
  WHERE o.tenant_id = NEW.tenant_id AND o.operation_id = NEW.operation_id
  FOR SHARE;
  IF ROW(
    anchored.run_id, anchored.request_sha256, anchored.idempotency_key,
    anchored.worker_audience, anchored.worker_ingress_id,
    anchored.worker_generation, anchored.worker_credential_id,
    anchored.delivery_not_before_epoch_micros, anchored.retain_until_epoch_micros,
    anchored.outcome, anchored.worker_run_id, anchored.sealed_at_epoch_micros
  ) IS DISTINCT FROM ROW(
    NEW.run_id, NEW.request_sha256, NEW.idempotency_key,
    NEW.worker_audience, NEW.worker_ingress_id,
    NEW.worker_generation, NEW.worker_credential_id,
    NEW.delivery_not_before_epoch_micros, NEW.retain_until_epoch_micros,
    NEW.outcome, NEW.worker_run_id, NEW.sealed_at_epoch_micros
  ) THEN
    RAISE EXCEPTION 'Phase 4 reservation receipt operation drift'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meri_phase4_reservation_operation_append_only
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.meri_phase4_reservation_recovery_operations
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_reservation_operation();
CREATE TRIGGER meri_phase4_reservation_receipt_append_only
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.meri_phase4_reservation_recovery_receipts
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_reservation_receipt();

-- The original intent state machine intentionally allows an ordinary claim
-- only before claim expiry and an ordinary absence seal only after the full
-- reconciliation horizon. Reservation recovery is different: after the
-- delivery cutoff the authenticated native authority can prove either a late
-- stable worker id or an atomically installed absence tombstone. Permit those
-- two transitions only for this package's NOLOGIN owner and only when the
-- exact append-only recovery operation is already anchored in this same
-- transaction. Application callers retain the original state machine.
CREATE OR REPLACE FUNCTION public.meri_phase4_dispatch_intent_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  db_now_epoch_micros bigint;
  reservation_anchored boolean;
BEGIN
  db_now_epoch_micros :=
    floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'prepared' OR
       NEW.worker_run_id IS NOT NULL OR
       NEW.claimed_at_epoch_micros IS NOT NULL OR
       NEW.sealed_absent_at_epoch_micros IS NOT NULL OR
       NEW.absence_proof_sha256 IS NOT NULL OR
       NEW.tombstoned_at_epoch_micros IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch intent must be inserted prepared'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dispatch intent deletion is disabled'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
      NEW.run_id, NEW.tenant_id, NEW.identity_version,
      NEW.actor_type, NEW.actor_id, NEW.meri_audience,
      NEW.client_id, NEW.workspace_id, NEW.scope_id,
      NEW.conversation_id, NEW.user_message_id, NEW.idempotency_key,
      NEW.conversation_epoch, NEW.worker_audience, NEW.worker_ingress_id,
      NEW.worker_generation, NEW.worker_credential_id,
      NEW.authorization_version, NEW.authorization_policy_version,
      NEW.grant_version, NEW.catalog_digest, NEW.tool_view_digest,
      NEW.session_header_key_id, NEW.claim_not_after_epoch_micros,
      NEW.delivery_not_after_epoch_micros,
      NEW.worker_credential_not_after_epoch_micros,
      NEW.reconciliation_not_after_epoch_micros,
      NEW.retain_until_epoch_micros, NEW.body_length_bytes,
      NEW.body_sha256, NEW.session_header_hmac_sha256,
      NEW.request_sha256, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.run_id, OLD.tenant_id, OLD.identity_version,
      OLD.actor_type, OLD.actor_id, OLD.meri_audience,
      OLD.client_id, OLD.workspace_id, OLD.scope_id,
      OLD.conversation_id, OLD.user_message_id, OLD.idempotency_key,
      OLD.conversation_epoch, OLD.worker_audience, OLD.worker_ingress_id,
      OLD.worker_generation, OLD.worker_credential_id,
      OLD.authorization_version, OLD.authorization_policy_version,
      OLD.grant_version, OLD.catalog_digest, OLD.tool_view_digest,
      OLD.session_header_key_id, OLD.claim_not_after_epoch_micros,
      OLD.delivery_not_after_epoch_micros,
      OLD.worker_credential_not_after_epoch_micros,
      OLD.reconciliation_not_after_epoch_micros,
      OLD.retain_until_epoch_micros, OLD.body_length_bytes,
      OLD.body_sha256, OLD.session_header_hmac_sha256,
      OLD.request_sha256, OLD.created_at
    ) THEN
    RAISE EXCEPTION 'dispatch intent identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF current_user = 'meri_phase4_authority_owner' AND
     OLD.state = 'prepared' AND NEW.state IN ('claimed', 'sealed_absent') THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.meri_phase4_reservation_recovery_operations o
      WHERE o.tenant_id = OLD.tenant_id
        AND o.run_id = OLD.run_id
        AND o.request_sha256 = OLD.request_sha256
        AND o.idempotency_key = OLD.idempotency_key
        AND o.worker_audience = OLD.worker_audience
        AND o.worker_ingress_id = OLD.worker_ingress_id
        AND o.worker_generation = OLD.worker_generation
        AND o.worker_credential_id = OLD.worker_credential_id
        AND o.delivery_not_before_epoch_micros = OLD.delivery_not_after_epoch_micros
        AND o.retain_until_epoch_micros = OLD.retain_until_epoch_micros
        AND o.outcome = CASE NEW.state
          WHEN 'claimed' THEN 'reserved' ELSE 'sealed_absent' END
        AND o.worker_run_id IS NOT DISTINCT FROM NEW.worker_run_id
        AND (NEW.state <> 'sealed_absent' OR
          o.sealed_at_epoch_micros <= db_now_epoch_micros)
    ) INTO reservation_anchored;

    IF NOT reservation_anchored OR
       db_now_epoch_micros < OLD.delivery_not_after_epoch_micros OR
       db_now_epoch_micros >= OLD.reconciliation_not_after_epoch_micros OR
       db_now_epoch_micros >= OLD.retain_until_epoch_micros OR
       NEW.tombstoned_at_epoch_micros IS NOT NULL OR
       (NEW.state = 'claimed' AND (
         NEW.worker_run_id IS NULL OR btrim(NEW.worker_run_id) = '' OR
         NEW.sealed_absent_at_epoch_micros IS NOT NULL OR
         NEW.absence_proof_sha256 IS NOT NULL)) OR
       (NEW.state = 'sealed_absent' AND (
         NEW.worker_run_id IS NOT NULL OR
         NEW.claimed_at_epoch_micros IS NOT NULL OR
         NEW.absence_proof_sha256 IS NULL OR
         NEW.absence_proof_sha256 !~ '^[0-9a-f]{64}$')) THEN
      RAISE EXCEPTION 'reservation recovery transition is closed or malformed'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.state = 'claimed' THEN
      NEW.claimed_at_epoch_micros := db_now_epoch_micros;
    ELSE
      NEW.sealed_absent_at_epoch_micros := db_now_epoch_micros;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state = 'prepared' AND NEW.state = 'claimed' THEN
    IF db_now_epoch_micros >= OLD.claim_not_after_epoch_micros OR
       NEW.worker_run_id IS NULL OR btrim(NEW.worker_run_id) = '' OR
       NEW.sealed_absent_at_epoch_micros IS NOT NULL OR
       NEW.absence_proof_sha256 IS NOT NULL OR
       NEW.tombstoned_at_epoch_micros IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch claim is closed or malformed'
        USING ERRCODE = '55000';
    END IF;
    NEW.claimed_at_epoch_micros := db_now_epoch_micros;
    RETURN NEW;
  END IF;

  IF OLD.state = 'prepared' AND NEW.state = 'sealed_absent' THEN
    IF db_now_epoch_micros <= OLD.reconciliation_not_after_epoch_micros OR
       NEW.worker_run_id IS NOT NULL OR
       NEW.claimed_at_epoch_micros IS NOT NULL OR
       NEW.absence_proof_sha256 IS NULL OR
       NEW.absence_proof_sha256 !~ '^[0-9a-f]{64}$' OR
       NEW.tombstoned_at_epoch_micros IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch absence cannot be sealed yet or is malformed'
        USING ERRCODE = '55000';
    END IF;
    NEW.sealed_absent_at_epoch_micros := db_now_epoch_micros;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('claimed', 'sealed_absent') AND
     NEW.state = OLD.state AND
     OLD.tombstoned_at_epoch_micros IS NULL AND
     NEW.tombstoned_at_epoch_micros IS NOT NULL AND
     ROW(NEW.worker_run_id, NEW.claimed_at_epoch_micros,
         NEW.sealed_absent_at_epoch_micros, NEW.absence_proof_sha256)
       IS NOT DISTINCT FROM
       ROW(OLD.worker_run_id, OLD.claimed_at_epoch_micros,
           OLD.sealed_absent_at_epoch_micros, OLD.absence_proof_sha256) AND
     db_now_epoch_micros >= OLD.retain_until_epoch_micros THEN
    NEW.tombstoned_at_epoch_micros := db_now_epoch_micros;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'dispatch intent state transition is forbidden'
    USING ERRCODE = '55000';
END;
$$;

-- PostgreSQL row locks require UPDATE privilege even when the caller only
-- reads. Keep mutation privilege away from the recovery owner by exposing one
-- fixed, tenant-bound lock/read routine. The migration executor owns this
-- SECURITY DEFINER function; only the NOLOGIN recovery owner may execute it.
CREATE FUNCTION public.meri_phase4_lock_reservation_recovery_source(
  p_tenant_id uuid,
  p_run_id uuid
) RETURNS TABLE (
  run_id uuid,
  tenant_id uuid,
  scope_id varchar,
  actor_id uuid,
  conversation_id uuid,
  user_message_id uuid,
  idempotency_key varchar,
  run_status varchar,
  dispatch_status varchar,
  existing_worker_run_id varchar,
  stop_requested_at timestamptz,
  envelope_authorization_version text,
  scope_principal_type varchar,
  scope_principal_id varchar,
  scope_kind varchar,
  scope_authorization_version varchar,
  conversation_user_id uuid,
  conversation_client_id uuid,
  conversation_workspace_id uuid,
  conversation_epoch_text text,
  message_tenant_id uuid,
  message_user_id uuid,
  message_client_id uuid,
  message_conversation_id uuid,
  message_role text,
  message_body text,
  message_metadata_jsonb jsonb
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF nullif(current_setting('app.current_tenant', true), '') IS DISTINCT FROM
       p_tenant_id::text OR
     current_setting('role', true) IS DISTINCT FROM 'meri_phase4_authority_owner' THEN
    RAISE EXCEPTION 'reservation recovery source authority is unavailable'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT
      r.id, r.tenant_id, r.scope_id, r.actor_id,
      r.conversation_id, r.user_message_id, r.idempotency_key,
      r.status, r.dispatch_status, r.hermes_run_id, r.stop_requested_at,
      r.envelope_jsonb->>'authorizationVersion',
      s.principal_type, s.principal_id, s.kind, s.authorization_version,
      c.user_id, c.client_id, c.workspace_id,
      c.metadata_jsonb #>> '{hermes,sessionEpoch}',
      m.tenant_id, m.user_id, m.client_id, m.conversation_id,
      m.role, m.body, m.metadata_jsonb
    FROM public.meri_agent_runs r
    JOIN public.meri_execution_scopes s
      ON s.id = r.scope_id AND s.tenant_id = r.tenant_id
    JOIN public.clio_conversations c
      ON c.id = r.conversation_id AND c.tenant_id = r.tenant_id
    JOIN public.clio_messages m
      ON m.id = r.user_message_id AND m.tenant_id = r.tenant_id
    WHERE r.tenant_id = p_tenant_id AND r.id = p_run_id
    FOR UPDATE OF r, s, c, m;
END;
$$;

ALTER TABLE public.meri_phase4_reservation_recovery_operations
  OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_reservation_recovery_receipts
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_reservation_operation()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_reservation_receipt()
  OWNER TO meri_phase4_authority_owner;

-- The NOLOGIN owner receives only the rows/columns needed by the dormant
-- atomic commit. capiro_app and the route operator get no new path.
GRANT SELECT ON TABLE public.meri_agent_runs,
  public.meri_agent_dispatch_intents TO meri_phase4_authority_owner;
GRANT UPDATE (hermes_run_id) ON TABLE public.meri_agent_runs
  TO meri_phase4_authority_owner;
GRANT UPDATE (state, worker_run_id, absence_proof_sha256)
  ON TABLE public.meri_agent_dispatch_intents TO meri_phase4_authority_owner;

REVOKE ALL ON TABLE public.meri_phase4_reservation_recovery_operations,
  public.meri_phase4_reservation_recovery_receipts
  FROM PUBLIC, capiro_app, meri_phase4_route_operator;
REVOKE ALL ON FUNCTION public.meri_phase4_guard_reservation_operation(),
  public.meri_phase4_guard_reservation_receipt(),
  public.meri_phase4_lock_reservation_recovery_source(uuid,uuid)
  FROM PUBLIC, capiro_app, meri_phase4_route_operator;
GRANT EXECUTE ON FUNCTION
  public.meri_phase4_lock_reservation_recovery_source(uuid,uuid)
  TO meri_phase4_authority_owner;

CREATE FUNCTION public.meri_phase4_reservation_default_acl_probe() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS 'SELECT 1';
DO $$
DECLARE exposure text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    WHERE p.oid = 'public.meri_phase4_reservation_default_acl_probe()'::regprocedure
      AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'new reservation routines inherit PUBLIC EXECUTE'
      USING ERRCODE = '42501';
  END IF;
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname)
    INTO exposure
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'
      AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend dep JOIN pg_extension ext ON ext.oid = dep.refobjid
        WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'e'
          AND ext.extname IN ('pgcrypto', 'uuid-ossp', 'vector', 'pg_trgm', 'citext')
      );
  IF exposure IS NOT NULL THEN
    RAISE EXCEPTION 'unsafe PUBLIC routine after reservation migration: %', exposure
      USING ERRCODE = '42501';
  END IF;
END $$;
DROP FUNCTION public.meri_phase4_reservation_default_acl_probe();

REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;
DO $$ BEGIN
  EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user);
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
       OR m.member = 'meri_phase4_authority_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner membership survived reservation migration'
      USING ERRCODE = '42501';
  END IF;
  IF has_schema_privilege('meri_phase4_authority_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Phase 4 authority owner retained schema CREATE after reservation migration'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMIT;
