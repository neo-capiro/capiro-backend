-- Dormant Phase 4 worker recovery receipt persistence.
--
-- This migration installs no runtime caller and grants no application role
-- table or routine access. A later, separately reviewed writer must verify the
-- v1 recovery command and receipt before attempting to persist this projection.
-- Neither a not_found receipt nor a missing receipt is proof of run absence;
-- stop_accepted is nonterminal.
BEGIN;

-- Reacquire the inaccessible authority owner only for ownership transfer.
-- Refuse to continue if any prior membership edge survived.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
       OR m.member = 'meri_phase4_authority_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner membership pre-existed recovery receipt migration'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'Phase 4 recovery receipt migration executor cannot acquire owner authority'
      USING ERRCODE = '42501';
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
      AND m.member = current_user::regrole AND m.grantor = current_user::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 recovery receipt owner authority was not self-granted'
      USING ERRCODE = '42501';
  END IF;
END $$;

-- PostgreSQL grants PUBLIC EXECUTE to new routines by default. Close the
-- global (not schema-local) defaults for both possible DDL owners before any
-- trigger routine is created.
DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT CREATE ON SCHEMA public TO meri_phase4_authority_owner;

-- A receipt must identify the same claimed worker and immutable dispatch
-- request. The composite target prevents a run_id-only FK from admitting a
-- tenant, request digest, or worker route copied from another intent.
ALTER TABLE public.meri_agent_dispatch_intents
  ADD CONSTRAINT meri_agent_dispatch_intents_recovery_identity_key UNIQUE (
    run_id, tenant_id, request_sha256, worker_run_id, worker_audience,
    worker_ingress_id, worker_generation, worker_credential_id
  );

-- One logical operation may have several retry attempts, but its exact
-- dispatch/worker identity and action may never drift between attempts.
CREATE TABLE public.meri_phase4_dispatch_recovery_operations (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  request_sha256 char(64) NOT NULL,
  worker_run_id varchar(120) NOT NULL,
  worker_audience varchar(64) NOT NULL,
  worker_ingress_id varchar(128) NOT NULL,
  worker_generation varchar(128) NOT NULL,
  worker_credential_id varchar(128) NOT NULL,
  action varchar(8) NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_phase4_recovery_operation_pkey PRIMARY KEY (tenant_id, operation_id),
  CONSTRAINT meri_phase4_recovery_operation_identity_key UNIQUE (
    tenant_id, operation_id, run_id, request_sha256, worker_run_id,
    worker_audience, worker_ingress_id, worker_generation,
    worker_credential_id, action
  ),
  CONSTRAINT meri_phase4_recovery_operation_intent_fk FOREIGN KEY (
    run_id, tenant_id, request_sha256, worker_run_id, worker_audience,
    worker_ingress_id, worker_generation, worker_credential_id
  ) REFERENCES public.meri_agent_dispatch_intents (
    run_id, tenant_id, request_sha256, worker_run_id, worker_audience,
    worker_ingress_id, worker_generation, worker_credential_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meri_phase4_recovery_operation_request_digest_check
    CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT meri_phase4_recovery_operation_worker_run_check
    CHECK (worker_run_id ~ '^[!-~]{1,120}$'),
  CONSTRAINT meri_phase4_recovery_operation_audience_check
    CHECK (worker_audience = 'meri-hermes-scope-worker'),
  CONSTRAINT meri_phase4_recovery_operation_ingress_check
    CHECK (worker_ingress_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT meri_phase4_recovery_operation_generation_check
    CHECK (worker_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT meri_phase4_recovery_operation_credential_check
    CHECK (worker_credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT meri_phase4_recovery_operation_action_check
    CHECK (action IN ('status', 'stop'))
);

CREATE TABLE public.meri_phase4_dispatch_recovery_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version smallint NOT NULL,
  receipt_purpose varchar(64) NOT NULL,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  request_sha256 char(64) NOT NULL,
  worker_run_id varchar(120) NOT NULL,
  worker_audience varchar(64) NOT NULL,
  worker_ingress_id varchar(128) NOT NULL,
  worker_generation varchar(128) NOT NULL,
  worker_credential_id varchar(128) NOT NULL,
  action varchar(8) NOT NULL,
  operation_id uuid NOT NULL,
  attempt_nonce varchar(22) NOT NULL,
  command_key_id varchar(128) NOT NULL,
  command_sha256 char(64) NOT NULL,
  native_request_body_sha256 char(64) NOT NULL,
  native_response_body_sha256 char(64) NOT NULL,
  receipt_sha256 char(64) NOT NULL,
  observation varchar(24) NOT NULL,
  worker_status varchar(32),
  native_http_status smallint NOT NULL,
  issued_at_epoch_micros bigint NOT NULL,
  expires_at_epoch_micros bigint NOT NULL,
  observed_at_epoch_micros bigint NOT NULL,
  key_id varchar(128) NOT NULL,
  signature varchar(43) NOT NULL,
  persisted_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_phase4_recovery_receipt_digest_key UNIQUE (tenant_id, receipt_sha256),
  CONSTRAINT meri_phase4_recovery_receipt_attempt_key UNIQUE (tenant_id, attempt_nonce),
  CONSTRAINT meri_phase4_recovery_receipt_signature_key UNIQUE (tenant_id, key_id, signature),
  CONSTRAINT meri_phase4_recovery_receipt_operation_fk FOREIGN KEY (
    tenant_id, operation_id, run_id, request_sha256, worker_run_id,
    worker_audience, worker_ingress_id, worker_generation,
    worker_credential_id, action
  ) REFERENCES public.meri_phase4_dispatch_recovery_operations (
    tenant_id, operation_id, run_id, request_sha256, worker_run_id,
    worker_audience, worker_ingress_id, worker_generation,
    worker_credential_id, action
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meri_phase4_recovery_receipt_protocol_check CHECK (
    contract_version = 1 AND
    receipt_purpose = 'meri-hermes-recovery-receipt'
  ),
  CONSTRAINT meri_phase4_recovery_receipt_digest_shape_check CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$' AND
    command_sha256 ~ '^[0-9a-f]{64}$' AND
    native_request_body_sha256 ~ '^[0-9a-f]{64}$' AND
    native_response_body_sha256 ~ '^[0-9a-f]{64}$' AND
    receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT meri_phase4_recovery_receipt_route_shape_check CHECK (
    worker_run_id ~ '^[!-~]{1,120}$' AND
    worker_audience = 'meri-hermes-scope-worker' AND
    worker_ingress_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    worker_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    worker_credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT meri_phase4_recovery_receipt_attempt_nonce_check CHECK (
    -- Canonical unpadded base64url for exactly 16 bytes.
    attempt_nonce ~ '^[A-Za-z0-9_-]{21}[AQgw]$'
  ),
  CONSTRAINT meri_phase4_recovery_receipt_key_id_check CHECK (
    command_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT meri_phase4_recovery_receipt_signature_check CHECK (
    -- Canonical unpadded base64url for an HMAC-SHA256 signature (32 bytes).
    signature ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
  ),
  CONSTRAINT meri_phase4_recovery_receipt_window_check CHECK (
    issued_at_epoch_micros > 0 AND
    expires_at_epoch_micros > issued_at_epoch_micros AND
    expires_at_epoch_micros - issued_at_epoch_micros <= 60000000 AND
    observed_at_epoch_micros >= issued_at_epoch_micros AND
    observed_at_epoch_micros < expires_at_epoch_micros
  ),
  CONSTRAINT meri_phase4_recovery_receipt_status_body_check CHECK (
    action IN ('status', 'stop') AND
    (action <> 'status' OR native_request_body_sha256 =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  ),
  CONSTRAINT meri_phase4_recovery_receipt_observation_check CHECK (
    (observation = 'run_nonterminal' AND native_http_status = 200 AND
      worker_status IN (
        'queued', 'provisioning', 'running', 'waiting_for_approval',
        'waiting_for_clarification', 'cancelling'
      )) OR
    (observation = 'run_terminal' AND native_http_status = 200 AND
      worker_status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired')) OR
    (observation = 'stop_accepted' AND action = 'stop' AND
      native_http_status IN (200, 202, 204) AND worker_status IS NULL) OR
    (observation = 'not_found' AND native_http_status = 404 AND worker_status IS NULL)
  )
);

COMMENT ON TABLE public.meri_phase4_dispatch_recovery_operations IS
  'Append-only identity anchors: retries may change attempt nonce but cannot change the operation dispatch, worker route, or action.';
COMMENT ON TABLE public.meri_phase4_dispatch_recovery_receipts IS
  'Dormant append-only projection of already-verified Phase 4 recovery receipts. not_found remains UNKNOWN and stop_accepted remains nonterminal.';
COMMENT ON COLUMN public.meri_phase4_dispatch_recovery_receipts.key_id IS
  'Signed identifier for the purpose-separated worker-to-API recovery receipt key; no key bytes are stored.';
COMMENT ON COLUMN public.meri_phase4_dispatch_recovery_receipts.command_key_id IS
  'Signed command key identifier recovered from the exact command token before receipt persistence.';
COMMENT ON COLUMN public.meri_phase4_dispatch_recovery_receipts.receipt_sha256 IS
  'SHA-256 of the exact ASCII mhrr1 receipt token verified by the future writer.';

ALTER TABLE public.meri_phase4_dispatch_recovery_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_dispatch_recovery_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_recovery_operation_owner
  ON public.meri_phase4_dispatch_recovery_operations
  TO PUBLIC USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_phase4_recovery_operation_tenant_read
  ON public.meri_phase4_dispatch_recovery_operations
  FOR SELECT TO capiro_app
  USING (tenant_id = public.current_tenant_id());

ALTER TABLE public.meri_phase4_dispatch_recovery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_dispatch_recovery_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_recovery_receipt_owner
  ON public.meri_phase4_dispatch_recovery_receipts
  TO PUBLIC USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_phase4_recovery_receipt_tenant_read
  ON public.meri_phase4_dispatch_recovery_receipts
  FOR SELECT TO capiro_app
  USING (tenant_id = public.current_tenant_id());

CREATE FUNCTION public.meri_phase4_guard_dispatch_recovery_operation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Phase 4 recovery operation identities are append-only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.meri_phase4_guard_dispatch_recovery_receipt()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  anchored public.meri_phase4_dispatch_recovery_operations%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Phase 4 recovery receipts are append-only'
      USING ERRCODE = '55000';
  END IF;

  -- The unique operation primary key is the concurrency fence. Concurrent
  -- first attempts serialize here; the losing insert then compares against
  -- the committed anchor before its receipt can become visible.
  INSERT INTO public.meri_phase4_dispatch_recovery_operations (
    tenant_id, operation_id, run_id, request_sha256, worker_run_id,
    worker_audience, worker_ingress_id, worker_generation,
    worker_credential_id, action
  ) VALUES (
    NEW.tenant_id, NEW.operation_id, NEW.run_id, NEW.request_sha256,
    NEW.worker_run_id, NEW.worker_audience, NEW.worker_ingress_id,
    NEW.worker_generation, NEW.worker_credential_id, NEW.action
  ) ON CONFLICT (tenant_id, operation_id) DO NOTHING;

  SELECT * INTO STRICT anchored
    FROM public.meri_phase4_dispatch_recovery_operations o
    WHERE o.tenant_id = NEW.tenant_id AND o.operation_id = NEW.operation_id
    FOR SHARE;
  IF ROW(
      anchored.run_id, anchored.request_sha256, anchored.worker_run_id,
      anchored.worker_audience, anchored.worker_ingress_id,
      anchored.worker_generation, anchored.worker_credential_id, anchored.action
    ) IS DISTINCT FROM ROW(
      NEW.run_id, NEW.request_sha256, NEW.worker_run_id,
      NEW.worker_audience, NEW.worker_ingress_id,
      NEW.worker_generation, NEW.worker_credential_id, NEW.action
    ) THEN
    RAISE EXCEPTION 'Phase 4 recovery operation replay drift'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meri_phase4_recovery_operation_append_only
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.meri_phase4_dispatch_recovery_operations
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_dispatch_recovery_operation();
CREATE TRIGGER meri_phase4_recovery_receipt_append_only
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.meri_phase4_dispatch_recovery_receipts
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_dispatch_recovery_receipt();

ALTER TABLE public.meri_phase4_dispatch_recovery_operations
  OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_dispatch_recovery_receipts
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_dispatch_recovery_operation()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_dispatch_recovery_receipt()
  OWNER TO meri_phase4_authority_owner;

-- No application/operator DML and no callable routine are enabled here.
REVOKE ALL ON TABLE public.meri_phase4_dispatch_recovery_operations,
  public.meri_phase4_dispatch_recovery_receipts
  FROM PUBLIC, capiro_app, meri_phase4_route_operator;
REVOKE ALL ON FUNCTION public.meri_phase4_guard_dispatch_recovery_operation(),
  public.meri_phase4_guard_dispatch_recovery_receipt()
  FROM PUBLIC, capiro_app, meri_phase4_route_operator;

-- Negative control for the migration owner's global routine defaults, then a
-- final scan for any inherited non-extension routine execution path.
CREATE FUNCTION public.meri_phase4_recovery_default_acl_probe() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS 'SELECT 1';
DO $$
DECLARE exposure text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    WHERE p.oid = 'public.meri_phase4_recovery_default_acl_probe()'::regprocedure
      AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'new Phase 4 recovery routines still inherit PUBLIC EXECUTE'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) x
    WHERE d.defaclobjtype = 'f' AND d.defaclnamespace = 0
      AND d.defaclrole IN (current_user::regrole, 'meri_phase4_authority_owner'::regrole)
      AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Phase 4 recovery DDL owners retain default PUBLIC routine authority'
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
    RAISE EXCEPTION 'unsafe PostgreSQL PUBLIC routine after Phase 4 recovery migration: %', exposure
      USING ERRCODE = '42501';
  END IF;
END $$;
DROP FUNCTION public.meri_phase4_recovery_default_acl_probe();

REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;
DO $$ BEGIN
  EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user);
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
       OR m.member = 'meri_phase4_authority_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner membership survived recovery receipt migration'
      USING ERRCODE = '42501';
  END IF;
  IF has_schema_privilege('meri_phase4_authority_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Phase 4 authority owner retained schema CREATE after recovery receipt migration'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMIT;
