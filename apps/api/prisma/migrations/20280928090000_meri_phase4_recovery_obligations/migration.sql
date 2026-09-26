-- Dormant Phase 4 cross-replica recovery-obligation authority.
--
-- This migration installs durable discovery, claim, retry, and receipt-backed
-- completion primitives. It installs no LOGIN, caller membership, scheduler,
-- application registration, key source, transport, or production activation.
BEGIN;

-- The callable role is deliberately unusable until a later reviewed package
-- creates a separate LOGIN and grants a narrowly owned membership edge.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_recovery_operator') THEN
    CREATE ROLE meri_phase4_recovery_operator NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_recovery_operator' AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR
       rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'existing Phase 4 recovery operator has unsafe attributes'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_recovery_operator'::regrole
       OR m.member = 'meri_phase4_recovery_operator'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 recovery operator membership pre-existed migration'
      USING ERRCODE = '42501';
  END IF;
END $$;

-- Reacquire the inaccessible table owner only for DDL and ownership transfer.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
       OR m.member = 'meri_phase4_authority_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner membership pre-existed obligation migration'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'obligation migration executor cannot acquire owner authority'
      USING ERRCODE = '42501';
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
      AND m.member = current_user::regrole AND m.grantor = current_user::regrole
  ) THEN
    RAISE EXCEPTION 'obligation owner authority was not self-granted'
      USING ERRCODE = '42501';
  END IF;
END $$;

-- PostgreSQL grants PUBLIC EXECUTE to new routines by default. Close both DDL
-- owners before creating any trigger or callable authority routine.
DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO meri_phase4_authority_owner;

CREATE TABLE public.meri_phase4_recovery_obligations (
  obligation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  obligation_kind varchar(16) NOT NULL,
  action varchar(8),
  sequence integer NOT NULL DEFAULT 0,
  operation_id uuid NOT NULL,
  attempt_nonce varchar(22) NOT NULL,
  native_body_bytes bytea NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'pending',
  next_attempt_at_epoch_micros bigint NOT NULL,
  expires_at_epoch_micros bigint NOT NULL,
  claim_owner uuid,
  claim_token uuid,
  claim_expires_at_epoch_micros bigint,
  attempt_count integer NOT NULL DEFAULT 0,
  last_outcome_kind varchar(40),
  last_outcome_detail varchar(40),
  receipt_operation_id uuid,
  receipt_attempt_nonce varchar(22),
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz(6),
  CONSTRAINT meri_phase4_recovery_obligation_operation_key
    UNIQUE (tenant_id, operation_id),
  CONSTRAINT meri_phase4_recovery_obligation_identity_check CHECK (
    obligation_id = operation_id AND sequence >= 0 AND attempt_count >= 0 AND
    attempt_nonce ~ '^[A-Za-z0-9_-]{21}[AQgw]$'
  ),
  CONSTRAINT meri_phase4_recovery_obligation_shape_check CHECK (
    (obligation_kind = 'reservation' AND action IS NULL AND
      octet_length(native_body_bytes) = 0) OR
    (obligation_kind = 'dispatch' AND action = 'status' AND
      octet_length(native_body_bytes) = 0) OR
    (obligation_kind = 'dispatch' AND action = 'stop' AND
      encode(native_body_bytes, 'hex') = '7b7d')
  ),
  CONSTRAINT meri_phase4_recovery_obligation_window_check CHECK (
    next_attempt_at_epoch_micros > 0 AND
    expires_at_epoch_micros >= next_attempt_at_epoch_micros AND
    (claim_expires_at_epoch_micros IS NULL OR (
      claim_expires_at_epoch_micros > 0 AND
      claim_expires_at_epoch_micros <= expires_at_epoch_micros
    ))
  ),
  CONSTRAINT meri_phase4_recovery_obligation_outcome_check CHECK (
    (last_outcome_kind IS NULL AND last_outcome_detail IS NULL AND
      receipt_operation_id IS NULL AND receipt_attempt_nonce IS NULL) OR
    (last_outcome_kind = 'unknown' AND last_outcome_detail IN (
      'invalid_request', 'context_unavailable', 'key_unavailable',
      'window_unavailable', 'transport_unconfirmed', 'receipt_unverified',
      'persistence_unconfirmed', 'absence_unproven'
    ) AND receipt_operation_id IS NULL AND receipt_attempt_nonce IS NULL) OR
    (last_outcome_kind = 'boundary_failure' AND last_outcome_detail IN (
      'reservation_unavailable', 'dispatch_unavailable'
    ) AND receipt_operation_id IS NULL AND receipt_attempt_nonce IS NULL) OR
    (last_outcome_kind = 'reservation_bound_worker' AND
      last_outcome_detail = 'reserved' AND
      receipt_operation_id = operation_id AND receipt_attempt_nonce = attempt_nonce) OR
    (last_outcome_kind = 'reservation_sealed_absent' AND
      last_outcome_detail = 'sealed_absent' AND
      receipt_operation_id = operation_id AND receipt_attempt_nonce = attempt_nonce) OR
    (last_outcome_kind = 'dispatch_terminal' AND
      last_outcome_detail = 'run_terminal' AND
      receipt_operation_id = operation_id AND receipt_attempt_nonce = attempt_nonce) OR
    (last_outcome_kind = 'dispatch_nonterminal' AND
      last_outcome_detail IN ('run_nonterminal', 'stop_accepted') AND
      receipt_operation_id = operation_id AND receipt_attempt_nonce = attempt_nonce)
  ),
  CONSTRAINT meri_phase4_recovery_obligation_state_check CHECK (
    (state = 'pending' AND claim_owner IS NULL AND claim_token IS NULL AND
      claim_expires_at_epoch_micros IS NULL AND completed_at IS NULL AND
      coalesce(last_outcome_kind, '') NOT IN (
        'reservation_bound_worker', 'reservation_sealed_absent',
        'dispatch_terminal', 'dispatch_nonterminal'
      )) OR
    (state = 'claimed' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND
      claim_expires_at_epoch_micros IS NOT NULL AND completed_at IS NULL AND
      coalesce(last_outcome_kind, '') NOT IN (
        'reservation_bound_worker', 'reservation_sealed_absent',
        'dispatch_terminal', 'dispatch_nonterminal'
      )) OR
    (state = 'completed' AND claim_owner IS NULL AND claim_token IS NULL AND
      claim_expires_at_epoch_micros IS NULL AND completed_at IS NOT NULL AND
      last_outcome_kind IN (
        'reservation_bound_worker', 'reservation_sealed_absent',
        'dispatch_terminal', 'dispatch_nonterminal'
      ))
  )
);

CREATE UNIQUE INDEX meri_phase4_recovery_obligation_active_key
  ON public.meri_phase4_recovery_obligations (
    tenant_id, run_id, obligation_kind, coalesce(action, '')
  ) WHERE state IN ('pending', 'claimed');
CREATE INDEX meri_phase4_recovery_obligation_eligible_idx
  ON public.meri_phase4_recovery_obligations (
    state, next_attempt_at_epoch_micros, claim_expires_at_epoch_micros,
    expires_at_epoch_micros
  );
CREATE INDEX meri_phase4_recovery_obligation_run_history_idx
  ON public.meri_phase4_recovery_obligations (
    tenant_id, run_id, obligation_kind, action, sequence
  );

COMMENT ON TABLE public.meri_phase4_recovery_obligations IS
  'Dormant cross-replica recovery work. UNKNOWN preserves the same operation and nonce; only an exact persisted signed receipt completes an obligation.';
COMMENT ON COLUMN public.meri_phase4_recovery_obligations.native_body_bytes IS
  'Exact native request body: empty for reservation/status and two-byte ASCII {} for Stop.';

ALTER TABLE public.meri_phase4_recovery_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_recovery_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_recovery_obligation_owner
  ON public.meri_phase4_recovery_obligations TO PUBLIC
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

-- The owner is NOLOGIN and its only future path is through the two fixed
-- SECURITY DEFINER routines below. These SELECT-only policies allow those
-- routines to discover cross-tenant recovery work without trusting caller GUCs.
CREATE POLICY meri_phase4_recovery_run_owner_read
  ON public.meri_agent_runs FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_phase4_recovery_intent_owner_read
  ON public.meri_agent_dispatch_intents FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');

CREATE FUNCTION public.meri_phase4_guard_recovery_obligation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Phase 4 recovery obligations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.state = 'completed' OR
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
    RAISE EXCEPTION 'Phase 4 recovery obligation identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meri_phase4_recovery_obligation_guard
  BEFORE UPDATE OR DELETE ON public.meri_phase4_recovery_obligations
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_recovery_obligation();

CREATE FUNCTION public.meri_phase4_claim_recovery_obligations(
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

  -- A durable cancellation marker fences an already-claimed status operation.
  -- Its obsolete callback cannot mutate after this update because the next Stop
  -- claim receives a fresh fencing token.
  WITH status_to_fence AS (
    SELECT o.obligation_id
    FROM public.meri_phase4_recovery_obligations o
    JOIN public.meri_agent_dispatch_intents i
      ON o.tenant_id = i.tenant_id AND o.run_id = i.run_id
    JOIN public.meri_agent_runs r
      ON r.id = i.run_id AND r.tenant_id = i.tenant_id
    WHERE o.obligation_kind = 'dispatch' AND o.action = 'status' AND
      o.state IN ('pending', 'claimed') AND
      i.state = 'claimed' AND i.worker_run_id IS NOT NULL AND
      i.tombstoned_at_epoch_micros IS NULL AND
      (r.stop_requested_at IS NOT NULL OR r.status = 'cancelling') AND
      r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
      v_now >= i.delivery_not_after_epoch_micros AND
      v_now < i.reconciliation_not_after_epoch_micros AND
      v_now < i.retain_until_epoch_micros
    ORDER BY o.tenant_id, o.run_id, o.operation_id
    FOR UPDATE OF o SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.meri_phase4_recovery_obligations o
    SET state = 'pending', claim_owner = NULL, claim_token = NULL,
        claim_expires_at_epoch_micros = NULL, updated_at = clock_timestamp()
  FROM status_to_fence fenced
  WHERE o.obligation_id = fenced.obligation_id;

  -- Discover no more than the caller's bounded batch. Reservation precedes Stop,
  -- and Stop precedes status. Identity is generated only for selected rows.
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
      NOT EXISTS (
        SELECT 1 FROM public.meri_phase4_recovery_obligations o
        WHERE o.tenant_id = i.tenant_id AND o.run_id = i.run_id
          AND o.obligation_kind = 'reservation'
      )
    UNION ALL
    SELECT i.tenant_id, i.run_id, 'dispatch'::varchar(16), 'stop'::varchar(8),
      convert_to('{}', 'UTF8'), 1,
      least(i.reconciliation_not_after_epoch_micros,
            i.retain_until_epoch_micros)
    FROM public.meri_agent_dispatch_intents i
    JOIN public.meri_agent_runs r
      ON r.id = i.run_id AND r.tenant_id = i.tenant_id
    WHERE i.state = 'claimed' AND i.worker_run_id IS NOT NULL AND
      i.tombstoned_at_epoch_micros IS NULL AND
      (r.stop_requested_at IS NOT NULL OR r.status = 'cancelling') AND
      r.status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
      v_now >= i.delivery_not_after_epoch_micros AND
      v_now < i.reconciliation_not_after_epoch_micros AND
      v_now < i.retain_until_epoch_micros AND
      NOT EXISTS (
        SELECT 1 FROM public.meri_phase4_recovery_obligations o
        WHERE o.tenant_id = i.tenant_id AND o.run_id = i.run_id
          AND o.obligation_kind = 'dispatch' AND o.action = 'stop'
      )
    UNION ALL
    SELECT i.tenant_id, i.run_id, 'dispatch'::varchar(16), 'status'::varchar(8),
      ''::bytea, 2,
      least(i.reconciliation_not_after_epoch_micros,
            i.retain_until_epoch_micros)
    FROM public.meri_agent_dispatch_intents i
    JOIN public.meri_agent_runs r
      ON r.id = i.run_id AND r.tenant_id = i.tenant_id
    WHERE i.state = 'claimed' AND i.worker_run_id IS NOT NULL AND
      i.tombstoned_at_epoch_micros IS NULL AND r.stop_requested_at IS NULL AND
      r.status NOT IN ('cancelling', 'completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
      v_now >= i.delivery_not_after_epoch_micros AND
      v_now < i.reconciliation_not_after_epoch_micros AND
      v_now < i.retain_until_epoch_micros AND
      NOT EXISTS (
        SELECT 1 FROM public.meri_phase4_recovery_obligations o
        WHERE o.tenant_id = i.tenant_id AND o.run_id = i.run_id
          AND o.obligation_kind = 'dispatch' AND o.action = 'status'
      )
  ), selected AS MATERIALIZED (
    SELECT d.* FROM discovered d
    ORDER BY d.priority, d.tenant_id, d.run_id
    LIMIT p_limit
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
  FROM seeded
  ON CONFLICT DO NOTHING;

  RETURN QUERY
  WITH eligible AS (
    SELECT o.obligation_id
    FROM public.meri_phase4_recovery_obligations o
    WHERE (
      o.state = 'pending' OR
      (o.state = 'claimed' AND o.claim_expires_at_epoch_micros <= v_now)
    ) AND o.next_attempt_at_epoch_micros <= v_now AND
      o.expires_at_epoch_micros > v_now AND
      NOT (
        o.obligation_kind = 'dispatch' AND o.action = 'status' AND (
          EXISTS (
            SELECT 1 FROM public.meri_phase4_recovery_obligations stop_work
            WHERE stop_work.tenant_id = o.tenant_id AND
              stop_work.run_id = o.run_id AND
              stop_work.obligation_kind = 'dispatch' AND
              stop_work.action = 'stop' AND
              stop_work.state IN ('pending', 'claimed')
          ) OR (
            EXISTS (
              SELECT 1 FROM public.meri_agent_runs r
              WHERE r.tenant_id = o.tenant_id AND r.id = o.run_id AND
                (r.stop_requested_at IS NOT NULL OR r.status = 'cancelling')
            ) AND NOT EXISTS (
              SELECT 1 FROM public.meri_phase4_recovery_obligations accepted_stop
              WHERE accepted_stop.tenant_id = o.tenant_id AND
                accepted_stop.run_id = o.run_id AND
                accepted_stop.obligation_kind = 'dispatch' AND
                accepted_stop.action = 'stop' AND
                accepted_stop.state = 'completed' AND
                accepted_stop.last_outcome_kind = 'dispatch_nonterminal' AND
                accepted_stop.last_outcome_detail = 'stop_accepted'
            )
          )
        )
      )
    ORDER BY CASE
      WHEN o.obligation_kind = 'reservation' THEN 0
      WHEN o.action = 'stop' THEN 1 ELSE 2 END,
      o.tenant_id, o.run_id, o.operation_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.meri_phase4_recovery_obligations o
      SET state = 'claimed', claim_owner = p_owner_id,
          claim_token = gen_random_uuid(),
          claim_expires_at_epoch_micros = least(
            o.expires_at_epoch_micros, v_now + p_lease_micros
          ),
          attempt_count = o.attempt_count + 1,
          updated_at = clock_timestamp()
    FROM eligible e
    WHERE o.obligation_id = e.obligation_id
    RETURNING o.*
  )
  SELECT c.obligation_id, c.tenant_id, c.run_id, c.obligation_kind,
    c.action, c.operation_id, c.attempt_nonce, c.claim_token,
    c.native_body_bytes
  FROM claimed c
  ORDER BY CASE
    WHEN c.obligation_kind = 'reservation' THEN 0
    WHEN c.action = 'stop' THEN 1 ELSE 2 END,
    c.tenant_id, c.run_id, c.operation_id;
END;
$$;

CREATE FUNCTION public.meri_phase4_record_recovery_outcome(
  p_tenant_id uuid,
  p_obligation_id uuid,
  p_owner_id uuid,
  p_claim_token uuid,
  p_operation_id uuid,
  p_attempt_nonce varchar,
  p_outcome_kind varchar,
  p_receipt_operation_id uuid,
  p_receipt_attempt_nonce varchar,
  p_outcome_detail varchar
) RETURNS TABLE (record_result varchar)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_now bigint;
  v_obligation public.meri_phase4_recovery_obligations%ROWTYPE;
  v_receipt_exists boolean := false;
  v_delay bigint;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'meri_phase4_recovery_operator' OR
     p_tenant_id IS NULL OR p_obligation_id IS NULL OR p_owner_id IS NULL OR
     p_claim_token IS NULL OR
     p_operation_id IS NULL OR p_attempt_nonce IS NULL OR
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

  -- Exact commit-unknown replay succeeds even if another replica has since
  -- reclaimed the stable operation. It never mutates the newer claim.
  IF (v_obligation.state IN ('pending', 'completed') OR
      (v_obligation.state = 'claimed' AND
       v_obligation.claim_token IS DISTINCT FROM p_claim_token)) AND
     v_obligation.last_outcome_kind IS NOT DISTINCT FROM p_outcome_kind AND
     v_obligation.last_outcome_detail IS NOT DISTINCT FROM p_outcome_detail AND
     v_obligation.receipt_operation_id IS NOT DISTINCT FROM p_receipt_operation_id AND
     v_obligation.receipt_attempt_nonce IS NOT DISTINCT FROM p_receipt_attempt_nonce THEN
    record_result := 'replayed';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_obligation.state <> 'claimed' OR
     v_obligation.claim_owner IS DISTINCT FROM p_owner_id OR
     v_obligation.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Phase 4 recovery outcome claim conflict'
      USING ERRCODE = '40001';
  END IF;

  -- A status call already in flight loses as soon as cancellation is durable.
  -- Status may resume only after a receipt-backed Stop was accepted.
  IF v_obligation.obligation_kind = 'dispatch' AND
     v_obligation.action = 'status' AND
     EXISTS (
       SELECT 1 FROM public.meri_agent_runs r
       WHERE r.tenant_id = v_obligation.tenant_id AND
         r.id = v_obligation.run_id AND
         (r.stop_requested_at IS NOT NULL OR r.status = 'cancelling')
     ) AND NOT EXISTS (
       SELECT 1 FROM public.meri_phase4_recovery_obligations accepted_stop
       WHERE accepted_stop.tenant_id = v_obligation.tenant_id AND
         accepted_stop.run_id = v_obligation.run_id AND
         accepted_stop.obligation_kind = 'dispatch' AND
         accepted_stop.action = 'stop' AND
         accepted_stop.state = 'completed' AND
         accepted_stop.last_outcome_kind = 'dispatch_nonterminal' AND
         accepted_stop.last_outcome_detail = 'stop_accepted'
     ) THEN
    RAISE EXCEPTION 'Phase 4 recovery status lost to durable cancellation'
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
    v_delay := least(60000000::bigint,
      greatest(1000000::bigint, v_obligation.attempt_count::bigint * 5000000));
    UPDATE public.meri_phase4_recovery_obligations o
      SET state = 'pending', claim_owner = NULL, claim_token = NULL,
          claim_expires_at_epoch_micros = NULL,
          next_attempt_at_epoch_micros = least(o.expires_at_epoch_micros, v_now + v_delay),
          last_outcome_kind = p_outcome_kind,
          last_outcome_detail = p_outcome_detail,
          receipt_operation_id = NULL, receipt_attempt_nonce = NULL,
          updated_at = clock_timestamp()
    WHERE o.obligation_id = v_obligation.obligation_id;
    record_result := 'recorded';
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_receipt_operation_id IS DISTINCT FROM p_operation_id OR
     p_receipt_attempt_nonce IS DISTINCT FROM p_attempt_nonce THEN
    RAISE EXCEPTION 'Phase 4 recovery receipt identity conflict'
      USING ERRCODE = '23505';
  END IF;

  IF p_outcome_kind IN ('reservation_bound_worker', 'reservation_sealed_absent') AND
     v_obligation.obligation_kind = 'reservation' AND v_obligation.action IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.meri_phase4_reservation_recovery_receipts r
      WHERE r.tenant_id = v_obligation.tenant_id AND
        r.run_id = v_obligation.run_id AND
        r.operation_id = p_receipt_operation_id AND
        r.attempt_nonce = p_receipt_attempt_nonce AND
        r.outcome = p_outcome_detail AND
        ((p_outcome_kind = 'reservation_bound_worker' AND r.outcome = 'reserved') OR
         (p_outcome_kind = 'reservation_sealed_absent' AND r.outcome = 'sealed_absent'))
    ) INTO v_receipt_exists;
  ELSIF p_outcome_kind IN ('dispatch_terminal', 'dispatch_nonterminal') AND
        v_obligation.obligation_kind = 'dispatch' AND
        v_obligation.action IN ('status', 'stop') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.meri_phase4_dispatch_recovery_receipts r
      WHERE r.tenant_id = v_obligation.tenant_id AND
        r.run_id = v_obligation.run_id AND
        r.operation_id = p_receipt_operation_id AND
        r.attempt_nonce = p_receipt_attempt_nonce AND
        r.action = v_obligation.action AND r.observation = p_outcome_detail AND
        ((p_outcome_kind = 'dispatch_terminal' AND r.observation = 'run_terminal') OR
         (p_outcome_kind = 'dispatch_nonterminal' AND
          r.observation IN ('run_nonterminal', 'stop_accepted')))
    ) INTO v_receipt_exists;
  END IF;

  IF NOT v_receipt_exists THEN
    RAISE EXCEPTION 'Phase 4 recovery verified receipt is unavailable'
      USING ERRCODE = '23503';
  END IF;

  UPDATE public.meri_phase4_recovery_obligations o
    SET state = 'completed', claim_owner = NULL, claim_token = NULL,
        claim_expires_at_epoch_micros = NULL,
        last_outcome_kind = p_outcome_kind,
        last_outcome_detail = p_outcome_detail,
        receipt_operation_id = p_receipt_operation_id,
        receipt_attempt_nonce = p_receipt_attempt_nonce,
        updated_at = clock_timestamp(), completed_at = clock_timestamp()
  WHERE o.obligation_id = v_obligation.obligation_id;

  -- Every verified nonterminal dispatch observation advances to a fresh status
  -- operation after a bounded delay. The active partial unique index prevents
  -- a parallel seed from creating a second observation.
  IF p_outcome_kind = 'dispatch_nonterminal' AND
     v_now + 5000000 < v_obligation.expires_at_epoch_micros THEN
    WITH next_identity AS (
      SELECT gen_random_uuid() AS operation_id,
        rtrim(translate(encode(gen_random_bytes(16), 'base64'), '+/', '-_'), '=')
          AS attempt_nonce
    )
    INSERT INTO public.meri_phase4_recovery_obligations (
      obligation_id, tenant_id, run_id, obligation_kind, action, sequence,
      operation_id, attempt_nonce, native_body_bytes,
      next_attempt_at_epoch_micros, expires_at_epoch_micros
    )
    SELECT n.operation_id, v_obligation.tenant_id, v_obligation.run_id,
      'dispatch', 'status', v_obligation.sequence + 1,
      n.operation_id, n.attempt_nonce, ''::bytea,
      v_now + 5000000, v_obligation.expires_at_epoch_micros
    FROM next_identity n
    ON CONFLICT DO NOTHING;
  END IF;

  record_result := 'recorded';
  RETURN NEXT;
END;
$$;

ALTER TABLE public.meri_phase4_recovery_obligations
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_recovery_obligation()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_claim_recovery_obligations(uuid,integer,bigint)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_record_recovery_outcome(
  uuid,uuid,uuid,uuid,uuid,varchar,varchar,uuid,varchar,varchar
) OWNER TO meri_phase4_authority_owner;

GRANT SELECT ON TABLE public.meri_agent_runs,
  public.meri_agent_dispatch_intents TO meri_phase4_authority_owner;

REVOKE ALL ON TABLE public.meri_phase4_recovery_obligations
  FROM PUBLIC, capiro_app, meri_phase4_route_operator, meri_phase4_recovery_operator;
REVOKE ALL ON FUNCTION public.meri_phase4_guard_recovery_obligation(),
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

-- Negative control for the migration owner's global routine defaults, then a
-- final scan for inherited non-extension PUBLIC execution.
CREATE FUNCTION public.meri_phase4_obligation_default_acl_probe() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS 'SELECT 1';
DO $$
DECLARE exposure text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    WHERE p.oid = 'public.meri_phase4_obligation_default_acl_probe()'::regprocedure
      AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'new recovery-obligation routines inherit PUBLIC EXECUTE'
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
    RAISE EXCEPTION 'unsafe PUBLIC routine after recovery-obligation migration: %', exposure
      USING ERRCODE = '42501';
  END IF;
END $$;
DROP FUNCTION public.meri_phase4_obligation_default_acl_probe();

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
    RAISE EXCEPTION 'Phase 4 recovery role membership survived obligation migration'
      USING ERRCODE = '42501';
  END IF;
  IF has_schema_privilege('meri_phase4_authority_owner', 'public', 'CREATE') OR
     has_schema_privilege('meri_phase4_recovery_operator', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Phase 4 recovery role retained schema CREATE'
      USING ERRCODE = '42501';
  END IF;
  IF has_table_privilege('meri_phase4_recovery_operator',
       'public.meri_phase4_recovery_obligations', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Phase 4 recovery operator retained direct table authority'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMIT;
