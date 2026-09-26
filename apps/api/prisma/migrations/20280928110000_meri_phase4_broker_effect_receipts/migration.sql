-- Dormant Phase 4 broker-effect idempotency authority for meri_record_turn.
-- No LOGIN, membership, runtime registration, signer key, or transport is
-- installed. A separately reviewed external verifier must first persist an
-- exact claims-digest attestation; without it this package cannot emit a
-- committed or denied signed receipt. An effect_unknown receipt is deliberately
-- unsigned and remains non-authoritative uncertainty evidence.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_authority_owner') THEN
    RAISE EXCEPTION 'Phase 4 authority owner is unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_broker_effect_operator') THEN
    CREATE ROLE meri_phase4_broker_effect_operator NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_broker_signer_owner') THEN
    CREATE ROLE meri_phase4_broker_signer_owner NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname IN (
      'meri_phase4_authority_owner', 'meri_phase4_broker_effect_operator',
      'meri_phase4_broker_signer_owner'
    ) AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR
           rolinherit OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Phase 4 broker-effect role has unsafe attributes'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_broker_effect_operator'::regrole,
      'meri_phase4_broker_signer_owner'::regrole
    ) OR m.member IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_broker_effect_operator'::regrole,
      'meri_phase4_broker_signer_owner'::regrole
    )
  ) THEN
    RAISE EXCEPTION 'Phase 4 broker-effect role membership pre-existed migration'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user);
    EXECUTE format('GRANT meri_phase4_broker_signer_owner TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'broker-effect migration executor cannot acquire owner authority'
      USING ERRCODE = '42501';
  END;
END $$;

DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_broker_signer_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO meri_phase4_authority_owner;
GRANT CREATE ON SCHEMA public TO meri_phase4_broker_signer_owner;

-- This is a dormant separation-of-duties boundary, not a signing service.
-- It stores no public/private key bytes. No role has membership in its owner,
-- and this migration exposes no writer function. A later reviewed verifier
-- may persist a row only after cryptographically verifying the exact digest.
CREATE TABLE public.meri_phase4_broker_effect_signature_attestations (
  claims_sha256 char(64) PRIMARY KEY,
  signer_key_id varchar(128) NOT NULL,
  signature varchar(86) NOT NULL,
  verification_method varchar(32) NOT NULL,
  qualification_sha256 char(64) NOT NULL,
  verified_at_epoch_micros bigint NOT NULL,
  expires_at_epoch_micros bigint NOT NULL,
  persisted_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_p4_broker_signature_attestation_exact_key UNIQUE (
    claims_sha256, signer_key_id, signature, qualification_sha256,
    verified_at_epoch_micros
  ),
  CONSTRAINT meri_p4_broker_signature_attestation_shape CHECK (
    claims_sha256 ~ '^[0-9a-f]{64}$' AND
    signer_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    signature ~ '^[A-Za-z0-9_-]{85}[AQgw]$' AND
    verification_method = 'external-ed25519-v1' AND
    qualification_sha256 ~ '^[0-9a-f]{64}$' AND
    verified_at_epoch_micros > 0 AND
    expires_at_epoch_micros > verified_at_epoch_micros AND
    expires_at_epoch_micros - verified_at_epoch_micros <= 300000000
  )
);

CREATE TABLE public.meri_phase4_broker_effect_operations (
  operation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  worker_run_id varchar(120) NOT NULL,
  dispatch_request_sha256 char(64) NOT NULL,
  scope_id varchar(200) NOT NULL,
  tool_name varchar(32) NOT NULL,
  canonical_request_sha256 char(64) NOT NULL,
  user_chars integer,
  assistant_chars integer,
  effect_disposition varchar(16) NOT NULL,
  created_at_epoch_micros bigint NOT NULL,
  retain_until_epoch_micros bigint NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_p4_broker_effect_operation_identity_key UNIQUE (
    tenant_id, operation_id, run_id, worker_run_id, dispatch_request_sha256,
    scope_id, tool_name, canonical_request_sha256
  ),
  CONSTRAINT meri_p4_broker_effect_operation_shape CHECK (
    worker_run_id ~ '^[!-~]{1,120}$' AND
    dispatch_request_sha256 ~ '^[0-9a-f]{64}$' AND
    length(scope_id) BETWEEN 1 AND 200 AND btrim(scope_id) = scope_id AND
    tool_name = 'meri_record_turn' AND
    canonical_request_sha256 ~ '^[0-9a-f]{64}$' AND
    (user_chars IS NULL OR user_chars BETWEEN 0 AND 100000000) AND
    (assistant_chars IS NULL OR assistant_chars BETWEEN 0 AND 100000000) AND
    effect_disposition IN ('attempt', 'effect_unknown') AND
    created_at_epoch_micros > 0 AND
    retain_until_epoch_micros > created_at_epoch_micros AND
    retain_until_epoch_micros - created_at_epoch_micros <= 31536000000000
  )
);

CREATE TABLE public.meri_phase4_broker_effect_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  worker_run_id varchar(120) NOT NULL,
  dispatch_request_sha256 char(64) NOT NULL,
  scope_id varchar(200) NOT NULL,
  tool_name varchar(32) NOT NULL,
  canonical_request_sha256 char(64) NOT NULL,
  result varchar(24) NOT NULL,
  detail varchar(64) NOT NULL,
  broker_calls_before integer NOT NULL,
  broker_calls_after integer NOT NULL,
  event_seq integer,
  result_summary varchar(64) NOT NULL,
  domain_ref varchar(128),
  signed_claims_sha256 char(64) NOT NULL,
  signer_key_id varchar(128),
  signature varchar(86),
  qualification_sha256 char(64),
  signature_verified_at_epoch_micros bigint,
  receipt_sha256 char(64) NOT NULL,
  applied_at_epoch_micros bigint NOT NULL,
  retain_until_epoch_micros bigint NOT NULL,
  applied_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meri_p4_broker_effect_receipt_operation_key UNIQUE (operation_id),
  CONSTRAINT meri_p4_broker_effect_receipt_digest_key UNIQUE (tenant_id, receipt_sha256),
  CONSTRAINT meri_p4_broker_effect_receipt_operation_fk FOREIGN KEY (
    tenant_id, operation_id, run_id, worker_run_id, dispatch_request_sha256,
    scope_id, tool_name, canonical_request_sha256
  ) REFERENCES public.meri_phase4_broker_effect_operations (
    tenant_id, operation_id, run_id, worker_run_id, dispatch_request_sha256,
    scope_id, tool_name, canonical_request_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meri_p4_broker_effect_receipt_signature_fk FOREIGN KEY (
    signed_claims_sha256, signer_key_id, signature, qualification_sha256,
    signature_verified_at_epoch_micros
  ) REFERENCES public.meri_phase4_broker_effect_signature_attestations (
    claims_sha256, signer_key_id, signature, qualification_sha256,
    verified_at_epoch_micros
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT meri_p4_broker_effect_receipt_shape CHECK (
    worker_run_id ~ '^[!-~]{1,120}$' AND
    dispatch_request_sha256 ~ '^[0-9a-f]{64}$' AND
    tool_name = 'meri_record_turn' AND
    canonical_request_sha256 ~ '^[0-9a-f]{64}$' AND
    result IN ('committed', 'denied_before_effect', 'effect_unknown') AND
    length(detail) BETWEEN 1 AND 64 AND btrim(detail) = detail AND
    broker_calls_before >= 0 AND broker_calls_after >= 0 AND
    (event_seq IS NULL OR event_seq > 0) AND
    length(result_summary) BETWEEN 1 AND 64 AND btrim(result_summary) = result_summary AND
    (domain_ref IS NULL OR (
      length(domain_ref) BETWEEN 1 AND 128 AND
      domain_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )) AND
    signed_claims_sha256 ~ '^[0-9a-f]{64}$' AND
    ((signer_key_id IS NULL AND signature IS NULL AND
      qualification_sha256 IS NULL AND signature_verified_at_epoch_micros IS NULL) OR
     (signer_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      signature ~ '^[A-Za-z0-9_-]{85}[AQgw]$' AND
      qualification_sha256 ~ '^[0-9a-f]{64}$' AND
      signature_verified_at_epoch_micros > 0)) AND
    receipt_sha256 ~ '^[0-9a-f]{64}$' AND
    applied_at_epoch_micros > 0 AND
    retain_until_epoch_micros > applied_at_epoch_micros AND
    retain_until_epoch_micros - applied_at_epoch_micros <= 31536000000000 AND
    ((result = 'committed' AND detail = 'recorded' AND
      broker_calls_after = broker_calls_before + 1 AND event_seq IS NOT NULL AND
      result_summary = 'recorded' AND domain_ref = 'meri_institutional_memory' AND
      signature IS NOT NULL) OR
     (result = 'denied_before_effect' AND
      broker_calls_after = broker_calls_before AND event_seq IS NULL AND
      result_summary = 'denied' AND domain_ref IS NULL AND signature IS NOT NULL) OR
     (result = 'effect_unknown' AND detail = 'caller_reported_unknown' AND
      broker_calls_after = broker_calls_before AND event_seq IS NULL AND
      result_summary = 'unknown' AND domain_ref IS NULL))
  )
);

COMMENT ON TABLE public.meri_phase4_broker_effect_signature_attestations IS
  'Dormant externally verified signature facts over exact DB-derived claims digests. No signer key bytes or verifier writer are installed here.';
COMMENT ON TABLE public.meri_phase4_broker_effect_operations IS
  'Append-only stable identities for idempotent meri_record_turn broker effects.';
COMMENT ON TABLE public.meri_phase4_broker_effect_receipts IS
  'Append-only DB-authenticated outcomes. Committed/denied facts require an externally verified signature; effect_unknown may be an explicitly unsigned uncertainty tombstone.';
COMMENT ON COLUMN public.meri_phase4_broker_effect_receipts.signed_claims_sha256 IS
  'Canonical claims digest. It is signed only when the nullable signer/signature fields are populated.';

ALTER TABLE public.meri_phase4_broker_effect_signature_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_broker_effect_signature_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_p4_broker_signature_owner
  ON public.meri_phase4_broker_effect_signature_attestations TO PUBLIC
  USING (current_user = 'meri_phase4_broker_signer_owner')
  WITH CHECK (current_user = 'meri_phase4_broker_signer_owner');
CREATE POLICY meri_p4_broker_signature_authority_read
  ON public.meri_phase4_broker_effect_signature_attestations FOR SELECT
  TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');

ALTER TABLE public.meri_phase4_broker_effect_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_broker_effect_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_p4_broker_effect_operation_owner
  ON public.meri_phase4_broker_effect_operations TO PUBLIC
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

ALTER TABLE public.meri_phase4_broker_effect_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_broker_effect_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_p4_broker_effect_receipt_owner
  ON public.meri_phase4_broker_effect_receipts TO PUBLIC
  USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

-- The effect routine re-derives the same current user authority material as
-- dispatch. These owner-only policies do not widen capiro_app or the broker
-- operator; they make the required FORCE-RLS source reads visible only inside
-- the authority-owner SECURITY DEFINER transaction.
CREATE POLICY meri_p4_broker_client_authority_read ON public.clients
  FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_p4_broker_client_access_authority_read
  ON public.client_memory_access FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_p4_broker_mailbox_authority_read
  ON public.engagement_connections FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_p4_broker_conversation_authority_read
  ON public.clio_conversations FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');

-- SELECT-only live reads are safe because each relevant mutable authority
-- source has an enabled trigger that must take the tenant fence exclusively
-- before its writer can commit. This routine already holds that fence shared,
-- so its decision linearizes before a concurrent revocation. Avoid granting
-- UPDATE merely to obtain redundant per-source SELECT ... FOR SHARE locks.
DO $$
DECLARE missing_triggers text;
BEGIN
  SELECT string_agg(expected.trigger_name, ', ' ORDER BY expected.trigger_name)
    INTO missing_triggers
  FROM (VALUES
    ('public.tenants'::regclass, 'meri_phase4_tenant_fence'),
    ('public.users'::regclass, 'meri_phase4_user_identity_fence'),
    ('public.tenant_memberships'::regclass, 'meri_phase4_membership_fence'),
    ('public.clients'::regclass, 'meri_phase4_client_fence'),
    ('public.client_memory_access'::regclass, 'meri_phase4_client_access_fence'),
    ('public.engagement_connections'::regclass, 'meri_phase4_mailbox_fence'),
    ('public.clio_conversations'::regclass, 'meri_phase4_conversation_fence'),
    ('public.meri_execution_scopes'::regclass, 'meri_phase4_scope_fence')
  ) AS expected(table_oid, trigger_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = expected.table_oid AND
      t.tgname = expected.trigger_name AND NOT t.tgisinternal AND
      t.tgenabled IN ('O', 'A')
  );
  IF missing_triggers IS NOT NULL THEN
    RAISE EXCEPTION 'required Phase 4 authority triggers unavailable: %',
      missing_triggers USING ERRCODE = '55000';
  END IF;
END $$;

CREATE FUNCTION public.meri_phase4_record_turn_effect(
  p_tenant_id uuid,
  p_run_id uuid,
  p_worker_run_id varchar,
  p_dispatch_request_sha256 char(64),
  p_scope_id varchar,
  p_operation_id uuid,
  p_canonical_request_sha256 char(64),
  p_user_chars integer,
  p_assistant_chars integer,
  p_effect_disposition varchar
) RETURNS TABLE (
  receipt_id uuid,
  result varchar,
  detail varchar,
  broker_calls_before integer,
  broker_calls_after integer,
  event_seq integer,
  applied_at timestamptz,
  applied_at_epoch_micros bigint,
  retain_until_epoch_micros bigint,
  signed_claims_sha256 char(64),
  signer_key_id varchar,
  signature varchar,
  signature_verified_at_epoch_micros bigint,
  qualification_sha256 char(64),
  receipt_sha256 char(64)
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_now bigint := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  v_retain bigint;
  v_canonical_request_sha256 char(64);
  v_claims_sha256 char(64);
  v_receipt_sha256 char(64);
  v_existing_operation public.meri_phase4_broker_effect_operations%ROWTYPE;
  v_existing_receipt public.meri_phase4_broker_effect_receipts%ROWTYPE;
  v_run public.meri_agent_runs%ROWTYPE;
  v_intent public.meri_agent_dispatch_intents%ROWTYPE;
  v_scope record;
  v_fence public.meri_phase4_authority_fences%ROWTYPE;
  v_route public.meri_phase4_worker_routes%ROWTYPE;
  v_binding public.meri_phase4_worker_bindings%ROWTYPE;
  v_attestation public.meri_phase4_broker_effect_signature_attestations%ROWTYPE;
  v_actor record;
  v_conversation record;
  v_client_ids text[] := ARRAY[]::text[];
  v_mailbox_ids text[] := ARRAY[]::text[];
  v_expected_authorization_version text;
  v_envelope_issued_at timestamptz;
  v_envelope_expires_at timestamptz;
  v_authority_current boolean := true;
  v_tool_allowed boolean := false;
  v_cap integer;
  v_calls_before integer;
  v_calls_after integer;
  v_event_seq integer;
  v_result varchar(24);
  v_detail varchar(64);
  v_result_summary varchar(64);
  v_domain_ref varchar(128);
  v_receipt_id uuid;
  v_applied_at timestamptz;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM
       'meri_phase4_broker_effect_operator' OR
     p_tenant_id IS NULL OR p_run_id IS NULL OR p_worker_run_id IS NULL OR
     p_dispatch_request_sha256 IS NULL OR p_scope_id IS NULL OR
     p_operation_id IS NULL OR p_canonical_request_sha256 IS NULL OR
     p_effect_disposition IS NULL OR
     p_effect_disposition NOT IN ('attempt', 'effect_unknown') OR
     p_worker_run_id !~ '^[!-~]{1,120}$' OR
     p_dispatch_request_sha256::text !~ '^[0-9a-f]{64}$' OR
     p_canonical_request_sha256::text !~ '^[0-9a-f]{64}$' OR
     length(p_scope_id) NOT BETWEEN 1 AND 200 OR btrim(p_scope_id) <> p_scope_id OR
     (p_user_chars IS NOT NULL AND p_user_chars NOT BETWEEN 0 AND 100000000) OR
     (p_assistant_chars IS NOT NULL AND
       p_assistant_chars NOT BETWEEN 0 AND 100000000) THEN
    RAISE EXCEPTION 'Phase 4 record-turn authority is unavailable'
      USING ERRCODE = '42501';
  END IF;

  v_canonical_request_sha256 := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.broker-effect-request/v1', p_tenant_id::text,
    p_run_id::text, p_worker_run_id, p_dispatch_request_sha256::text,
    p_scope_id, 'meri_record_turn', coalesce(p_user_chars::text, 'null'),
    coalesce(p_assistant_chars::text, 'null')
  ]);
  IF v_canonical_request_sha256 IS DISTINCT FROM p_canonical_request_sha256 THEN
    RAISE EXCEPTION 'Phase 4 record-turn canonical request mismatch'
      USING ERRCODE = '23505';
  END IF;

  -- operation_id is the stable idempotency key. Equal content may be a
  -- legitimate second record_turn operation in the same run. Serialize before
  -- lookup so a concurrent exact retry observes and replays the first commit
  -- instead of racing the operation primary key.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_operation_id::text, 0)
  );
  SELECT o.* INTO v_existing_operation
  FROM public.meri_phase4_broker_effect_operations o
  WHERE o.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF ROW(
      v_existing_operation.operation_id, v_existing_operation.tenant_id,
      v_existing_operation.run_id, v_existing_operation.worker_run_id,
      v_existing_operation.dispatch_request_sha256,
      v_existing_operation.scope_id, v_existing_operation.tool_name,
      v_existing_operation.canonical_request_sha256,
      v_existing_operation.user_chars, v_existing_operation.assistant_chars,
      v_existing_operation.effect_disposition
    ) IS DISTINCT FROM ROW(
      p_operation_id, p_tenant_id, p_run_id, p_worker_run_id,
      p_dispatch_request_sha256, p_scope_id, 'meri_record_turn'::varchar,
      p_canonical_request_sha256, p_user_chars, p_assistant_chars,
      p_effect_disposition
    ) THEN
      RAISE EXCEPTION 'Phase 4 record-turn operation replay drift'
        USING ERRCODE = '23505';
    END IF;
    SELECT r.* INTO v_existing_receipt
    FROM public.meri_phase4_broker_effect_receipts r
    WHERE r.operation_id = p_operation_id FOR SHARE;
    IF FOUND THEN
      receipt_id := v_existing_receipt.receipt_id;
      result := v_existing_receipt.result;
      detail := v_existing_receipt.detail;
      broker_calls_before := v_existing_receipt.broker_calls_before;
      broker_calls_after := v_existing_receipt.broker_calls_after;
      event_seq := v_existing_receipt.event_seq;
      applied_at := v_existing_receipt.applied_at;
      applied_at_epoch_micros := v_existing_receipt.applied_at_epoch_micros;
      retain_until_epoch_micros := v_existing_receipt.retain_until_epoch_micros;
      signed_claims_sha256 := v_existing_receipt.signed_claims_sha256;
      signer_key_id := v_existing_receipt.signer_key_id;
      signature := v_existing_receipt.signature;
      signature_verified_at_epoch_micros :=
        v_existing_receipt.signature_verified_at_epoch_micros;
      qualification_sha256 := v_existing_receipt.qualification_sha256;
      receipt_sha256 := v_existing_receipt.receipt_sha256;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- Serialize every effect and Stop/terminal decision on the run row. The
  -- tenant fence is held shared so current-authority writers cannot cross the
  -- decision before the operation, event, and receipt commit.
  SELECT f.* INTO v_fence FROM public.meri_phase4_authority_fences f
  WHERE f.tenant_id = p_tenant_id FOR SHARE;
  IF NOT FOUND THEN v_authority_current := false; END IF;

  SELECT r.* INTO v_run FROM public.meri_agent_runs r
  WHERE r.tenant_id = p_tenant_id AND r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phase 4 record-turn run is unavailable'
      USING ERRCODE = '23503';
  END IF;
  v_calls_before := v_run.broker_calls;

  SELECT i.* INTO v_intent FROM public.meri_agent_dispatch_intents i
  WHERE i.tenant_id = p_tenant_id AND i.run_id = p_run_id FOR SHARE;
  IF NOT FOUND THEN v_authority_current := false; END IF;
  SELECT s.id, s.tenant_id, s.principal_type, s.principal_id, s.kind,
      s.authorization_version
    INTO v_scope
  FROM public.meri_execution_scopes s
  WHERE s.tenant_id = p_tenant_id AND s.id = p_scope_id;
  IF NOT FOUND THEN v_authority_current := false; END IF;

  -- Re-read the live identity and its current authorization sets while the
  -- tenant authority fence is held. Direct membership/access revocation is
  -- therefore observed here even if a caller presents a still-valid worker
  -- identity. Every relevant source-table writer has a Phase 4 fence trigger,
  -- so it cannot commit a change across this transaction's shared fence lock.
  SELECT m.role::text AS role, t.slug::text AS tenant_slug,
      u.clerk_user_id::text AS clerk_user_id
    INTO v_actor
  FROM public.tenant_memberships m
  JOIN public.tenants t ON t.id = m.tenant_id
  JOIN public.users u ON u.id = m.user_id
  WHERE m.tenant_id = p_tenant_id AND m.user_id = v_intent.actor_id AND
    m.status::text = 'active' AND t.status::text = 'active';
  IF NOT FOUND OR v_actor.role IS NULL OR btrim(v_actor.role) = '' OR
     v_actor.tenant_slug IS NULL OR btrim(v_actor.tenant_slug) = '' OR
     v_actor.clerk_user_id IS NULL OR btrim(v_actor.clerk_user_id) = '' THEN
    v_authority_current := false;
  END IF;

  SELECT coalesce(array_agg(c.id::text ORDER BY c.id), ARRAY[]::text[])
    INTO v_client_ids
  FROM public.clients c
  WHERE c.tenant_id = p_tenant_id AND (
    c.memory_wall = false OR EXISTS (
      SELECT 1 FROM public.client_memory_access a
      WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id AND
        a.user_id = v_intent.actor_id
    )
  );

  SELECT coalesce(array_agg(e.id::text ORDER BY e.id), ARRAY[]::text[])
    INTO v_mailbox_ids
  FROM public.engagement_connections e
  WHERE e.tenant_id = p_tenant_id AND
    e.created_by_user_id = v_intent.actor_id AND
    e.provider::text IN ('microsoft_365', 'google_workspace', 'imap_caldav');

  SELECT c.id, c.tenant_id, c.user_id, c.client_id, c.workspace_id,
      c.status, c.archived_at
    INTO v_conversation
  FROM public.clio_conversations c
  WHERE c.tenant_id = p_tenant_id AND c.id = v_intent.conversation_id;
  IF NOT FOUND THEN v_authority_current := false; END IF;

  IF v_actor.role IS NOT NULL AND v_fence.revision IS NOT NULL AND
     v_fence.policy_version IS NOT NULL THEN
    v_expected_authorization_version := 'm4a2:' ||
      public.meri_phase4_route_digest_v1(
        ARRAY[
          'capiro.meri.phase4.current-authorization/v2',
          p_tenant_id::text, v_intent.actor_id::text, v_actor.role,
          v_fence.policy_version, 'g2:' || v_fence.revision::text,
          cardinality(v_client_ids)::text
        ] || v_client_ids || ARRAY[cardinality(v_mailbox_ids)::text] ||
        v_mailbox_ids
      )::text;
  ELSE
    v_authority_current := false;
  END IF;

  BEGIN
    v_envelope_issued_at := (v_run.envelope_jsonb->>'issuedAt')::timestamptz;
    v_envelope_expires_at := (v_run.envelope_jsonb->>'expiresAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    v_authority_current := false;
  END;

  SELECT r.* INTO v_route FROM public.meri_phase4_worker_routes r
  WHERE r.tenant_id = p_tenant_id AND r.scope_id = p_scope_id AND
    r.worker_audience = 'meri-hermes-scope-worker' AND
    r.worker_ingress_id = v_intent.worker_ingress_id AND
    r.worker_generation = v_intent.worker_generation AND
    r.worker_credential_id = v_intent.worker_credential_id
  FOR SHARE;
  IF NOT FOUND THEN v_authority_current := false; END IF;

  IF v_route.binding_id IS NOT NULL THEN
    SELECT b.* INTO v_binding
    FROM public.meri_phase4_worker_bindings b
    JOIN public.meri_phase4_worker_binding_sources src
      ON src.source_id = b.source_id AND src.producer_role = b.attested_by_role
    WHERE b.binding_id = v_route.binding_id AND b.tenant_id = p_tenant_id AND
      b.scope_id = p_scope_id AND
      b.worker_audience = v_intent.worker_audience AND
      b.worker_ingress_id = v_intent.worker_ingress_id AND
      b.worker_generation = v_intent.worker_generation AND
      b.worker_credential_id = v_intent.worker_credential_id AND
      src.qualified = true
    FOR SHARE OF b, src;
    IF NOT FOUND THEN v_authority_current := false; END IF;
  ELSE
    v_authority_current := false;
  END IF;

  v_authority_current := v_authority_current AND coalesce((
    v_intent.identity_version = 2 AND
    v_intent.actor_type = 'user' AND
    v_intent.meri_audience = 'private' AND
    v_intent.worker_audience = 'meri-hermes-scope-worker' AND
    v_run.scope_id = p_scope_id AND
    v_run.actor_id = v_intent.actor_id AND
    v_run.conversation_id = v_intent.conversation_id AND
    v_run.user_message_id = v_intent.user_message_id AND
    v_run.idempotency_key = v_intent.idempotency_key AND
    v_run.hermes_run_id = p_worker_run_id AND
    v_run.dispatch_status = 'dispatched' AND
    v_intent.state = 'claimed' AND
    v_intent.worker_run_id = p_worker_run_id AND
    v_intent.request_sha256 = p_dispatch_request_sha256 AND
    v_intent.scope_id = p_scope_id AND
    v_intent.tombstoned_at_epoch_micros IS NULL AND
    v_intent.grant_version = 'g2:' || v_fence.revision::text AND
    v_fence.policy_version = 'meri-phase4-policy-v1' AND
    v_intent.authorization_policy_version = v_fence.policy_version AND
    v_intent.authorization_version = v_expected_authorization_version AND
    v_now < v_intent.claim_not_after_epoch_micros AND
    v_now < v_intent.delivery_not_after_epoch_micros AND
    v_now < v_intent.worker_credential_not_after_epoch_micros AND
    v_scope.tenant_id = p_tenant_id AND
    v_scope.principal_type = 'user' AND
    v_scope.principal_id = v_intent.actor_id::text AND
    v_scope.kind = 'private' AND
    p_scope_id = 'tenant:' || p_tenant_id::text || ':user:' ||
      v_intent.actor_id::text AND
    v_scope.authorization_version = v_intent.authorization_version AND
    v_conversation.tenant_id = p_tenant_id AND
    v_conversation.user_id = v_intent.actor_id AND
    v_conversation.client_id IS NOT DISTINCT FROM v_intent.client_id AND
    v_conversation.workspace_id IS NOT DISTINCT FROM v_intent.workspace_id AND
    v_conversation.status = 'active' AND v_conversation.archived_at IS NULL AND
    (v_intent.client_id IS NULL OR
      v_intent.client_id::text = ANY(v_client_ids)) AND
    v_run.envelope_jsonb->>'version' = '1' AND
    v_run.envelope_jsonb->>'tenantId' = p_tenant_id::text AND
    v_run.envelope_jsonb->>'runId' = p_run_id::text AND
    v_run.envelope_jsonb->>'actorType' = v_intent.actor_type AND
    v_run.envelope_jsonb->>'actorId' = v_intent.actor_id::text AND
    v_run.envelope_jsonb->>'conversationId' = v_intent.conversation_id::text AND
    v_run.envelope_jsonb ? 'workspaceId' AND
    v_run.envelope_jsonb->>'workspaceId' IS NOT DISTINCT FROM
      v_intent.workspace_id::text AND
    (NOT (v_run.envelope_jsonb ? 'idempotencyKey') OR
      v_run.envelope_jsonb->>'idempotencyKey' = v_intent.idempotency_key) AND
    v_run.envelope_jsonb->>'executionScopeId' = p_scope_id AND
    v_run.envelope_jsonb->>'audience' = v_intent.meri_audience AND
    v_run.envelope_jsonb->>'authorizationVersion' = v_intent.authorization_version AND
    v_run.envelope_jsonb->'authorizedClientIds' = to_jsonb(v_client_ids) AND
    v_run.envelope_jsonb->'authorizedMailboxConnectionIds' =
      to_jsonb(v_mailbox_ids) AND
    v_run.actor_context_jsonb->>'tenantId' = p_tenant_id::text AND
    v_run.actor_context_jsonb->>'tenantSlug' = v_actor.tenant_slug AND
    v_run.actor_context_jsonb->>'userId' = v_intent.actor_id::text AND
    v_run.actor_context_jsonb->>'clerkUserId' = v_actor.clerk_user_id AND
    v_run.actor_context_jsonb->>'role' = v_actor.role AND
    v_envelope_issued_at IS NOT NULL AND v_envelope_expires_at IS NOT NULL AND
    floor(extract(epoch FROM v_envelope_issued_at) * 1000000)::bigint <= v_now AND
    v_now < floor(extract(epoch FROM v_envelope_expires_at) * 1000000)::bigint AND
    v_route.enabled = true AND v_route.closed_at_epoch_micros IS NULL AND
    v_now >= v_route.not_before_epoch_micros AND
    v_now < v_route.not_after_epoch_micros AND
    v_binding.revoked_at_epoch_micros IS NULL AND
    v_binding.binding_version = 2 AND
    v_now >= v_binding.not_before_epoch_micros AND
    v_now < v_binding.not_after_epoch_micros AND
    v_binding.worker_catalog_digest = v_intent.catalog_digest AND
    v_binding.applied_tool_view_digest_algorithm =
      'capiro.meri.phase4.applied-tool-view/v1' AND
    v_binding.tool_view_protocol =
      'capiro.meri.phase4.request-local-tool-view/v1' AND
    v_binding.claim_attestation_protocol =
      'capiro.meri.phase4.claim-tool-view-attestation/v1' AND
    v_binding.attestation_credential_id = v_intent.worker_credential_id
  ), false);

  IF jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,allow}') = 'array' AND
     jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,deny}') = 'array' AND
     jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,readOnly}') = 'boolean' AND
     v_run.envelope_jsonb #> '{toolPolicy,readOnly}' = 'false'::jsonb THEN
    v_tool_allowed := EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        v_run.envelope_jsonb #> '{toolPolicy,allow}'
      ) allowed(tool) WHERE allowed.tool = 'meri_record_turn'
    ) AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        v_run.envelope_jsonb #> '{toolPolicy,deny}'
      ) denied(tool) WHERE denied.tool = 'meri_record_turn'
    );
  END IF;
  BEGIN
    v_cap := (v_run.envelope_jsonb #>> '{budget,maxToolCalls}')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_cap := NULL;
  END;

  IF v_run.stop_requested_at IS NOT NULL OR v_run.status = 'cancelling' THEN
    v_result := 'denied_before_effect'; v_detail := 'stop_requested';
  ELSIF v_run.status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') THEN
    v_result := 'denied_before_effect'; v_detail := 'run_terminal';
  ELSIF NOT v_authority_current THEN
    v_result := 'denied_before_effect'; v_detail := 'authority_closed';
  ELSIF NOT v_tool_allowed THEN
    v_result := 'denied_before_effect'; v_detail := 'tool_denied';
  ELSIF p_effect_disposition = 'effect_unknown' THEN
    v_result := 'effect_unknown'; v_detail := 'caller_reported_unknown';
  ELSIF v_cap IS NULL OR v_cap < 0 OR v_run.broker_calls >= v_cap THEN
    v_result := 'denied_before_effect'; v_detail := 'tool_budget_exhausted';
  ELSE
    v_result := 'committed'; v_detail := 'recorded';
  END IF;

  IF v_result = 'committed' THEN
    v_calls_after := v_calls_before + 1;
    v_event_seq := v_run.last_seq + 1;
    v_result_summary := 'recorded';
    v_domain_ref := 'meri_institutional_memory';
  ELSIF v_result = 'effect_unknown' THEN
    v_calls_after := v_calls_before;
    v_event_seq := NULL;
    v_result_summary := 'unknown';
    v_domain_ref := NULL;
  ELSE
    v_calls_after := v_calls_before;
    v_event_seq := NULL;
    v_result_summary := 'denied';
    v_domain_ref := NULL;
  END IF;

  v_claims_sha256 := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.broker-effect-receipt-claims/v1', p_tenant_id::text,
    p_run_id::text, p_worker_run_id, p_dispatch_request_sha256::text,
    p_scope_id, p_operation_id::text, 'meri_record_turn',
    p_canonical_request_sha256::text, v_result, v_detail,
    v_calls_before::text, v_calls_after::text,
    coalesce(v_event_seq::text, 'null'), v_result_summary,
    coalesce(v_domain_ref, 'null')
  ]);

  SELECT a.* INTO v_attestation
  FROM public.meri_phase4_broker_effect_signature_attestations a
  WHERE a.claims_sha256 = v_claims_sha256 AND
    a.verified_at_epoch_micros <= v_now AND a.expires_at_epoch_micros > v_now;
  IF NOT FOUND AND v_result <> 'effect_unknown' THEN
    RAISE EXCEPTION 'verified Phase 4 broker-effect signature is unavailable'
      USING ERRCODE = '55000';
  END IF;

  -- Preserve at least the 90-day broker-effect policy horizon and the dispatch
  -- identity horizon, but reject malformed authority that exceeds one year.
  v_retain := greatest(
    v_now + 7776000000000,
    coalesce(v_intent.retain_until_epoch_micros, 0)
  );
  IF v_retain > v_now + 31536000000000 THEN
    RAISE EXCEPTION 'Phase 4 broker-effect retention horizon is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF v_existing_operation.operation_id IS NULL THEN
    INSERT INTO public.meri_phase4_broker_effect_operations (
      operation_id, tenant_id, run_id, worker_run_id,
      dispatch_request_sha256, scope_id, tool_name,
      canonical_request_sha256, user_chars, assistant_chars,
      effect_disposition, created_at_epoch_micros, retain_until_epoch_micros
    ) VALUES (
      p_operation_id, p_tenant_id, p_run_id, p_worker_run_id,
      p_dispatch_request_sha256, p_scope_id, 'meri_record_turn',
      p_canonical_request_sha256, p_user_chars, p_assistant_chars,
      p_effect_disposition, v_now, v_retain
    );
  END IF;

  IF v_result = 'committed' THEN
    UPDATE public.meri_agent_runs r
      SET broker_calls = r.broker_calls + 1, last_seq = r.last_seq + 1,
          updated_at = clock_timestamp()
    WHERE r.tenant_id = p_tenant_id AND r.id = p_run_id AND
      r.scope_id = p_scope_id AND r.hermes_run_id = p_worker_run_id AND
      r.dispatch_status = 'dispatched' AND
      r.stop_requested_at IS NULL AND
      r.status NOT IN ('cancelling', 'completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
      r.broker_calls = v_calls_before AND r.broker_calls < v_cap AND
      r.last_seq + 1 = v_event_seq
    RETURNING r.broker_calls, r.last_seq
      INTO v_calls_after, v_event_seq;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phase 4 record-turn effect fence lost'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.meri_agent_run_events (
      run_id, seq, kind, visibility, payload_jsonb, at
    ) VALUES (
      p_run_id, v_event_seq, 'run.status', 'internal',
      jsonb_build_object(
        'providerSyncTurn', true,
        'userChars', p_user_chars,
        'assistantChars', p_assistant_chars,
        'frames', '[]'::jsonb,
        'brokerEffectOperationId', p_operation_id
      ), clock_timestamp()
    );
  END IF;

  v_receipt_sha256 := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.broker-effect-receipt/v1',
    v_claims_sha256::text, coalesce(v_attestation.signer_key_id, 'null'),
    coalesce(v_attestation.signature, 'null'),
    coalesce(v_attestation.qualification_sha256::text, 'null')
  ]);
  INSERT INTO public.meri_phase4_broker_effect_receipts (
    operation_id, tenant_id, run_id, worker_run_id,
    dispatch_request_sha256, scope_id, tool_name,
    canonical_request_sha256, result, detail,
    broker_calls_before, broker_calls_after, event_seq,
    result_summary, domain_ref, signed_claims_sha256,
    signer_key_id, signature, qualification_sha256,
    signature_verified_at_epoch_micros,
    receipt_sha256, applied_at_epoch_micros, retain_until_epoch_micros
  ) VALUES (
    p_operation_id, p_tenant_id, p_run_id, p_worker_run_id,
    p_dispatch_request_sha256, p_scope_id, 'meri_record_turn',
    p_canonical_request_sha256, v_result, v_detail,
    v_calls_before, v_calls_after, v_event_seq,
    v_result_summary, v_domain_ref, v_claims_sha256,
    v_attestation.signer_key_id, v_attestation.signature,
    v_attestation.qualification_sha256,
    v_attestation.verified_at_epoch_micros, v_receipt_sha256,
    v_now, v_retain
  ) RETURNING meri_phase4_broker_effect_receipts.receipt_id,
      meri_phase4_broker_effect_receipts.applied_at
    INTO v_receipt_id, v_applied_at;

  receipt_id := v_receipt_id;
  result := v_result;
  detail := v_detail;
  broker_calls_before := v_calls_before;
  broker_calls_after := v_calls_after;
  event_seq := v_event_seq;
  applied_at := v_applied_at;
  applied_at_epoch_micros := v_now;
  retain_until_epoch_micros := v_retain;
  signed_claims_sha256 := v_claims_sha256;
  signer_key_id := v_attestation.signer_key_id;
  signature := v_attestation.signature;
  signature_verified_at_epoch_micros := v_attestation.verified_at_epoch_micros;
  qualification_sha256 := v_attestation.qualification_sha256;
  receipt_sha256 := v_receipt_sha256;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION public.meri_phase4_guard_broker_effect_append_only()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Phase 4 broker-effect evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meri_p4_broker_signature_append_only
  BEFORE UPDATE OR DELETE
  ON public.meri_phase4_broker_effect_signature_attestations
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_broker_effect_append_only();
CREATE TRIGGER meri_p4_broker_operation_append_only
  BEFORE UPDATE OR DELETE ON public.meri_phase4_broker_effect_operations
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_broker_effect_append_only();
CREATE TRIGGER meri_p4_broker_receipt_append_only
  BEFORE UPDATE OR DELETE ON public.meri_phase4_broker_effect_receipts
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_broker_effect_append_only();

ALTER TABLE public.meri_phase4_broker_effect_signature_attestations
  OWNER TO meri_phase4_broker_signer_owner;
ALTER TABLE public.meri_phase4_broker_effect_operations
  OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_broker_effect_receipts
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_record_turn_effect(
  uuid,uuid,varchar,char,varchar,uuid,char,integer,integer,varchar
) OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_broker_effect_append_only()
  OWNER TO meri_phase4_authority_owner;

-- The existing inaccessible authority owner is appropriate here because the
-- effect must lock current authority and mutate run/event state atomically.
-- It receives only the missing columns; the new operator receives no tables.
GRANT SELECT ON TABLE public.meri_agent_runs,
  public.meri_agent_dispatch_intents,
  public.meri_phase4_authority_fences,
  public.meri_phase4_worker_routes,
  public.meri_phase4_worker_bindings,
  public.meri_phase4_worker_binding_sources
  TO meri_phase4_authority_owner;
GRANT SELECT (id, status, slug) ON TABLE public.tenants
  TO meri_phase4_authority_owner;
GRANT SELECT (id, clerk_user_id) ON TABLE public.users
  TO meri_phase4_authority_owner;
GRANT SELECT (tenant_id, user_id, role, status)
  ON TABLE public.tenant_memberships TO meri_phase4_authority_owner;
GRANT SELECT (id, tenant_id, memory_wall) ON TABLE public.clients
  TO meri_phase4_authority_owner;
GRANT SELECT (id, tenant_id, client_id, user_id)
  ON TABLE public.client_memory_access TO meri_phase4_authority_owner;
GRANT SELECT (id, tenant_id, created_by_user_id, provider)
  ON TABLE public.engagement_connections TO meri_phase4_authority_owner;
GRANT SELECT (id, tenant_id, user_id, client_id, workspace_id, status, archived_at)
  ON TABLE public.clio_conversations TO meri_phase4_authority_owner;
GRANT SELECT (id, tenant_id, principal_type, principal_id, kind, authorization_version)
  ON TABLE public.meri_execution_scopes TO meri_phase4_authority_owner;
GRANT SELECT ON TABLE public.meri_phase4_broker_effect_signature_attestations
  TO meri_phase4_authority_owner;
GRANT UPDATE (broker_calls, last_seq, updated_at)
  ON TABLE public.meri_agent_runs TO meri_phase4_authority_owner;
GRANT INSERT ON TABLE public.meri_agent_run_events TO meri_phase4_authority_owner;

REVOKE ALL ON TABLE
  public.meri_phase4_broker_effect_signature_attestations,
  public.meri_phase4_broker_effect_operations,
  public.meri_phase4_broker_effect_receipts
  FROM PUBLIC, capiro_app, meri_phase4_route_operator,
       meri_phase4_recovery_operator, meri_phase4_broker_effect_operator;
REVOKE ALL ON FUNCTION public.meri_phase4_record_turn_effect(
  uuid,uuid,varchar,char,varchar,uuid,char,integer,integer,varchar
), public.meri_phase4_guard_broker_effect_append_only()
  FROM PUBLIC, capiro_app, meri_phase4_route_operator,
       meri_phase4_recovery_operator, meri_phase4_broker_effect_operator;
GRANT USAGE ON SCHEMA public TO meri_phase4_broker_effect_operator;
REVOKE CREATE ON SCHEMA public FROM meri_phase4_broker_effect_operator;
GRANT EXECUTE ON FUNCTION public.meri_phase4_record_turn_effect(
  uuid,uuid,varchar,char,varchar,uuid,char,integer,integer,varchar
) TO meri_phase4_broker_effect_operator;

CREATE FUNCTION public.meri_phase4_broker_effect_default_acl_probe()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS 'SELECT 1';
DO $$
DECLARE exposure text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    WHERE p.oid = 'public.meri_phase4_broker_effect_default_acl_probe()'::regprocedure AND
      x.grantee = 0 AND x.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'new broker-effect routines inherit PUBLIC EXECUTE'
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
    RAISE EXCEPTION 'unsafe PUBLIC routine after broker-effect migration: %', exposure
      USING ERRCODE = '42501';
  END IF;
END $$;
DROP FUNCTION public.meri_phase4_broker_effect_default_acl_probe();

REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;
REVOKE CREATE ON SCHEMA public FROM meri_phase4_broker_signer_owner;
DO $$ BEGIN
  EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user);
  EXECUTE format('REVOKE meri_phase4_broker_signer_owner FROM %I', current_user);
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_broker_effect_operator'::regrole,
      'meri_phase4_broker_signer_owner'::regrole
    ) OR m.member IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_broker_effect_operator'::regrole,
      'meri_phase4_broker_signer_owner'::regrole
    )
  ) THEN
    RAISE EXCEPTION 'Phase 4 broker-effect role membership survived migration'
      USING ERRCODE = '42501';
  END IF;
  IF has_schema_privilege('meri_phase4_authority_owner', 'public', 'CREATE') OR
     has_schema_privilege('meri_phase4_broker_effect_operator', 'public', 'CREATE') OR
     has_schema_privilege('meri_phase4_broker_signer_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Phase 4 broker-effect role retained schema CREATE'
      USING ERRCODE = '42501';
  END IF;
  IF has_table_privilege('meri_phase4_broker_effect_operator',
       'public.meri_phase4_broker_effect_operations', 'SELECT,INSERT,UPDATE,DELETE') OR
     has_table_privilege('meri_phase4_broker_effect_operator',
       'public.meri_phase4_broker_effect_receipts', 'SELECT,INSERT,UPDATE,DELETE') OR
     has_table_privilege('meri_phase4_broker_effect_operator',
       'public.meri_phase4_broker_effect_signature_attestations',
       'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'broker-effect operator retained direct table authority'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMIT;
