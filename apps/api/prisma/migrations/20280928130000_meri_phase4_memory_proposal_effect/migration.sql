-- Dormant Phase 4 idempotent broker effect for meri_propose_memory.
-- Extends the global operation namespace established for meri_record_turn;
-- it does not register a runtime caller, signer, key, or ingress.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_authority_owner') OR
     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_broker_effect_operator') OR
     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_broker_signer_owner') THEN
    RAISE EXCEPTION 'Phase 4 broker-effect authority is unavailable'
      USING ERRCODE = '42501';
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
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'memory-proposal migration executor cannot acquire owner authority'
      USING ERRCODE = '42501';
  END;
END $$;

GRANT CREATE ON SCHEMA public TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_broker_effect_operations
  ADD COLUMN memory_key varchar,
  ADD COLUMN memory_value_sha256 char(64),
  ADD COLUMN memory_scope varchar(16),
  ADD COLUMN memory_client_id uuid,
  ADD COLUMN memory_confidence float8,
  ADD COLUMN memory_source_excerpt_length integer;

ALTER TABLE public.meri_phase4_broker_effect_operations
  DROP CONSTRAINT meri_p4_broker_effect_operation_shape,
  ADD CONSTRAINT meri_p4_broker_effect_operation_shape CHECK (
    worker_run_id ~ '^[!-~]{1,120}$' AND
    dispatch_request_sha256 ~ '^[0-9a-f]{64}$' AND
    length(scope_id) BETWEEN 1 AND 200 AND btrim(scope_id) = scope_id AND
    canonical_request_sha256 ~ '^[0-9a-f]{64}$' AND
    effect_disposition IN ('attempt', 'effect_unknown') AND
    created_at_epoch_micros > 0 AND
    retain_until_epoch_micros > created_at_epoch_micros AND
    retain_until_epoch_micros - created_at_epoch_micros <= 31536000000000 AND
    ((tool_name = 'meri_record_turn' AND
      (user_chars IS NULL OR user_chars BETWEEN 0 AND 100000000) AND
      (assistant_chars IS NULL OR assistant_chars BETWEEN 0 AND 100000000) AND
      clarification_question IS NULL AND clarification_choices_jsonb IS NULL AND
      clarification_multi_select IS NULL AND
      memory_key IS NULL AND memory_value_sha256 IS NULL AND
      memory_scope IS NULL AND memory_client_id IS NULL AND
      memory_confidence IS NULL AND memory_source_excerpt_length IS NULL) OR
     (tool_name = 'meri_request_clarification' AND user_chars IS NULL AND
      assistant_chars IS NULL AND clarification_question IS NOT NULL AND
      char_length(clarification_question) BETWEEN 1 AND 2000 AND
      btrim(clarification_question) = clarification_question AND
      jsonb_typeof(clarification_choices_jsonb) = 'array' AND
      jsonb_array_length(clarification_choices_jsonb) BETWEEN 0 AND 4 AND
      clarification_multi_select IS NOT NULL AND
      (NOT clarification_multi_select OR
       jsonb_array_length(clarification_choices_jsonb) > 0) AND
      memory_key IS NULL AND memory_value_sha256 IS NULL AND
      memory_scope IS NULL AND memory_client_id IS NULL AND
      memory_confidence IS NULL AND memory_source_excerpt_length IS NULL) OR
     (tool_name = 'meri_propose_memory' AND user_chars IS NULL AND
      assistant_chars IS NULL AND clarification_question IS NULL AND
      clarification_choices_jsonb IS NULL AND clarification_multi_select IS NULL AND
      memory_key IS NOT NULL AND char_length(memory_key) BETWEEN 1 AND 200 AND
      btrim(memory_key) = memory_key AND
      memory_value_sha256 ~ '^[0-9a-f]{64}$' AND
      memory_scope IN ('personal', 'firm', 'client') AND
      ((memory_scope = 'client' AND memory_client_id IS NOT NULL) OR
       (memory_scope <> 'client' AND memory_client_id IS NULL)) AND
      (memory_confidence IS NULL OR
       (memory_confidence >= 0 AND memory_confidence <= 1)) AND
      (memory_source_excerpt_length IS NULL OR
       memory_source_excerpt_length BETWEEN 0 AND 4000)))
  );

ALTER TABLE public.meri_phase4_broker_effect_receipts
  DROP CONSTRAINT meri_p4_broker_effect_receipt_shape,
  ADD CONSTRAINT meri_p4_broker_effect_receipt_shape CHECK (
    worker_run_id ~ '^[!-~]{1,120}$' AND
    dispatch_request_sha256 ~ '^[0-9a-f]{64}$' AND
    tool_name IN ('meri_record_turn', 'meri_request_clarification', 'meri_propose_memory') AND
    canonical_request_sha256 ~ '^[0-9a-f]{64}$' AND
    result IN ('committed', 'denied_before_effect', 'effect_unknown') AND
    length(detail) BETWEEN 1 AND 64 AND btrim(detail) = detail AND
    broker_calls_before >= 0 AND broker_calls_after >= 0 AND
    (event_seq IS NULL OR event_seq > 0) AND
    length(result_summary) BETWEEN 1 AND 64 AND
    btrim(result_summary) = result_summary AND
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
    ((result = 'committed' AND broker_calls_after = broker_calls_before + 1 AND
      event_seq IS NOT NULL AND signature IS NOT NULL AND
      ((tool_name = 'meri_record_turn' AND detail = 'recorded' AND
        result_summary = 'recorded' AND domain_ref = 'meri_institutional_memory') OR
       (tool_name = 'meri_request_clarification' AND
        detail = 'clarification_requested' AND
        result_summary = 'clarification_requested' AND
        domain_ref = 'clar_' || operation_id::text) OR
       (tool_name = 'meri_propose_memory' AND
        detail = 'memory_proposed' AND
        result_summary = 'memory_proposed' AND
        domain_ref = 'memcand_' || operation_id::text))) OR
     (result = 'denied_before_effect' AND
      broker_calls_after = broker_calls_before AND event_seq IS NULL AND
      result_summary = 'denied' AND domain_ref IS NULL AND signature IS NOT NULL) OR
     (result = 'effect_unknown' AND detail = 'caller_reported_unknown' AND
      broker_calls_after = broker_calls_before AND event_seq IS NULL AND
      result_summary = 'unknown' AND domain_ref IS NULL AND
      signer_key_id IS NULL AND signature IS NULL AND
      qualification_sha256 IS NULL AND
      signature_verified_at_epoch_micros IS NULL))
  );

CREATE POLICY meri_p4_memory_candidate_insert_owner
  ON public.memory_candidate FOR INSERT
  TO meri_phase4_authority_owner
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

CREATE POLICY meri_p4_review_request_insert_owner
  ON public.review_request FOR INSERT
  TO meri_phase4_authority_owner
  WITH CHECK (current_user = 'meri_phase4_authority_owner');
CREATE FUNCTION public.meri_phase4_propose_memory_effect(
  p_tenant_id uuid,
  p_run_id uuid,
  p_worker_run_id varchar,
  p_dispatch_request_sha256 char(64),
  p_scope_id varchar,
  p_operation_id uuid,
  p_canonical_request_sha256 char(64),
  p_key varchar,
  p_value text,
  p_scope varchar,
  p_client_id uuid,
  p_confidence float8,
  p_source_excerpt text,
  p_effect_disposition varchar
) RETURNS TABLE (
  receipt_id uuid,
  result varchar,
  detail varchar,
  scope varchar,
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
  v_candidate_id varchar(120) := 'memcand_' || p_operation_id::text;
  v_receipt_id uuid;
  v_applied_at timestamptz;
  v_memory_value_sha256 char(64);
  v_memory_source_excerpt_length integer;
BEGIN
  -- Normalize value SHA-256 and source excerpt length for operation storage.
  -- Raw value text is NOT stored in the operation row (handoff requirement).
  v_memory_value_sha256 := encode(sha256(convert_to(btrim(p_value), 'UTF8')), 'hex');
  v_memory_source_excerpt_length := CASE
    WHEN p_source_excerpt IS NULL THEN NULL
    ELSE char_length(left(p_source_excerpt, 4000))
  END;

  IF current_setting('role', true) IS DISTINCT FROM
       'meri_phase4_broker_effect_operator' OR
     p_tenant_id IS NULL OR p_run_id IS NULL OR p_worker_run_id IS NULL OR
     p_dispatch_request_sha256 IS NULL OR p_scope_id IS NULL OR
     p_operation_id IS NULL OR p_canonical_request_sha256 IS NULL OR
     p_key IS NULL OR p_value IS NULL OR p_scope IS NULL OR
     p_effect_disposition IS NULL OR
     p_effect_disposition NOT IN ('attempt', 'effect_unknown') OR
     p_worker_run_id !~ '^[!-~]{1,120}$' OR
     p_dispatch_request_sha256::text !~ '^[0-9a-f]{64}$' OR
     p_canonical_request_sha256::text !~ '^[0-9a-f]{64}$' OR
     length(p_scope_id) NOT BETWEEN 1 AND 200 OR btrim(p_scope_id) <> p_scope_id OR
     char_length(p_key) NOT BETWEEN 1 AND 200 OR btrim(p_key) <> p_key OR
     char_length(btrim(p_value)) NOT BETWEEN 1 AND 8000 OR
     p_scope NOT IN ('personal', 'firm', 'client') OR
     (p_scope = 'client' AND p_client_id IS NULL) OR
     (p_scope <> 'client' AND p_client_id IS NOT NULL) OR
     (p_confidence IS NOT NULL AND
       (p_confidence < 0 OR p_confidence > 1 OR p_confidence <> p_confidence)) OR
     (p_source_excerpt IS NOT NULL AND char_length(p_source_excerpt) > 4000) THEN
    RAISE EXCEPTION 'Phase 4 memory proposal authority is unavailable'
      USING ERRCODE = '42501';
  END IF;
  v_canonical_request_sha256 := public.meri_phase4_route_digest_v1(
    ARRAY[
      'capiro.meri.phase4.broker-effect-request/v1', p_tenant_id::text,
      p_run_id::text, p_worker_run_id, p_dispatch_request_sha256::text,
      p_scope_id, 'meri_propose_memory', btrim(p_key), btrim(p_value),
      p_scope, coalesce(p_client_id::text, 'null'),
      CASE WHEN p_confidence IS NULL THEN 'null'
           ELSE encode(float8send(p_confidence), 'hex') END,
      coalesce(left(p_source_excerpt, 4000), 'null')
    ]
  );
  IF v_canonical_request_sha256 IS DISTINCT FROM p_canonical_request_sha256 THEN
    RAISE EXCEPTION 'Phase 4 memory proposal canonical request mismatch'
      USING ERRCODE = '23505';
  END IF;

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
      v_existing_operation.memory_key,
      v_existing_operation.memory_value_sha256,
      v_existing_operation.memory_scope,
      v_existing_operation.memory_client_id,
      v_existing_operation.memory_confidence,
      v_existing_operation.memory_source_excerpt_length
    ) IS DISTINCT FROM ROW(
      p_operation_id, p_tenant_id, p_run_id, p_worker_run_id,
      p_dispatch_request_sha256, p_scope_id,
      'meri_propose_memory'::varchar, p_canonical_request_sha256,
      btrim(p_key), v_memory_value_sha256, p_scope, p_client_id,
      p_confidence, v_memory_source_excerpt_length
    ) THEN
      RAISE EXCEPTION 'Phase 4 memory proposal operation replay drift'
        USING ERRCODE = '23505';
    END IF;
    SELECT r.* INTO v_existing_receipt
    FROM public.meri_phase4_broker_effect_receipts r
    WHERE r.operation_id = p_operation_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phase 4 memory proposal operation has no receipt'
        USING ERRCODE = '55000';
    END IF;
    receipt_id := v_existing_receipt.receipt_id;
    result := v_existing_receipt.result;
    detail := v_existing_receipt.detail;
    scope := p_scope;
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
  IF p_effect_disposition <> 'effect_unknown' THEN
    SELECT f.* INTO v_fence FROM public.meri_phase4_authority_fences f
    WHERE f.tenant_id = p_tenant_id FOR SHARE;
    IF NOT FOUND THEN v_authority_current := false; END IF;
  END IF;

  SELECT r.* INTO v_run FROM public.meri_agent_runs r
  WHERE r.tenant_id = p_tenant_id AND r.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phase 4 clarification run is unavailable'
      USING ERRCODE = '23503';
  END IF;
  v_calls_before := v_run.broker_calls;

  SELECT i.* INTO v_intent FROM public.meri_agent_dispatch_intents i
  WHERE i.tenant_id = p_tenant_id AND i.run_id = p_run_id FOR SHARE;
  IF NOT FOUND THEN v_authority_current := false; END IF;
  IF p_effect_disposition <> 'effect_unknown' THEN
  SELECT s.id, s.tenant_id, s.principal_type, s.principal_id, s.kind,
      s.authorization_version
    INTO v_scope
  FROM public.meri_execution_scopes s
  WHERE s.tenant_id = p_tenant_id AND s.id = p_scope_id;
  IF NOT FOUND THEN v_authority_current := false; END IF;

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
    v_intent.identity_version = 2 AND v_intent.actor_type = 'user' AND
    v_intent.meri_audience = 'private' AND
    v_intent.worker_audience = 'meri-hermes-scope-worker' AND
    v_run.scope_id = p_scope_id AND v_run.actor_id = v_intent.actor_id AND
    v_run.conversation_id = v_intent.conversation_id AND
    v_run.user_message_id = v_intent.user_message_id AND
    v_run.idempotency_key = v_intent.idempotency_key AND
    v_run.hermes_run_id = p_worker_run_id AND
    v_run.dispatch_status = 'dispatched' AND v_intent.state = 'claimed' AND
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
    v_scope.tenant_id = p_tenant_id AND v_scope.principal_type = 'user' AND
    v_scope.principal_id = v_intent.actor_id::text AND v_scope.kind = 'private' AND
    p_scope_id = 'tenant:' || p_tenant_id::text || ':user:' ||
      v_intent.actor_id::text AND
    v_scope.authorization_version = v_intent.authorization_version AND
    v_conversation.tenant_id = p_tenant_id AND
    v_conversation.user_id = v_intent.actor_id AND
    v_conversation.client_id IS NOT DISTINCT FROM v_intent.client_id AND
    v_conversation.workspace_id IS NOT DISTINCT FROM v_intent.workspace_id AND
    v_conversation.status = 'active' AND v_conversation.archived_at IS NULL AND
    (v_intent.client_id IS NULL OR v_intent.client_id::text = ANY(v_client_ids)) AND
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
    v_run.envelope_jsonb->'authorizedMailboxConnectionIds' = to_jsonb(v_mailbox_ids) AND
    v_run.actor_context_jsonb->>'tenantId' = p_tenant_id::text AND
    v_run.actor_context_jsonb->>'tenantSlug' = v_actor.tenant_slug AND
    v_run.actor_context_jsonb->>'userId' = v_intent.actor_id::text AND
    v_run.actor_context_jsonb->>'clerkUserId' = v_actor.clerk_user_id AND
    v_run.actor_context_jsonb->>'role' = v_actor.role AND
    v_envelope_issued_at IS NOT NULL AND v_envelope_expires_at IS NOT NULL AND
    floor(extract(epoch FROM v_envelope_issued_at) * 1000000)::bigint <= v_now AND
    v_now < floor(extract(epoch FROM v_envelope_expires_at) * 1000000)::bigint AND
    v_route.enabled = true AND v_route.closed_at_epoch_micros IS NULL AND
    v_now >= v_route.not_before_epoch_micros AND v_now < v_route.not_after_epoch_micros AND
    v_binding.revoked_at_epoch_micros IS NULL AND v_binding.binding_version = 2 AND
    v_now >= v_binding.not_before_epoch_micros AND
    v_now < v_binding.not_after_epoch_micros AND
    v_binding.worker_catalog_digest = v_intent.catalog_digest AND
    v_binding.applied_tool_view_digest_algorithm =
      'capiro.meri.phase4.applied-tool-view/v1' AND
    v_binding.tool_view_protocol = 'capiro.meri.phase4.request-local-tool-view/v1' AND
    v_binding.claim_attestation_protocol =
      'capiro.meri.phase4.claim-tool-view-attestation/v1' AND
    v_binding.attestation_credential_id = v_intent.worker_credential_id
  ), false);

  IF jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,allow}') = 'array' AND
     jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,deny}') = 'array' AND
     jsonb_typeof(v_run.envelope_jsonb #> '{toolPolicy,readOnly}') = 'boolean' THEN
    v_tool_allowed := EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        v_run.envelope_jsonb #> '{toolPolicy,allow}'
      ) allowed(tool) WHERE allowed.tool = 'meri_propose_memory'
    ) AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        v_run.envelope_jsonb #> '{toolPolicy,deny}'
      ) denied(tool) WHERE denied.tool = 'meri_propose_memory'
    );
  END IF;
  BEGIN
    v_cap := (v_run.envelope_jsonb #>> '{budget,maxToolCalls}')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    v_cap := NULL;
  END;
  END IF;


  IF p_effect_disposition = 'effect_unknown' THEN
    v_result := 'effect_unknown'; v_detail := 'caller_reported_unknown';
  ELSIF v_run.stop_requested_at IS NOT NULL OR v_run.status = 'cancelling' THEN
    v_result := 'denied_before_effect'; v_detail := 'stop_requested';
  ELSIF v_run.status IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired') THEN
    v_result := 'denied_before_effect'; v_detail := 'run_terminal';
  ELSIF NOT v_authority_current THEN
    v_result := 'denied_before_effect'; v_detail := 'authority_closed';
  ELSIF NOT v_tool_allowed THEN
    v_result := 'denied_before_effect'; v_detail := 'tool_denied';
  ELSIF v_cap IS NULL OR v_cap < 0 OR v_cap > 40 OR v_run.broker_calls >= v_cap THEN
    v_result := 'denied_before_effect'; v_detail := 'tool_budget_exhausted';
  ELSE
    v_result := 'committed'; v_detail := 'memory_proposed';
  END IF;

  IF v_result = 'committed' THEN
    v_calls_after := v_calls_before + 1;
    v_event_seq := v_run.last_seq + 1;
    v_result_summary := 'memory_proposed';
    v_domain_ref := v_candidate_id;
  ELSIF v_result = 'effect_unknown' THEN
    v_calls_after := v_calls_before; v_event_seq := NULL;
    v_result_summary := 'unknown'; v_domain_ref := NULL;
  ELSE
    v_calls_after := v_calls_before; v_event_seq := NULL;
    v_result_summary := 'denied'; v_domain_ref := NULL;
  END IF;

  v_claims_sha256 := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.broker-effect-receipt-claims/v1', p_tenant_id::text,
    p_run_id::text, p_worker_run_id, p_dispatch_request_sha256::text,
    p_scope_id, p_operation_id::text, 'meri_propose_memory',
    p_canonical_request_sha256::text, v_result, v_detail,
    v_calls_before::text, v_calls_after::text,
    coalesce(v_event_seq::text, 'null'), v_result_summary,
    coalesce(v_domain_ref, 'null')
  ]);

  IF v_result <> 'effect_unknown' THEN
    SELECT a.* INTO v_attestation
    FROM public.meri_phase4_broker_effect_signature_attestations a
    WHERE a.claims_sha256 = v_claims_sha256 AND
      a.verified_at_epoch_micros <= v_now AND a.expires_at_epoch_micros > v_now;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'verified Phase 4 broker-effect signature is unavailable'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  v_retain := greatest(v_now + 7776000000000,
    coalesce(v_intent.retain_until_epoch_micros, 0));
  IF v_retain > v_now + 31536000000000 THEN
    RAISE EXCEPTION 'Phase 4 broker-effect retention horizon is invalid'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.meri_phase4_broker_effect_operations (
    operation_id, tenant_id, run_id, worker_run_id,
    dispatch_request_sha256, scope_id, tool_name,
    canonical_request_sha256, user_chars, assistant_chars,
    clarification_question, clarification_choices_jsonb,
    clarification_multi_select, memory_key, memory_value_sha256,
    memory_scope, memory_client_id, memory_confidence,
    memory_source_excerpt_length, effect_disposition,
    created_at_epoch_micros, retain_until_epoch_micros
  ) VALUES (
    p_operation_id, p_tenant_id, p_run_id, p_worker_run_id,
    p_dispatch_request_sha256, p_scope_id, 'meri_propose_memory',
    p_canonical_request_sha256, NULL, NULL, NULL, NULL,
    NULL, btrim(p_key), v_memory_value_sha256,
    p_scope, p_client_id, p_confidence,
    v_memory_source_excerpt_length, p_effect_disposition,
    v_now, v_retain
  );

  IF v_result = 'committed' THEN
    UPDATE public.meri_agent_runs r
      SET broker_calls = r.broker_calls + 1, last_seq = r.last_seq + 1,
          updated_at = clock_timestamp()
    WHERE r.tenant_id = p_tenant_id AND r.id = p_run_id AND
      r.scope_id = p_scope_id AND r.hermes_run_id = p_worker_run_id AND
      r.dispatch_status = 'dispatched' AND r.stop_requested_at IS NULL AND
      r.status NOT IN ('cancelling', 'completed', 'cancelled', 'failed', 'interrupted', 'expired') AND
      r.broker_calls = v_calls_before AND r.broker_calls < v_cap AND
      v_cap BETWEEN 0 AND 40 AND r.last_seq + 1 = v_event_seq
    RETURNING r.broker_calls, r.last_seq INTO v_calls_after, v_event_seq;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phase 4 memory proposal effect fence lost'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.memory_candidate (
      id, tenant_id, proposed_by, source_kind, scope, client_id,
      payload_jsonb, provenance_jsonb, confidence, status,
      memory_class, memory_authority, memory_scope, governed_status,
      source_type, source_id, source_excerpt, created_at
    ) VALUES (
      p_operation_id, p_tenant_id, v_intent.actor_id, 'model_extraction',
      p_scope, p_client_id,
      jsonb_build_object('key', btrim(p_key), 'value', btrim(p_value)),
      jsonb_build_object('brokerEffectOperationId', p_operation_id,
        'sourceKind', 'model_extraction'),
      p_confidence, 'pending', 'operational', 'ai_extracted',
      CASE p_scope WHEN 'personal' THEN 'user_private'
                   WHEN 'firm' THEN 'firm'
                   WHEN 'client' THEN 'client' END,
      'suggested', 'broker_effect', p_operation_id::text,
      left(p_source_excerpt, 4000),
      to_timestamp(v_now::numeric / 1000000)
    );
    IF p_scope IN ('firm', 'client') THEN
      INSERT INTO public.review_request (
        id, tenant_id, risk_tier, surface, subject_type, subject_id,
        client_id, title, reason, payload_jsonb, status, requested_by,
        created_at
      ) VALUES (
        p_operation_id, p_tenant_id, 'moderate', 'memory-proposal',
        'memory_candidate', p_operation_id::text, p_client_id,
        'Memory proposal: ' || left(btrim(p_key), 250),
        'AI-extracted memory requires review for ' || p_scope || ' scope',
        jsonb_build_object('brokerEffectOperationId', p_operation_id,
          'scope', p_scope),
        'pending', v_intent.actor_id,
        to_timestamp(v_now::numeric / 1000000)
      );
    END IF;
    INSERT INTO public.meri_agent_run_events (
      run_id, seq, kind, visibility, payload_jsonb, at
    ) VALUES (
      p_run_id, v_event_seq, 'memory.proposed', 'internal',
      jsonb_build_object(
        'candidateId', v_candidate_id, 'scope', p_scope,
        'key', btrim(p_key), 'brokerEffectOperationId', p_operation_id
      ), to_timestamp(v_now::numeric / 1000000)
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
    signature_verified_at_epoch_micros, receipt_sha256,
    applied_at_epoch_micros, retain_until_epoch_micros
  ) VALUES (
    p_operation_id, p_tenant_id, p_run_id, p_worker_run_id,
    p_dispatch_request_sha256, p_scope_id, 'meri_propose_memory',
    p_canonical_request_sha256, v_result, v_detail,
    v_calls_before, v_calls_after, v_event_seq,
    v_result_summary, v_domain_ref, v_claims_sha256,
    v_attestation.signer_key_id, v_attestation.signature,
    v_attestation.qualification_sha256, v_attestation.verified_at_epoch_micros,
    v_receipt_sha256, v_now, v_retain
  ) RETURNING meri_phase4_broker_effect_receipts.receipt_id,
      meri_phase4_broker_effect_receipts.applied_at
    INTO v_receipt_id, v_applied_at;

  receipt_id := v_receipt_id; result := v_result; detail := v_detail;
  scope := p_scope;
  broker_calls_before := v_calls_before; broker_calls_after := v_calls_after;
  event_seq := v_event_seq; applied_at := v_applied_at;
  applied_at_epoch_micros := v_now; retain_until_epoch_micros := v_retain;
  signed_claims_sha256 := v_claims_sha256;
  signer_key_id := v_attestation.signer_key_id;
  signature := v_attestation.signature;
  signature_verified_at_epoch_micros := v_attestation.verified_at_epoch_micros;
  qualification_sha256 := v_attestation.qualification_sha256;
  receipt_sha256 := v_receipt_sha256;
  RETURN NEXT;
END;
$$;
ALTER FUNCTION public.meri_phase4_propose_memory_effect(
  uuid,uuid,varchar,char,varchar,uuid,char,varchar,text,varchar,uuid,float8,text,varchar
) OWNER TO meri_phase4_authority_owner;

GRANT INSERT (
  id,tenant_id,proposed_by,source_kind,scope,client_id,payload_jsonb,
  provenance_jsonb,confidence,status,memory_class,memory_authority,
  memory_scope,governed_status,source_type,source_id,source_excerpt,created_at
) ON TABLE public.memory_candidate TO meri_phase4_authority_owner;

GRANT INSERT (
  id,tenant_id,risk_tier,surface,subject_type,subject_id,client_id,
  title,reason,payload_jsonb,status,requested_by,created_at
) ON TABLE public.review_request TO meri_phase4_authority_owner;

REVOKE ALL ON FUNCTION public.meri_phase4_propose_memory_effect(
  uuid,uuid,varchar,char,varchar,uuid,char,varchar,text,varchar,uuid,float8,text,varchar
) FROM PUBLIC, capiro_app, meri_phase4_route_operator,
       meri_phase4_recovery_operator, meri_phase4_broker_effect_operator;
GRANT EXECUTE ON FUNCTION public.meri_phase4_propose_memory_effect(
  uuid,uuid,varchar,char,varchar,uuid,char,varchar,text,varchar,uuid,float8,text,varchar
) TO meri_phase4_broker_effect_operator;

REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;
DO $$ BEGIN
  EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user);
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
     has_table_privilege('meri_phase4_broker_effect_operator',
       'public.memory_candidate', 'SELECT,INSERT,UPDATE,DELETE') OR
     has_table_privilege('meri_phase4_broker_effect_operator',
       'public.review_request', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'memory-proposal authority retained unsafe privilege'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMIT;