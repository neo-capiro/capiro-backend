-- Phase 4 verified recovery-outcome application authority.
--
-- Already-verified signed receipts are the only input to this authority.  The
-- migration installs no LOGIN, scheduler, transport, verifier, or key access.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_authority_owner') OR
     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_recovery_operator') THEN
    RAISE EXCEPTION 'Phase 4 authority roles are unavailable' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname IN (
      'meri_phase4_authority_owner', 'meri_phase4_recovery_operator'
    ) AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR
           rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority role has unsafe attributes'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_recovery_operator'::regrole
    ) OR m.member IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_recovery_operator'::regrole
    )
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority membership pre-existed outcome migration'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'outcome migration executor cannot acquire owner authority'
      USING ERRCODE = '42501';
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
      AND m.member = current_user::regrole AND m.grantor = current_user::regrole
  ) THEN
    RAISE EXCEPTION 'outcome owner authority was not self-granted'
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

-- The display projection is bound to the exact signed native receipt.  It is
-- deliberately separate from the receipt because signatures authenticate a
-- native-body digest, not a reparsed/re-serialized JSON value.
ALTER TABLE public.meri_phase4_dispatch_recovery_receipts
  ADD CONSTRAINT meri_p4_dispatch_receipt_display_fk_key UNIQUE (
    receipt_id, tenant_id, run_id, operation_id, attempt_nonce,
    native_response_body_sha256, worker_status
  );

CREATE TABLE public.meri_phase4_recovery_display_receipts (
  receipt_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  attempt_nonce varchar(22) NOT NULL,
  native_response_body_sha256 char(64) NOT NULL,
  worker_status varchar(32) NOT NULL,
  hermes_session_id varchar(120),
  output_text text,
  error_text text,
  usage_jsonb jsonb,
  display_state varchar(16) NOT NULL,
  persisted_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_p4_recovery_display_exact_receipt_fk FOREIGN KEY (
    receipt_id, tenant_id, run_id, operation_id, attempt_nonce,
    native_response_body_sha256, worker_status
  ) REFERENCES public.meri_phase4_dispatch_recovery_receipts (
    receipt_id, tenant_id, run_id, operation_id, attempt_nonce,
    native_response_body_sha256, worker_status
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meri_p4_recovery_display_shape_check CHECK (
    attempt_nonce ~ '^[A-Za-z0-9_-]{21}[AQgw]$' AND
    native_response_body_sha256 ~ '^[0-9a-f]{64}$' AND
    worker_status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
    display_state IN ('available', 'unavailable') AND
    (display_state <> 'available' OR worker_status <> 'completed' OR
      (output_text IS NOT NULL AND octet_length(output_text) > 0))
  )
);

CREATE TABLE public.meri_phase4_recovery_outcome_applications (
  application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  receipt_id uuid,
  receipt_sha256 char(64),
  result varchar(16) NOT NULL,
  detail varchar(64) NOT NULL,
  worker_status varchar(32),
  winning_run_status varchar(32),
  event_seq integer,
  message_id uuid,
  applied_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_p4_recovery_application_obligation_key UNIQUE (obligation_id),
  CONSTRAINT meri_p4_recovery_application_obligation_fk FOREIGN KEY (obligation_id)
    REFERENCES public.meri_phase4_recovery_obligations (obligation_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meri_p4_recovery_application_shape_check CHECK (
    (receipt_sha256 IS NULL OR receipt_sha256 ~ '^[0-9a-f]{64}$') AND
    ((receipt_id IS NULL AND receipt_sha256 IS NULL) OR
      (receipt_id IS NOT NULL AND receipt_sha256 IS NOT NULL)) AND
    result IN ('applied', 'superseded', 'unresolved') AND
    (event_seq IS NULL OR event_seq > 0) AND
    (winning_run_status IS NULL OR (
      result IN ('applied', 'superseded') AND
      winning_run_status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired')
    )) AND
    (message_id IS NULL OR (result = 'applied' AND winning_run_status IS NOT NULL))
  )
);
CREATE UNIQUE INDEX meri_p4_recovery_application_terminal_winner_key
  ON public.meri_phase4_recovery_outcome_applications (run_id)
  WHERE result = 'applied' AND
    winning_run_status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired');
CREATE INDEX meri_p4_recovery_application_run_idx
  ON public.meri_phase4_recovery_outcome_applications (tenant_id, run_id, applied_at);

COMMENT ON TABLE public.meri_phase4_recovery_display_receipts IS
  'Append-only exact display projection for one verified terminal native response; completed output is publishable only from a nonempty available row.';
COMMENT ON TABLE public.meri_phase4_recovery_outcome_applications IS
  'Append-only audit of the single database transaction that consumed a verified recovery receipt and applied, superseded, or alarmed it.';

ALTER TABLE public.meri_phase4_recovery_display_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_recovery_display_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_p4_recovery_display_owner
  ON public.meri_phase4_recovery_display_receipts TO PUBLIC
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

ALTER TABLE public.meri_phase4_recovery_outcome_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_recovery_outcome_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_p4_recovery_application_owner
  ON public.meri_phase4_recovery_outcome_applications TO PUBLIC
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

ALTER TABLE public.meri_phase4_recovery_obligations
  ADD COLUMN alarm_reason varchar(64),
  ADD COLUMN alarmed_at timestamptz(6),
  ADD COLUMN superseded_at timestamptz(6);
ALTER TABLE public.meri_phase4_recovery_obligations
  DROP CONSTRAINT meri_phase4_recovery_obligation_state_check;
ALTER TABLE public.meri_phase4_recovery_obligations
  ADD CONSTRAINT meri_phase4_recovery_obligation_state_check CHECK (
    (state = 'pending' AND claim_owner IS NULL AND claim_token IS NULL AND
      claim_expires_at_epoch_micros IS NULL AND completed_at IS NULL AND
      alarm_reason IS NULL AND alarmed_at IS NULL AND superseded_at IS NULL AND
      coalesce(last_outcome_kind, '') NOT IN (
        'reservation_bound_worker', 'reservation_sealed_absent',
        'dispatch_terminal', 'dispatch_nonterminal'
      )) OR
    (state = 'claimed' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND
      claim_expires_at_epoch_micros IS NOT NULL AND completed_at IS NULL AND
      alarm_reason IS NULL AND alarmed_at IS NULL AND superseded_at IS NULL AND
      coalesce(last_outcome_kind, '') NOT IN (
        'reservation_bound_worker', 'reservation_sealed_absent',
        'dispatch_terminal', 'dispatch_nonterminal'
      )) OR
    (state = 'completed' AND claim_owner IS NULL AND claim_token IS NULL AND
      claim_expires_at_epoch_micros IS NULL AND completed_at IS NOT NULL AND
      alarm_reason IS NULL AND alarmed_at IS NULL AND superseded_at IS NULL AND
      last_outcome_kind IN (
        'reservation_bound_worker', 'dispatch_terminal', 'dispatch_nonterminal'
      )) OR
    (state = 'unresolved' AND claim_owner IS NULL AND claim_token IS NULL AND
      claim_expires_at_epoch_micros IS NULL AND completed_at IS NULL AND
      alarm_reason IS NOT NULL AND alarmed_at IS NOT NULL AND superseded_at IS NULL) OR
    (state = 'superseded' AND claim_owner IS NULL AND claim_token IS NULL AND
      claim_expires_at_epoch_micros IS NULL AND completed_at IS NULL AND
      alarm_reason IS NULL AND alarmed_at IS NULL AND superseded_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION public.meri_phase4_guard_recovery_obligation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Phase 4 recovery obligations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.state IN ('completed', 'unresolved', 'superseded') OR
    ROW(
      NEW.obligation_id, NEW.tenant_id, NEW.run_id, NEW.obligation_kind,
      NEW.action, NEW.sequence, NEW.operation_id, NEW.attempt_nonce,
      NEW.native_body_bytes, NEW.expires_at_epoch_micros, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.obligation_id, OLD.tenant_id, OLD.run_id, OLD.obligation_kind,
      OLD.action, OLD.sequence, OLD.operation_id, OLD.attempt_nonce,
      OLD.native_body_bytes, OLD.expires_at_epoch_micros, OLD.created_at
    ) OR NEW.attempt_count < OLD.attempt_count
  ) THEN
    RAISE EXCEPTION 'Phase 4 recovery obligation identity or disposition is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;


-- Internal receipt-to-state transition.  EXECUTE is revoked from every caller;
-- the stable 10-argument record routine below is its only entry point, so
-- receipt completion and all visible application effects share one transaction.
-- Receipt hashes are provenance, not completion content.
CREATE FUNCTION public.meri_phase4_apply_verified_recovery_outcome_internal(
  p_obligation_id uuid,
  p_owner_id uuid,
  p_claim_token uuid,
  p_outcome_kind varchar,
  p_outcome_detail varchar
) RETURNS varchar
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  v_recovery_owner varchar(80) := 'phase4-recovery:' || p_owner_id::text;
  v_obligation public.meri_phase4_recovery_obligations%ROWTYPE;
  v_run public.meri_agent_runs%ROWTYPE;
  v_intent public.meri_agent_dispatch_intents%ROWTYPE;
  v_reservation_receipt public.meri_phase4_reservation_recovery_receipts%ROWTYPE;
  v_dispatch_receipt public.meri_phase4_dispatch_recovery_receipts%ROWTYPE;
  v_display public.meri_phase4_recovery_display_receipts%ROWTYPE;
  v_display_found boolean := false;
  v_next_action varchar(8);
  v_next_body bytea;
  v_status varchar(32);
  v_finish_reason varchar(20);
  v_event_seq integer;
  v_message_id uuid;
  v_message_body text;
BEGIN
  SELECT o.* INTO STRICT v_obligation
  FROM public.meri_phase4_recovery_obligations o
  WHERE o.obligation_id = p_obligation_id FOR UPDATE;
  IF v_obligation.state <> 'claimed' OR
     v_obligation.claim_owner IS DISTINCT FROM p_owner_id OR
     v_obligation.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Phase 4 recovery outcome claim conflict'
      USING ERRCODE = '40001';
  END IF;

  IF v_obligation.obligation_kind = 'reservation' THEN
    SELECT r.* INTO v_reservation_receipt
    FROM public.meri_phase4_reservation_recovery_receipts r
    JOIN public.meri_phase4_reservation_recovery_operations op
      ON op.tenant_id = r.tenant_id AND op.operation_id = r.operation_id AND
         op.run_id = r.run_id AND op.request_sha256 = r.request_sha256 AND
         op.idempotency_key = r.idempotency_key AND
         op.worker_audience = r.worker_audience AND
         op.worker_ingress_id = r.worker_ingress_id AND
         op.worker_generation = r.worker_generation AND
         op.worker_credential_id = r.worker_credential_id AND
         op.delivery_not_before_epoch_micros = r.delivery_not_before_epoch_micros AND
         op.retain_until_epoch_micros = r.retain_until_epoch_micros AND
         op.outcome = r.outcome AND
         op.worker_run_id IS NOT DISTINCT FROM r.worker_run_id AND
         op.sealed_at_epoch_micros IS NOT DISTINCT FROM r.sealed_at_epoch_micros
    JOIN public.meri_agent_dispatch_intents i
      ON i.tenant_id = r.tenant_id AND i.run_id = r.run_id AND
         i.request_sha256 = r.request_sha256 AND
         i.idempotency_key = r.idempotency_key AND
         i.worker_audience = r.worker_audience AND
         i.worker_ingress_id = r.worker_ingress_id AND
         i.worker_generation = r.worker_generation AND
         i.worker_credential_id = r.worker_credential_id AND
         i.delivery_not_after_epoch_micros = r.delivery_not_before_epoch_micros AND
         i.retain_until_epoch_micros = r.retain_until_epoch_micros
    WHERE r.tenant_id = v_obligation.tenant_id AND
      r.run_id = v_obligation.run_id AND
      r.operation_id = v_obligation.operation_id AND
      r.attempt_nonce = v_obligation.attempt_nonce AND
      r.native_request_body_sha256 =
        encode(public.digest(v_obligation.native_body_bytes, 'sha256'), 'hex') AND
      ((p_outcome_kind = 'reservation_bound_worker' AND
        p_outcome_detail = 'reserved' AND r.outcome = 'reserved') OR
       (p_outcome_kind = 'reservation_sealed_absent' AND
        p_outcome_detail = 'sealed_absent' AND r.outcome = 'sealed_absent'));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phase 4 exact reservation receipt is unavailable'
        USING ERRCODE = '23503';
    END IF;

    IF p_outcome_kind = 'reservation_sealed_absent' THEN
      -- sealed_absent proves admission absence only; it cannot terminalize a run.
      UPDATE public.meri_phase4_recovery_obligations
        SET state = 'unresolved', claim_owner = NULL, claim_token = NULL,
            claim_expires_at_epoch_micros = NULL,
            last_outcome_kind = p_outcome_kind,
            last_outcome_detail = p_outcome_detail,
            receipt_operation_id = operation_id,
            receipt_attempt_nonce = attempt_nonce,
            alarm_reason = 'reservation_sealed_absent',
            alarmed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE obligation_id = p_obligation_id;
      INSERT INTO public.meri_phase4_recovery_outcome_applications (
        obligation_id, tenant_id, run_id, receipt_id, receipt_sha256,
        result, detail, worker_status
      ) VALUES (
        p_obligation_id, v_obligation.tenant_id, v_obligation.run_id,
        v_reservation_receipt.receipt_id, v_reservation_receipt.receipt_sha256,
        'unresolved', 'reservation_sealed_absent', v_reservation_receipt.worker_status
      );
      RETURN 'unresolved';
    END IF;

    SELECT r.* INTO STRICT v_run FROM public.meri_agent_runs r
    WHERE r.tenant_id = v_obligation.tenant_id AND r.id = v_obligation.run_id
    FOR UPDATE;
    SELECT i.* INTO STRICT v_intent FROM public.meri_agent_dispatch_intents i
    WHERE i.tenant_id = v_obligation.tenant_id AND i.run_id = v_obligation.run_id
    FOR UPDATE;

    IF v_intent.state <> 'claimed' OR
       v_intent.worker_run_id IS DISTINCT FROM v_reservation_receipt.worker_run_id OR
       (v_run.hermes_run_id IS NOT NULL AND
        v_run.hermes_run_id IS DISTINCT FROM v_reservation_receipt.worker_run_id) THEN
      UPDATE public.meri_phase4_recovery_obligations
        SET state = 'unresolved', claim_owner = NULL, claim_token = NULL,
            claim_expires_at_epoch_micros = NULL,
            last_outcome_kind = p_outcome_kind,
            last_outcome_detail = p_outcome_detail,
            receipt_operation_id = operation_id,
            receipt_attempt_nonce = attempt_nonce,
            alarm_reason = 'reservation_binding_conflict',
            alarmed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE obligation_id = p_obligation_id;
      INSERT INTO public.meri_phase4_recovery_outcome_applications (
        obligation_id, tenant_id, run_id, receipt_id, receipt_sha256,
        result, detail, worker_status
      ) VALUES (
        p_obligation_id, v_obligation.tenant_id, v_obligation.run_id,
        v_reservation_receipt.receipt_id, v_reservation_receipt.receipt_sha256,
        'unresolved', 'reservation_binding_conflict', v_reservation_receipt.worker_status
      );
      RETURN 'unresolved';
    END IF;

    IF v_run.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
       v_run.consumer_id IS NOT NULL AND
       v_run.consumer_id IS DISTINCT FROM v_recovery_owner AND
       (v_run.consumer_heartbeat_at >= clock_timestamp() - interval '60 seconds' OR
        (v_run.consumer_heartbeat_at IS NULL AND
         v_run.updated_at >= clock_timestamp() - interval '60 seconds')) THEN
      RAISE EXCEPTION 'Phase 4 recovery run consumer lease is fresh'
        USING ERRCODE = '40001';
    END IF;

    UPDATE public.meri_agent_runs
      SET consumer_id = CASE
            WHEN status IN ('completed','cancelled','failed','interrupted','expired')
              THEN consumer_id ELSE v_recovery_owner END,
          consumer_heartbeat_at = CASE
            WHEN status IN ('completed','cancelled','failed','interrupted','expired')
              THEN consumer_heartbeat_at ELSE clock_timestamp() END,
          hermes_run_id = v_reservation_receipt.worker_run_id,
          dispatch_status = 'dispatched', updated_at = clock_timestamp()
    WHERE tenant_id = v_obligation.tenant_id AND id = v_obligation.run_id;

    IF v_run.stop_requested_at IS NOT NULL OR v_run.status = 'cancelling' OR
       v_run.status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') THEN
      v_next_action := 'stop';
      v_next_body := convert_to('{}', 'UTF8');
    ELSE
      v_next_action := 'status';
      v_next_body := ''::bytea;
    END IF;
    IF v_now < v_obligation.expires_at_epoch_micros THEN
      INSERT INTO public.meri_phase4_recovery_obligations (
        obligation_id, tenant_id, run_id, obligation_kind, action, sequence,
        operation_id, attempt_nonce, native_body_bytes,
        next_attempt_at_epoch_micros, expires_at_epoch_micros
      ) SELECT n.id, v_obligation.tenant_id, v_obligation.run_id, 'dispatch',
          v_next_action, v_obligation.sequence + 1, n.id,
          rtrim(translate(encode(gen_random_bytes(16), 'base64'), '+/', '-_'), '='),
          v_next_body, v_now, v_obligation.expires_at_epoch_micros
        FROM (SELECT gen_random_uuid() AS id) n
      ON CONFLICT DO NOTHING;
    END IF;
    UPDATE public.meri_agent_runs
      SET consumer_id = NULL, consumer_heartbeat_at = NULL, updated_at = clock_timestamp()
    WHERE tenant_id = v_obligation.tenant_id AND id = v_obligation.run_id AND
      consumer_id = v_recovery_owner;
    UPDATE public.meri_phase4_recovery_obligations
      SET state = 'completed', claim_owner = NULL, claim_token = NULL,
          claim_expires_at_epoch_micros = NULL,
          last_outcome_kind = p_outcome_kind,
          last_outcome_detail = p_outcome_detail,
          receipt_operation_id = operation_id,
          receipt_attempt_nonce = attempt_nonce,
          updated_at = clock_timestamp(), completed_at = clock_timestamp()
    WHERE obligation_id = p_obligation_id;
    INSERT INTO public.meri_phase4_recovery_outcome_applications (
      obligation_id, tenant_id, run_id, receipt_id, receipt_sha256,
      result, detail, worker_status
    ) VALUES (
      p_obligation_id, v_obligation.tenant_id, v_obligation.run_id,
      v_reservation_receipt.receipt_id, v_reservation_receipt.receipt_sha256,
      'applied', 'reservation_bound_worker', v_reservation_receipt.worker_status
    );
    RETURN 'applied';
  END IF;

  -- Dispatch receipts are accepted only through the full immutable route and
  -- request identity and the digest of the exact obligation body bytes.
  SELECT r.* INTO v_dispatch_receipt
  FROM public.meri_phase4_dispatch_recovery_receipts r
  JOIN public.meri_phase4_dispatch_recovery_operations op
    ON op.tenant_id = r.tenant_id AND op.operation_id = r.operation_id AND
       op.run_id = r.run_id AND op.request_sha256 = r.request_sha256 AND
       op.worker_run_id = r.worker_run_id AND
       op.worker_audience = r.worker_audience AND
       op.worker_ingress_id = r.worker_ingress_id AND
       op.worker_generation = r.worker_generation AND
       op.worker_credential_id = r.worker_credential_id AND op.action = r.action
  JOIN public.meri_agent_dispatch_intents i
    ON i.tenant_id = r.tenant_id AND i.run_id = r.run_id AND
       i.request_sha256 = r.request_sha256 AND i.worker_run_id = r.worker_run_id AND
       i.worker_audience = r.worker_audience AND
       i.worker_ingress_id = r.worker_ingress_id AND
       i.worker_generation = r.worker_generation AND
       i.worker_credential_id = r.worker_credential_id
  WHERE r.tenant_id = v_obligation.tenant_id AND
    r.run_id = v_obligation.run_id AND
    r.operation_id = v_obligation.operation_id AND
    r.attempt_nonce = v_obligation.attempt_nonce AND
    r.action = v_obligation.action AND
    r.native_request_body_sha256 =
      encode(public.digest(v_obligation.native_body_bytes, 'sha256'), 'hex') AND
    ((p_outcome_kind = 'dispatch_terminal' AND
      p_outcome_detail = 'run_terminal' AND r.observation = 'run_terminal') OR
     (p_outcome_kind = 'dispatch_nonterminal' AND
      p_outcome_detail IN ('run_nonterminal', 'stop_accepted') AND
      r.observation = p_outcome_detail));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phase 4 exact dispatch receipt is unavailable'
      USING ERRCODE = '23503';
  END IF;
  SELECT i.* INTO STRICT v_intent FROM public.meri_agent_dispatch_intents i
  WHERE i.tenant_id = v_dispatch_receipt.tenant_id AND
    i.run_id = v_dispatch_receipt.run_id AND
    i.request_sha256 = v_dispatch_receipt.request_sha256 AND
    i.worker_run_id = v_dispatch_receipt.worker_run_id AND
    i.worker_audience = v_dispatch_receipt.worker_audience AND
    i.worker_ingress_id = v_dispatch_receipt.worker_ingress_id AND
    i.worker_generation = v_dispatch_receipt.worker_generation AND
    i.worker_credential_id = v_dispatch_receipt.worker_credential_id;

  SELECT d.* INTO v_display
  FROM public.meri_phase4_recovery_display_receipts d
  WHERE d.receipt_id = v_dispatch_receipt.receipt_id AND
    d.tenant_id = v_dispatch_receipt.tenant_id AND
    d.run_id = v_dispatch_receipt.run_id AND
    d.operation_id = v_dispatch_receipt.operation_id AND
    d.attempt_nonce = v_dispatch_receipt.attempt_nonce AND
    d.native_response_body_sha256 = v_dispatch_receipt.native_response_body_sha256 AND
    d.worker_status = v_dispatch_receipt.worker_status AND
    d.display_state = 'available';
  v_display_found := FOUND;

  SELECT r.* INTO STRICT v_run FROM public.meri_agent_runs r
  WHERE r.tenant_id = v_obligation.tenant_id AND r.id = v_obligation.run_id
  FOR UPDATE;

  IF p_outcome_kind = 'dispatch_terminal' AND
     v_dispatch_receipt.worker_status = 'completed' AND NOT v_display_found AND
     v_run.stop_requested_at IS NULL AND v_run.status <> 'cancelling' THEN
    UPDATE public.meri_phase4_recovery_obligations
      SET state = 'unresolved', claim_owner = NULL, claim_token = NULL,
          claim_expires_at_epoch_micros = NULL,
          last_outcome_kind = p_outcome_kind,
          last_outcome_detail = p_outcome_detail,
          receipt_operation_id = operation_id,
          receipt_attempt_nonce = attempt_nonce,
          alarm_reason = 'display_receipt_unavailable',
          alarmed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE obligation_id = p_obligation_id;
    INSERT INTO public.meri_phase4_recovery_outcome_applications (
      obligation_id, tenant_id, run_id, receipt_id, receipt_sha256,
      result, detail, worker_status
    ) VALUES (
      p_obligation_id, v_obligation.tenant_id, v_obligation.run_id,
      v_dispatch_receipt.receipt_id, v_dispatch_receipt.receipt_sha256,
      'unresolved', 'display_receipt_unavailable', v_dispatch_receipt.worker_status
    );
    RETURN 'unresolved';
  END IF;

  IF v_run.status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') THEN
    UPDATE public.meri_phase4_recovery_obligations
      SET state = 'superseded', claim_owner = NULL, claim_token = NULL,
          claim_expires_at_epoch_micros = NULL,
          last_outcome_kind = p_outcome_kind,
          last_outcome_detail = p_outcome_detail,
          receipt_operation_id = operation_id,
          receipt_attempt_nonce = attempt_nonce,
          updated_at = clock_timestamp(), superseded_at = clock_timestamp()
    WHERE obligation_id = p_obligation_id;
    INSERT INTO public.meri_phase4_recovery_outcome_applications (
      obligation_id, tenant_id, run_id, receipt_id, receipt_sha256,
      result, detail, worker_status, winning_run_status
    ) VALUES (
      p_obligation_id, v_obligation.tenant_id, v_obligation.run_id,
      v_dispatch_receipt.receipt_id, v_dispatch_receipt.receipt_sha256,
      'superseded', 'run_already_terminal', v_dispatch_receipt.worker_status, v_run.status
    );
    RETURN 'superseded';
  END IF;

  IF v_run.consumer_id IS NOT NULL AND
     v_run.consumer_id IS DISTINCT FROM v_recovery_owner AND
     (v_run.consumer_heartbeat_at >= clock_timestamp() - interval '60 seconds' OR
      (v_run.consumer_heartbeat_at IS NULL AND
       v_run.updated_at >= clock_timestamp() - interval '60 seconds')) THEN
    RAISE EXCEPTION 'Phase 4 recovery run consumer lease is fresh'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.meri_agent_runs
    SET consumer_id = v_recovery_owner, consumer_heartbeat_at = clock_timestamp(),
        updated_at = clock_timestamp()
  WHERE tenant_id = v_obligation.tenant_id AND id = v_obligation.run_id AND
    status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
    (consumer_id IS NULL OR consumer_id = v_recovery_owner OR
     consumer_heartbeat_at < clock_timestamp() - interval '60 seconds' OR
     (consumer_heartbeat_at IS NULL AND
      updated_at < clock_timestamp() - interval '60 seconds'));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phase 4 recovery consumer takeover lost'
      USING ERRCODE = '40001';
  END IF;

  IF p_outcome_kind = 'dispatch_nonterminal' THEN
    IF p_outcome_detail = 'run_nonterminal' THEN
      v_status := CASE
        WHEN v_run.stop_requested_at IS NOT NULL OR v_run.status = 'cancelling'
          THEN 'cancelling' ELSE v_dispatch_receipt.worker_status END;
      UPDATE public.meri_agent_runs
        SET status = v_status, last_seq = last_seq + 1,
            consumer_id = NULL, consumer_heartbeat_at = NULL,
            updated_at = clock_timestamp()
      WHERE tenant_id = v_obligation.tenant_id AND id = v_obligation.run_id AND
        consumer_id = v_recovery_owner AND
        status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired')
      RETURNING last_seq INTO v_event_seq;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Phase 4 recovery progress fence lost'
          USING ERRCODE = '40001';
      END IF;
      INSERT INTO public.meri_agent_run_events (
        run_id, seq, kind, visibility, payload_jsonb, at
      ) VALUES (
        v_obligation.run_id, v_event_seq, 'run.status', 'public',
        jsonb_build_object('status', v_status, 'recovered', true, 'frames', '[]'::jsonb),
        clock_timestamp()
      );
    ELSE
      -- stop_accepted remains nonterminal and schedules a fresh status proof.
      UPDATE public.meri_agent_runs
        SET consumer_id = NULL, consumer_heartbeat_at = NULL,
            updated_at = clock_timestamp()
      WHERE tenant_id = v_obligation.tenant_id AND id = v_obligation.run_id AND
        consumer_id = v_recovery_owner;
    END IF;

    -- Complete the current status/Stop obligation before inserting its
    -- same-action successor; the active-obligation uniqueness fence must not
    -- silently discard the follow-up proof request.
    UPDATE public.meri_phase4_recovery_obligations
      SET state = 'completed', claim_owner = NULL, claim_token = NULL,
          claim_expires_at_epoch_micros = NULL,
          last_outcome_kind = p_outcome_kind,
          last_outcome_detail = p_outcome_detail,
          receipt_operation_id = operation_id,
          receipt_attempt_nonce = attempt_nonce,
          updated_at = clock_timestamp(), completed_at = clock_timestamp()
    WHERE obligation_id = p_obligation_id;

    IF v_now + 5000000 < v_obligation.expires_at_epoch_micros THEN
      INSERT INTO public.meri_phase4_recovery_obligations (
        obligation_id, tenant_id, run_id, obligation_kind, action, sequence,
        operation_id, attempt_nonce, native_body_bytes,
        next_attempt_at_epoch_micros, expires_at_epoch_micros
      ) SELECT n.id, v_obligation.tenant_id, v_obligation.run_id, 'dispatch',
          'status', v_obligation.sequence + 1, n.id,
          rtrim(translate(encode(gen_random_bytes(16), 'base64'), '+/', '-_'), '='),
          ''::bytea, v_now + 5000000, v_obligation.expires_at_epoch_micros
        FROM (SELECT gen_random_uuid() AS id) n
      ON CONFLICT DO NOTHING;
    END IF;
    INSERT INTO public.meri_phase4_recovery_outcome_applications (
      obligation_id, tenant_id, run_id, receipt_id, receipt_sha256,
      result, detail, worker_status, event_seq
    ) VALUES (
      p_obligation_id, v_obligation.tenant_id, v_obligation.run_id,
      v_dispatch_receipt.receipt_id, v_dispatch_receipt.receipt_sha256,
      'applied', p_outcome_detail, v_dispatch_receipt.worker_status, v_event_seq
    );
    RETURN 'applied';
  END IF;

  -- Stop wins over a late completed observation.  This is decided while the
  -- run row is locked and is rechecked by the fenced terminal UPDATE.
  IF v_dispatch_receipt.worker_status = 'completed' AND
     (v_run.stop_requested_at IS NOT NULL OR v_run.status = 'cancelling') THEN
    IF v_run.finish_reason = 'expired' THEN
      v_status := 'expired'; v_finish_reason := 'expired';
    ELSE
      v_status := 'cancelled'; v_finish_reason := 'aborted';
    END IF;
    -- A completed body arrived after durable Stop.  Ignore that late display;
    -- the sole message comes from pre-Stop durable output or a fixed Stop text.
    v_display_found := false;
    v_message_body := coalesce(
      nullif(btrim(v_run.output), ''),
      'Stopped before an answer was generated.'
    );
  ELSE
    v_status := v_dispatch_receipt.worker_status;
    v_finish_reason := CASE v_status
      WHEN 'completed' THEN 'stop'
      WHEN 'cancelled' THEN 'aborted'
      WHEN 'failed' THEN 'error'
      WHEN 'interrupted' THEN 'interrupted'
      WHEN 'expired' THEN 'expired'
    END;
  END IF;

  IF v_display_found THEN
    v_message_body := coalesce(v_display.output_text, v_display.error_text);
  END IF;
  IF v_message_body IS NOT NULL THEN
    v_message_id := gen_random_uuid();
  END IF;

  UPDATE public.meri_agent_runs
    SET status = v_status, finish_reason = v_finish_reason,
        partial = CASE
          WHEN v_dispatch_receipt.worker_status = 'completed' AND
               (v_run.stop_requested_at IS NOT NULL OR v_run.status = 'cancelling')
            THEN true
          WHEN v_status = 'completed' THEN false
          WHEN v_display_found AND v_display.output_text IS NOT NULL THEN true
          ELSE partial END,
        hermes_session_id = CASE WHEN v_display_found
          THEN coalesce(v_display.hermes_session_id, hermes_session_id)
          ELSE hermes_session_id END,
        output = CASE WHEN v_display_found AND v_display.output_text IS NOT NULL
          THEN v_display.output_text ELSE output END,
        usage_jsonb = CASE WHEN v_display_found
          THEN coalesce(v_display.usage_jsonb, usage_jsonb) ELSE usage_jsonb END,
        error = CASE WHEN v_display_found THEN v_display.error_text ELSE error END,
        assistant_message_id = coalesce(v_message_id, assistant_message_id),
        last_seq = last_seq + 1, output_seq = last_seq + 1,
        finished_at = clock_timestamp(), updated_at = clock_timestamp(),
        consumer_id = v_recovery_owner, consumer_heartbeat_at = clock_timestamp()
  WHERE tenant_id = v_obligation.tenant_id AND id = v_obligation.run_id AND
    consumer_id = v_recovery_owner AND
    status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
    (v_status <> 'completed' OR
      (stop_requested_at IS NULL AND status <> 'cancelling'))
  RETURNING last_seq INTO v_event_seq;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phase 4 recovery terminal winner fence lost'
      USING ERRCODE = '40001';
  END IF;

  -- Only the terminal transition winner may publish public artifacts.
  IF v_message_id IS NOT NULL THEN
    INSERT INTO public.clio_messages (
      id, tenant_id, user_id, client_id, conversation_id,
      role, body, metadata_jsonb, created_at
    ) VALUES (
      v_message_id, v_run.tenant_id, v_run.actor_id, v_intent.client_id,
      v_run.conversation_id, 'assistant', v_message_body,
      jsonb_strip_nulls(jsonb_build_object(
        'runtime', 'hermes', 'servedBy', 'hermes', 'meriRunId', v_run.id,
        'hermesRunId', v_dispatch_receipt.worker_run_id,
        'hermesSessionId', v_display.hermes_session_id,
        'finishReason', v_finish_reason,
        'partial', v_status <> 'completed',
        'error', v_display.error_text,
        'recovered', true,
        'recoveryReceiptId', v_dispatch_receipt.receipt_id
      )), clock_timestamp()
    );
  END IF;

  INSERT INTO public.meri_agent_run_events (
    run_id, seq, kind, visibility, payload_jsonb, at
  ) VALUES (
    v_obligation.run_id, v_event_seq, 'run.status', 'public',
    jsonb_build_object(
      'status', v_status, 'recovered', true, 'final', true,
      'frames', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'type', 'done', 'runtime', 'hermes', 'finishReason', v_finish_reason,
        'partial', v_status <> 'completed', 'messageId', v_message_id
      )))
    ), clock_timestamp()
  );
  UPDATE public.meri_phase4_recovery_obligations
    SET state = 'completed', claim_owner = NULL, claim_token = NULL,
        claim_expires_at_epoch_micros = NULL,
        last_outcome_kind = p_outcome_kind,
        last_outcome_detail = p_outcome_detail,
        receipt_operation_id = operation_id,
        receipt_attempt_nonce = attempt_nonce,
        updated_at = clock_timestamp(), completed_at = clock_timestamp()
  WHERE obligation_id = p_obligation_id;
  UPDATE public.meri_phase4_recovery_obligations
    SET state = 'superseded', claim_owner = NULL, claim_token = NULL,
        claim_expires_at_epoch_micros = NULL,
        updated_at = clock_timestamp(), superseded_at = clock_timestamp()
  WHERE tenant_id = v_obligation.tenant_id AND run_id = v_obligation.run_id AND
    obligation_id <> p_obligation_id AND state IN ('pending', 'claimed');
  INSERT INTO public.meri_phase4_recovery_outcome_applications (
    obligation_id, tenant_id, run_id, receipt_id, receipt_sha256,
    result, detail, worker_status, winning_run_status, event_seq, message_id
  ) VALUES (
    p_obligation_id, v_obligation.tenant_id, v_obligation.run_id,
    v_dispatch_receipt.receipt_id, v_dispatch_receipt.receipt_sha256,
    'applied', 'terminal_winner', v_dispatch_receipt.worker_status,
    v_status, v_event_seq, v_message_id
  );
  RETURN 'applied';
END;
$$;


CREATE FUNCTION public.meri_phase4_guard_recovery_application_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Phase 4 recovery application provenance is append-only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.meri_phase4_guard_recovery_display_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Phase 4 recovery display receipts are append-only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meri_p4_recovery_application_append_only
  BEFORE UPDATE OR DELETE ON public.meri_phase4_recovery_outcome_applications
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_recovery_application_append_only();
CREATE TRIGGER meri_p4_recovery_display_append_only
  BEFORE UPDATE OR DELETE ON public.meri_phase4_recovery_display_receipts
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_recovery_display_append_only();

-- Additional owner-only RLS paths used solely from the internal SECURITY
-- DEFINER application helper.  No tenant GUC supplied by the operator is
-- trusted for these cross-tenant mutations.
CREATE POLICY meri_p4_recovery_run_owner_update
  ON public.meri_agent_runs FOR UPDATE TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_p4_recovery_intent_owner_update
  ON public.meri_agent_dispatch_intents FOR UPDATE TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_p4_recovery_event_owner
  ON public.meri_agent_run_events TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_p4_recovery_message_owner
  ON public.clio_messages TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

-- Replacement keeps the public signature stable.  All time and freshness
-- decisions use the database clock.  A live ordinary consumer is never raced;
-- application rechecks the same fence while holding the run row lock.
CREATE OR REPLACE FUNCTION public.meri_phase4_claim_recovery_obligations(
  p_owner_id uuid,
  p_limit integer,
  p_lease_micros bigint
) RETURNS TABLE (
  obligation_id uuid,
  tenant_id uuid,
  run_id uuid,
  obligation_kind varchar,
  action varchar,
  operation_id uuid,
  attempt_nonce varchar,
  claim_token uuid,
  native_body_bytes bytea
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_now bigint;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'meri_phase4_recovery_operator' OR
     p_owner_id IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR
     p_lease_micros IS NULL OR p_lease_micros < 1000000 OR
     p_lease_micros > 300000000 THEN
    RAISE EXCEPTION 'Phase 4 recovery claim authority is unavailable'
      USING ERRCODE = '42501';
  END IF;

  v_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;

  UPDATE public.meri_phase4_recovery_obligations o
    -- expired recovery remains unresolved and alarmable; expiry is not proof.
    SET state = 'unresolved', claim_owner = NULL, claim_token = NULL,
        claim_expires_at_epoch_micros = NULL,
        alarm_reason = 'recovery_window_expired', alarmed_at = clock_timestamp(),
        updated_at = clock_timestamp()
  WHERE o.state IN ('pending', 'claimed') AND o.expires_at_epoch_micros <= v_now;

  -- A durable Stop request fences an in-flight status claim.  A new Stop uses
  -- a different operation/token, so a late status callback cannot apply.
  WITH status_to_fence AS (
    SELECT o.obligation_id
    FROM public.meri_phase4_recovery_obligations o
    JOIN public.meri_agent_dispatch_intents i
      ON i.tenant_id = o.tenant_id AND i.run_id = o.run_id
    JOIN public.meri_agent_runs r
      ON r.tenant_id = o.tenant_id AND r.id = o.run_id
    WHERE o.obligation_kind = 'dispatch' AND o.action = 'status' AND
      o.state IN ('pending', 'claimed') AND
      (r.stop_requested_at IS NOT NULL OR r.status = 'cancelling') AND
      r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
      i.state = 'claimed' AND i.worker_run_id IS NOT NULL AND
      v_now < o.expires_at_epoch_micros
    ORDER BY o.tenant_id, o.run_id, o.operation_id
    FOR UPDATE OF o SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.meri_phase4_recovery_obligations o
    SET state = 'pending', claim_owner = NULL, claim_token = NULL,
        claim_expires_at_epoch_micros = NULL, updated_at = clock_timestamp()
  FROM status_to_fence f WHERE f.obligation_id = o.obligation_id;

  INSERT INTO public.meri_phase4_recovery_obligations (
    obligation_id, tenant_id, run_id, obligation_kind, action, sequence,
    operation_id, attempt_nonce, native_body_bytes,
    next_attempt_at_epoch_micros, expires_at_epoch_micros
  )
  WITH discovered AS MATERIALIZED (
    SELECT i.tenant_id, i.run_id, 'reservation'::varchar(16) AS obligation_kind,
      NULL::varchar(8) AS action, ''::bytea AS native_body_bytes, 0 AS priority,
      least(i.reconciliation_not_after_epoch_micros,
            i.retain_until_epoch_micros) AS expires_at_epoch_micros
    FROM public.meri_agent_dispatch_intents i
    JOIN public.meri_agent_runs r
      ON r.id = i.run_id AND r.tenant_id = i.tenant_id
    WHERE i.state = 'prepared' AND i.worker_run_id IS NULL AND
      i.tombstoned_at_epoch_micros IS NULL AND
      v_now >= i.delivery_not_after_epoch_micros AND
      v_now < i.reconciliation_not_after_epoch_micros AND
      v_now < i.retain_until_epoch_micros AND
      NOT (r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
        r.consumer_id IS NOT NULL AND r.consumer_id !~ '^phase4-recovery:' AND
        (r.consumer_heartbeat_at >= clock_timestamp() - interval '60 seconds' OR
         (r.consumer_heartbeat_at IS NULL AND
          r.updated_at >= clock_timestamp() - interval '60 seconds'))) AND
      NOT EXISTS (
        SELECT 1 FROM public.meri_phase4_recovery_obligations o
        WHERE o.tenant_id = i.tenant_id AND o.run_id = i.run_id AND
          o.obligation_kind = 'reservation'
      )
    UNION ALL
    SELECT i.tenant_id, i.run_id, 'dispatch'::varchar(16), 'stop'::varchar(8),
      convert_to('{}', 'UTF8'), 1,
      least(i.reconciliation_not_after_epoch_micros, i.retain_until_epoch_micros)
    FROM public.meri_agent_dispatch_intents i
    JOIN public.meri_agent_runs r
      ON r.id = i.run_id AND r.tenant_id = i.tenant_id
    WHERE i.state = 'claimed' AND i.worker_run_id IS NOT NULL AND
      i.tombstoned_at_epoch_micros IS NULL AND
      (r.stop_requested_at IS NOT NULL OR r.status = 'cancelling' OR
       r.status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired')) AND
      v_now >= i.delivery_not_after_epoch_micros AND
      v_now < i.reconciliation_not_after_epoch_micros AND
      v_now < i.retain_until_epoch_micros AND
      NOT (r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
        r.consumer_id IS NOT NULL AND r.consumer_id !~ '^phase4-recovery:' AND
        (r.consumer_heartbeat_at >= clock_timestamp() - interval '60 seconds' OR
         (r.consumer_heartbeat_at IS NULL AND
          r.updated_at >= clock_timestamp() - interval '60 seconds'))) AND
      NOT EXISTS (
        SELECT 1 FROM public.meri_phase4_recovery_obligations o
        WHERE o.tenant_id = i.tenant_id AND o.run_id = i.run_id AND
          o.obligation_kind = 'dispatch' AND o.action = 'stop'
      )
    UNION ALL
    SELECT i.tenant_id, i.run_id, 'dispatch'::varchar(16), 'status'::varchar(8),
      ''::bytea, 2,
      least(i.reconciliation_not_after_epoch_micros, i.retain_until_epoch_micros)
    FROM public.meri_agent_dispatch_intents i
    JOIN public.meri_agent_runs r
      ON r.id = i.run_id AND r.tenant_id = i.tenant_id
    WHERE i.state = 'claimed' AND i.worker_run_id IS NOT NULL AND
      i.tombstoned_at_epoch_micros IS NULL AND r.stop_requested_at IS NULL AND
      r.status NOT IN ('cancelling', 'completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
      v_now >= i.delivery_not_after_epoch_micros AND
      v_now < i.reconciliation_not_after_epoch_micros AND
      v_now < i.retain_until_epoch_micros AND
      NOT (r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
        r.consumer_id IS NOT NULL AND r.consumer_id !~ '^phase4-recovery:' AND
        (r.consumer_heartbeat_at >= clock_timestamp() - interval '60 seconds' OR
         (r.consumer_heartbeat_at IS NULL AND
          r.updated_at >= clock_timestamp() - interval '60 seconds'))) AND
      NOT EXISTS (
        SELECT 1 FROM public.meri_phase4_recovery_obligations o
        WHERE o.tenant_id = i.tenant_id AND o.run_id = i.run_id AND
          o.obligation_kind = 'dispatch' AND o.action = 'status'
      )
  ), selected AS MATERIALIZED (
    SELECT d.* FROM discovered d
    ORDER BY d.priority, d.tenant_id, d.run_id LIMIT p_limit
  ), seeded AS MATERIALIZED (
    SELECT s.*, gen_random_uuid() AS operation_id,
      rtrim(translate(encode(gen_random_bytes(16), 'base64'), '+/', '-_'), '=')
        AS attempt_nonce
    FROM selected s
  )
  SELECT seeded.operation_id, seeded.tenant_id, seeded.run_id,
    seeded.obligation_kind, seeded.action, 0, seeded.operation_id,
    seeded.attempt_nonce, seeded.native_body_bytes, v_now,
    seeded.expires_at_epoch_micros
  FROM seeded ON CONFLICT DO NOTHING;

  RETURN QUERY
  WITH eligible AS (
    SELECT o.obligation_id
    FROM public.meri_phase4_recovery_obligations o
    JOIN public.meri_agent_runs r
      ON r.id = o.run_id AND r.tenant_id = o.tenant_id
    WHERE (o.state = 'pending' OR
      (o.state = 'claimed' AND o.claim_expires_at_epoch_micros <= v_now)) AND
      o.next_attempt_at_epoch_micros <= v_now AND o.expires_at_epoch_micros > v_now AND
      NOT (r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
        r.consumer_id IS NOT NULL AND r.consumer_id !~ '^phase4-recovery:' AND
        (r.consumer_heartbeat_at >= clock_timestamp() - interval '60 seconds' OR
         (r.consumer_heartbeat_at IS NULL AND
          r.updated_at >= clock_timestamp() - interval '60 seconds'))) AND
      NOT (o.obligation_kind = 'dispatch' AND o.action = 'status' AND (
        EXISTS (
          SELECT 1 FROM public.meri_phase4_recovery_obligations stop_work
          WHERE stop_work.tenant_id = o.tenant_id AND stop_work.run_id = o.run_id AND
            stop_work.obligation_kind = 'dispatch' AND stop_work.action = 'stop' AND
            stop_work.state IN ('pending', 'claimed')
        ) OR (
          (r.stop_requested_at IS NOT NULL OR r.status = 'cancelling') AND NOT EXISTS (
            SELECT 1 FROM public.meri_phase4_recovery_obligations accepted_stop
            WHERE accepted_stop.tenant_id = o.tenant_id AND
              accepted_stop.run_id = o.run_id AND
              accepted_stop.obligation_kind = 'dispatch' AND
              accepted_stop.action = 'stop' AND accepted_stop.state = 'completed' AND
              accepted_stop.last_outcome_kind = 'dispatch_nonterminal' AND
              accepted_stop.last_outcome_detail = 'stop_accepted'
          )
        )
      ))
    ORDER BY CASE WHEN o.obligation_kind = 'reservation' THEN 0
      WHEN o.action = 'stop' THEN 1 ELSE 2 END,
      o.tenant_id, o.run_id, o.operation_id
    FOR UPDATE OF o SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public.meri_phase4_recovery_obligations o
      SET state = 'claimed', claim_owner = p_owner_id,
          claim_token = gen_random_uuid(),
          claim_expires_at_epoch_micros = least(
            o.expires_at_epoch_micros, v_now + p_lease_micros
          ),
          attempt_count = o.attempt_count + 1, updated_at = clock_timestamp()
    FROM eligible e WHERE e.obligation_id = o.obligation_id RETURNING o.*
  )
  SELECT c.obligation_id, c.tenant_id, c.run_id, c.obligation_kind,
    c.action, c.operation_id, c.attempt_nonce, c.claim_token, c.native_body_bytes
  FROM claimed c
  ORDER BY CASE WHEN c.obligation_kind = 'reservation' THEN 0
    WHEN c.action = 'stop' THEN 1 ELSE 2 END,
    c.tenant_id, c.run_id, c.operation_id;
END;
$$;

-- Preserve the repository/boundary ABI.  A known receipt is not marked done
-- until the internal helper has applied or durably classified it in this same
-- transaction.
CREATE OR REPLACE FUNCTION public.meri_phase4_record_recovery_outcome(
  p_tenant_id uuid, p_obligation_id uuid, p_owner_id uuid, p_claim_token uuid,
  p_operation_id uuid, p_attempt_nonce varchar, p_outcome_kind varchar,
  p_receipt_operation_id uuid, p_receipt_attempt_nonce varchar,
  p_outcome_detail varchar
) RETURNS TABLE (record_result varchar)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_now bigint;
  v_delay bigint;
  v_obligation public.meri_phase4_recovery_obligations%ROWTYPE;
  v_ignored varchar;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'meri_phase4_recovery_operator' OR
     p_tenant_id IS NULL OR p_obligation_id IS NULL OR p_owner_id IS NULL OR
     p_claim_token IS NULL OR p_operation_id IS NULL OR p_attempt_nonce IS NULL OR
     p_outcome_kind IS NULL OR p_outcome_detail IS NULL THEN
    RAISE EXCEPTION 'Phase 4 recovery outcome authority is unavailable'
      USING ERRCODE = '42501';
  END IF;
  SELECT o.* INTO STRICT v_obligation
  FROM public.meri_phase4_recovery_obligations o
  WHERE o.tenant_id = p_tenant_id AND o.obligation_id = p_obligation_id
  FOR UPDATE;
  IF v_obligation.operation_id IS DISTINCT FROM p_operation_id OR
     v_obligation.attempt_nonce IS DISTINCT FROM p_attempt_nonce THEN
    RAISE EXCEPTION 'Phase 4 recovery outcome identity conflict'
      USING ERRCODE = '23505';
  END IF;
  IF (v_obligation.state IN ('pending', 'completed', 'unresolved', 'superseded') OR
      (v_obligation.state = 'claimed' AND
       v_obligation.claim_token IS DISTINCT FROM p_claim_token)) AND
     v_obligation.last_outcome_kind IS NOT DISTINCT FROM p_outcome_kind AND
     v_obligation.last_outcome_detail IS NOT DISTINCT FROM p_outcome_detail AND
     v_obligation.receipt_operation_id IS NOT DISTINCT FROM p_receipt_operation_id AND
     v_obligation.receipt_attempt_nonce IS NOT DISTINCT FROM p_receipt_attempt_nonce THEN
    record_result := 'replayed'; RETURN NEXT; RETURN;
  END IF;
  IF v_obligation.state <> 'claimed' OR
     v_obligation.claim_owner IS DISTINCT FROM p_owner_id OR
     v_obligation.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Phase 4 recovery outcome claim conflict'
      USING ERRCODE = '40001';
  END IF;

  IF v_obligation.obligation_kind = 'dispatch' AND
     v_obligation.action = 'status' AND
     EXISTS (
       SELECT 1 FROM public.meri_agent_runs r
       WHERE r.tenant_id = v_obligation.tenant_id AND r.id = v_obligation.run_id AND
         (r.stop_requested_at IS NOT NULL OR r.status = 'cancelling')
     ) AND NOT EXISTS (
       SELECT 1 FROM public.meri_phase4_recovery_obligations s
       WHERE s.tenant_id = v_obligation.tenant_id AND s.run_id = v_obligation.run_id AND
         s.obligation_kind = 'dispatch' AND s.action = 'stop' AND
         s.state = 'completed' AND s.last_outcome_kind = 'dispatch_nonterminal' AND
         s.last_outcome_detail = 'stop_accepted'
     ) THEN
    RAISE EXCEPTION 'Phase 4 recovered progress lost to durable cancellation'
      USING ERRCODE = '40001';
  END IF;

  v_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  IF p_outcome_kind IN ('unknown', 'boundary_failure') THEN
    IF p_receipt_operation_id IS NOT NULL OR p_receipt_attempt_nonce IS NOT NULL OR
       (p_outcome_kind = 'unknown' AND p_outcome_detail NOT IN (
         'invalid_request', 'context_unavailable', 'key_unavailable',
         'window_unavailable', 'transport_unconfirmed', 'receipt_unverified',
         'persistence_unconfirmed', 'absence_unproven'
       )) OR
       (p_outcome_kind = 'boundary_failure' AND p_outcome_detail NOT IN (
         'reservation_unavailable', 'dispatch_unavailable'
       )) OR
       (p_outcome_kind = 'boundary_failure' AND
        ((v_obligation.obligation_kind = 'reservation' AND
          p_outcome_detail <> 'reservation_unavailable') OR
         (v_obligation.obligation_kind = 'dispatch' AND
          p_outcome_detail <> 'dispatch_unavailable'))) OR
       (p_outcome_kind = 'unknown' AND p_outcome_detail = 'absence_unproven' AND
        v_obligation.obligation_kind <> 'dispatch') THEN
      RAISE EXCEPTION 'Phase 4 recovery nonterminal outcome is malformed'
        USING ERRCODE = '23514';
    END IF;
    IF v_obligation.expires_at_epoch_micros <= v_now THEN
      UPDATE public.meri_phase4_recovery_obligations
        SET state = 'unresolved', claim_owner = NULL, claim_token = NULL,
            claim_expires_at_epoch_micros = NULL,
            last_outcome_kind = p_outcome_kind, last_outcome_detail = p_outcome_detail,
            receipt_operation_id = NULL, receipt_attempt_nonce = NULL,
            alarm_reason = 'recovery_window_expired', alarmed_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE obligation_id = p_obligation_id;
    ELSE
      v_delay := least(60000000::bigint,
        greatest(1000000::bigint, v_obligation.attempt_count::bigint * 5000000));
      UPDATE public.meri_phase4_recovery_obligations
        SET state = 'pending', claim_owner = NULL, claim_token = NULL,
            claim_expires_at_epoch_micros = NULL,
            next_attempt_at_epoch_micros = least(expires_at_epoch_micros, v_now + v_delay),
            last_outcome_kind = p_outcome_kind, last_outcome_detail = p_outcome_detail,
            receipt_operation_id = NULL, receipt_attempt_nonce = NULL,
            updated_at = clock_timestamp()
      WHERE obligation_id = p_obligation_id;
    END IF;
    record_result := 'recorded'; RETURN NEXT; RETURN;
  END IF;

  IF p_receipt_operation_id IS DISTINCT FROM p_operation_id OR
     p_receipt_attempt_nonce IS DISTINCT FROM p_attempt_nonce THEN
    RAISE EXCEPTION 'Phase 4 recovery receipt identity conflict'
      USING ERRCODE = '23505';
  END IF;
  IF NOT (
    (p_outcome_kind = 'reservation_bound_worker' AND p_outcome_detail = 'reserved' AND
      v_obligation.obligation_kind = 'reservation' AND v_obligation.action IS NULL) OR
    (p_outcome_kind = 'reservation_sealed_absent' AND
      p_outcome_detail = 'sealed_absent' AND
      v_obligation.obligation_kind = 'reservation' AND v_obligation.action IS NULL) OR
    (p_outcome_kind = 'dispatch_terminal' AND p_outcome_detail = 'run_terminal' AND
      v_obligation.obligation_kind = 'dispatch' AND
      v_obligation.action IN ('status', 'stop')) OR
    (p_outcome_kind = 'dispatch_nonterminal' AND
      p_outcome_detail IN ('run_nonterminal', 'stop_accepted') AND
      v_obligation.obligation_kind = 'dispatch' AND
      v_obligation.action IN ('status', 'stop'))
  ) THEN
    RAISE EXCEPTION 'Phase 4 recovery verified outcome is malformed'
      USING ERRCODE = '23514';
  END IF;
  v_ignored := public.meri_phase4_apply_verified_recovery_outcome_internal(
    p_obligation_id, p_owner_id, p_claim_token, p_outcome_kind, p_outcome_detail
  );
  record_result := 'recorded'; RETURN NEXT;
END;
$$;

ALTER TABLE public.meri_phase4_recovery_display_receipts
  OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_recovery_outcome_applications
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_recovery_obligation()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_recovery_application_append_only()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_recovery_display_append_only()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_apply_verified_recovery_outcome_internal(
  uuid,uuid,uuid,varchar,varchar
) OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_claim_recovery_obligations(uuid,integer,bigint)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_record_recovery_outcome(
  uuid,uuid,uuid,uuid,uuid,varchar,varchar,uuid,varchar,varchar
) OWNER TO meri_phase4_authority_owner;

GRANT SELECT ON TABLE public.meri_agent_runs,
  public.meri_agent_dispatch_intents,
  public.meri_phase4_dispatch_recovery_operations,
  public.meri_phase4_dispatch_recovery_receipts,
  public.meri_phase4_reservation_recovery_operations,
  public.meri_phase4_reservation_recovery_receipts
  TO meri_phase4_authority_owner;
GRANT UPDATE (
  hermes_run_id, hermes_session_id, status, finish_reason, partial,
  assistant_message_id, output, usage_jsonb, error, finished_at, updated_at,
  dispatch_status, last_seq, output_seq, consumer_id, consumer_heartbeat_at
) ON TABLE public.meri_agent_runs TO meri_phase4_authority_owner;
GRANT SELECT, INSERT ON TABLE public.meri_agent_run_events,
  public.clio_messages TO meri_phase4_authority_owner;

REVOKE ALL ON TABLE public.meri_phase4_recovery_display_receipts,
  public.meri_phase4_recovery_outcome_applications
  FROM PUBLIC, capiro_app, meri_phase4_route_operator, meri_phase4_recovery_operator;
REVOKE ALL ON FUNCTION
  public.meri_phase4_guard_recovery_application_append_only(),
  public.meri_phase4_guard_recovery_display_append_only(),
  public.meri_phase4_apply_verified_recovery_outcome_internal(
    uuid,uuid,uuid,varchar,varchar
  ),
  public.meri_phase4_guard_recovery_obligation(),
  public.meri_phase4_claim_recovery_obligations(uuid,integer,bigint),
  public.meri_phase4_record_recovery_outcome(
    uuid,uuid,uuid,uuid,uuid,varchar,varchar,uuid,varchar,varchar
  ) FROM PUBLIC, capiro_app, meri_phase4_route_operator, meri_phase4_recovery_operator;
GRANT USAGE ON SCHEMA public TO meri_phase4_recovery_operator;
REVOKE CREATE ON SCHEMA public FROM meri_phase4_recovery_operator;
GRANT EXECUTE ON FUNCTION
  public.meri_phase4_claim_recovery_obligations(uuid,integer,bigint),
  public.meri_phase4_record_recovery_outcome(
    uuid,uuid,uuid,uuid,uuid,varchar,varchar,uuid,varchar,varchar
  ) TO meri_phase4_recovery_operator;

CREATE FUNCTION public.meri_phase4_outcome_default_acl_probe() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS 'SELECT 1';
DO $$
DECLARE exposure text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    WHERE p.oid = 'public.meri_phase4_outcome_default_acl_probe()'::regprocedure AND
      x.grantee = 0 AND x.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'new recovery-outcome routines inherit PUBLIC EXECUTE'
      USING ERRCODE = '42501';
  END IF;
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname)
    INTO exposure
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
  WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE' AND
    n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND
    NOT EXISTS (
      SELECT 1 FROM pg_depend dep JOIN pg_extension ext ON ext.oid = dep.refobjid
      WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND
        dep.deptype = 'e' AND
        ext.extname IN ('pgcrypto', 'uuid-ossp', 'vector', 'pg_trgm', 'citext')
    );
  IF exposure IS NOT NULL THEN
    RAISE EXCEPTION 'unsafe PUBLIC routine after recovery outcome application: %', exposure
      USING ERRCODE = '42501';
  END IF;
END $$;
DROP FUNCTION public.meri_phase4_outcome_default_acl_probe();

REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;
DO $$ BEGIN
  EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user);
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_recovery_operator'::regrole
    ) OR m.member IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_recovery_operator'::regrole
    )
  ) THEN
    RAISE EXCEPTION 'Phase 4 recovery role membership survived outcome application'
      USING ERRCODE = '42501';
  END IF;
  IF has_schema_privilege('meri_phase4_authority_owner', 'public', 'CREATE') OR
     has_schema_privilege('meri_phase4_recovery_operator', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Phase 4 recovery role retained schema CREATE'
      USING ERRCODE = '42501';
  END IF;
  IF has_table_privilege('meri_phase4_recovery_operator',
       'public.meri_phase4_recovery_display_receipts', 'SELECT,INSERT,UPDATE,DELETE') OR
     has_table_privilege('meri_phase4_recovery_operator',
       'public.meri_phase4_recovery_outcome_applications', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Phase 4 recovery operator retained direct table authority'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMIT;
