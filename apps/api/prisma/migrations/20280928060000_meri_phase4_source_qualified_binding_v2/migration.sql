-- Dormant Phase 4 source-qualified worker binding v2. Existing v1 bindings
-- remain immutable tombstones but are ineligible for predispatch and claim.

BEGIN;

-- This authority migration requires an administrative migration executor that
-- can grant this existing NOLOGIN owner to itself and grant schema CREATE.
-- Gate on those actual capabilities rather than PostgreSQL's rolsuper label so
-- managed-database administration roles remain eligible. Reacquire one
-- transaction-local ownership edge only after proving no unexpected member
-- exists, then remove it before commit. Schema CREATE is granted to the
-- inaccessible NOLOGIN owner only inside this transaction for ownership
-- transfer and is revoked again before commit.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
       OR m.member = 'meri_phase4_authority_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner membership pre-existed binding v2 migration'
      USING ERRCODE = '42501';
  END IF;
  BEGIN
    EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'Phase 4 binding v2 migration executor cannot acquire owner authority'
      USING ERRCODE = '42501';
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
      AND m.member = current_user::regrole AND m.grantor = current_user::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 binding v2 owner authority was not self-granted'
      USING ERRCODE = '42501';
  END IF;
END $$;

GRANT CREATE ON SCHEMA public TO meri_phase4_authority_owner;

ALTER TABLE public.meri_phase4_worker_bindings
  ADD COLUMN binding_version smallint,
  ADD COLUMN worker_image_digest char(64),
  ADD COLUMN worker_build_id varchar(128),
  ADD COLUMN worker_catalog_digest_algorithm varchar(80),
  ADD COLUMN worker_catalog_digest char(64),
  ADD COLUMN applied_tool_view_digest_algorithm varchar(80),
  ADD COLUMN meri_catalog_version varchar(128),
  ADD COLUMN meri_catalog_digest char(64),
  ADD COLUMN capability_mapping_version varchar(128),
  ADD COLUMN capability_mapping_digest char(64),
  ADD COLUMN tool_view_protocol varchar(128),
  ADD COLUMN claim_attestation_protocol varchar(128),
  ADD COLUMN attestation_credential_id varchar(128),
  ADD CONSTRAINT meri_phase4_binding_v2_all_or_none CHECK (
    (binding_version IS NULL AND worker_image_digest IS NULL AND worker_build_id IS NULL AND
      worker_catalog_digest_algorithm IS NULL AND worker_catalog_digest IS NULL AND
      applied_tool_view_digest_algorithm IS NULL AND meri_catalog_version IS NULL AND
      meri_catalog_digest IS NULL AND capability_mapping_version IS NULL AND
      capability_mapping_digest IS NULL AND tool_view_protocol IS NULL AND
      claim_attestation_protocol IS NULL AND attestation_credential_id IS NULL) OR
    (binding_version IS NOT NULL AND binding_version = 2 AND
      worker_image_digest IS NOT NULL AND
      worker_build_id IS NOT NULL AND worker_catalog_digest_algorithm IS NOT NULL AND
      worker_catalog_digest IS NOT NULL AND applied_tool_view_digest_algorithm IS NOT NULL AND
      meri_catalog_version IS NOT NULL AND meri_catalog_digest IS NOT NULL AND
      capability_mapping_version IS NOT NULL AND capability_mapping_digest IS NOT NULL AND
      tool_view_protocol IS NOT NULL AND claim_attestation_protocol IS NOT NULL AND
      attestation_credential_id IS NOT NULL AND
      worker_image_digest ~ '^[0-9a-f]{64}$' AND
      worker_build_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      worker_catalog_digest_algorithm = 'capiro.meri.phase4.worker-catalog/v1' AND
      worker_catalog_digest ~ '^[0-9a-f]{64}$' AND
      applied_tool_view_digest_algorithm = 'capiro.meri.phase4.applied-tool-view/v1' AND
      meri_catalog_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      meri_catalog_digest ~ '^[0-9a-f]{64}$' AND
      capability_mapping_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      capability_mapping_digest ~ '^[0-9a-f]{64}$' AND
      tool_view_protocol = 'capiro.meri.phase4.request-local-tool-view/v1' AND
      claim_attestation_protocol = 'capiro.meri.phase4.claim-tool-view-attestation/v1' AND
      attestation_credential_id = worker_credential_id)
  );

COMMENT ON COLUMN public.meri_phase4_worker_bindings.binding_version IS
  'NULL identifies a legacy v1 tombstone. Only complete version 2 rows are dispatch eligible.';
COMMENT ON COLUMN public.meri_phase4_worker_bindings.attestation_credential_id IS
  'Identifier only. It equals worker_credential_id and selects a separate claim-attestation key; no key bytes are stored.';

CREATE FUNCTION public.meri_phase4_attest_worker_binding_v2(
  p_binding_id uuid, p_source_id varchar, p_external_record_id varchar,
  p_tenant_id uuid, p_scope_id varchar, p_ingress varchar, p_generation varchar,
  p_credential_id varchar, p_not_before bigint, p_not_after bigint,
  p_worker_image_digest char(64), p_worker_build_id varchar,
  p_worker_catalog_digest_algorithm varchar, p_worker_catalog_digest char(64),
  p_meri_catalog_version varchar, p_meri_catalog_digest char(64),
  p_capability_mapping_version varchar, p_capability_mapping_digest char(64),
  p_tool_view_protocol varchar, p_claim_attestation_protocol varchar,
  p_attestation_credential_id varchar, p_applied_tool_view_digest_algorithm varchar
) RETURNS TABLE (
  binding_id uuid, tenant_id uuid, source_id varchar, external_record_id varchar,
  attestation_sha256 char(64), revoked_at_epoch_micros bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  source_row public.meri_phase4_worker_binding_sources%ROWTYPE;
  existing public.meri_phase4_worker_bindings%ROWTYPE;
  db_now bigint;
  binding_digest char(64);
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.current_tenant_id() OR
     p_source_id IS NULL OR p_source_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' THEN
    RAISE EXCEPTION 'authenticated Phase 4 binding v2 attestor required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO source_row FROM public.meri_phase4_worker_binding_sources s
    WHERE s.source_id = p_source_id AND s.producer_role = session_user FOR SHARE;
  IF NOT FOUND OR source_row.qualified IS DISTINCT FROM true OR
     source_row.qualification_sha256 IS NULL THEN
    RAISE EXCEPTION 'binding source is not independently qualified' USING ERRCODE = '42501';
  END IF;
  IF p_binding_id IS NULL OR p_scope_id IS NULL OR p_external_record_id IS NULL OR
     p_external_record_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR
     p_ingress IS NULL OR p_ingress !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR
     p_generation IS NULL OR p_generation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR
     p_credential_id IS NULL OR p_credential_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR
     p_attestation_credential_id IS DISTINCT FROM p_credential_id OR
     p_not_before IS NULL OR p_not_after IS NULL OR p_not_before <= 0 OR
     p_not_after <= p_not_before OR p_not_after - p_not_before > 2592000000000 OR
     p_worker_image_digest IS NULL OR p_worker_image_digest::text !~ '^[0-9a-f]{64}$' OR
     p_worker_build_id IS NULL OR p_worker_build_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR
     p_worker_catalog_digest_algorithm <> 'capiro.meri.phase4.worker-catalog/v1' OR
     p_worker_catalog_digest IS NULL OR p_worker_catalog_digest::text !~ '^[0-9a-f]{64}$' OR
     p_applied_tool_view_digest_algorithm <> 'capiro.meri.phase4.applied-tool-view/v1' OR
     p_meri_catalog_version IS NULL OR
       p_meri_catalog_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR
     p_meri_catalog_digest IS NULL OR p_meri_catalog_digest::text !~ '^[0-9a-f]{64}$' OR
     p_capability_mapping_version IS NULL OR
       p_capability_mapping_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR
     p_capability_mapping_digest IS NULL OR
       p_capability_mapping_digest::text !~ '^[0-9a-f]{64}$' OR
     p_tool_view_protocol <> 'capiro.meri.phase4.request-local-tool-view/v1' OR
     p_claim_attestation_protocol <>
       'capiro.meri.phase4.claim-tool-view-attestation/v1' THEN
    RAISE EXCEPTION 'invalid source-qualified worker binding v2' USING ERRCODE = '22023';
  END IF;
  binding_digest := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.worker-binding/v2', p_tenant_id::text, p_scope_id,
    'meri-hermes-scope-worker', p_ingress, p_generation, p_credential_id,
    p_source_id, p_external_record_id, p_not_before::text, p_not_after::text,
    p_worker_image_digest::text, p_worker_build_id,
    p_worker_catalog_digest_algorithm, p_worker_catalog_digest::text,
    p_applied_tool_view_digest_algorithm, p_meri_catalog_version,
    p_meri_catalog_digest::text, p_capability_mapping_version,
    p_capability_mapping_digest::text, p_tool_view_protocol,
    p_claim_attestation_protocol, p_attestation_credential_id,
    source_row.qualification_sha256::text
  ]);
  IF (SELECT count(*) FROM public.meri_phase4_worker_bindings b
      WHERE b.binding_id = p_binding_id OR
        (b.source_id = p_source_id AND b.external_record_id = p_external_record_id)) > 1 THEN
    RAISE EXCEPTION 'binding id and external record identify different rows' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO existing FROM public.meri_phase4_worker_bindings b
    WHERE b.binding_id = p_binding_id OR
      (b.source_id = p_source_id AND b.external_record_id = p_external_record_id)
    FOR SHARE;
  IF FOUND THEN
    IF existing.binding_id IS DISTINCT FROM p_binding_id OR
       existing.tenant_id IS DISTINCT FROM p_tenant_id OR
       existing.scope_id IS DISTINCT FROM p_scope_id OR
       existing.worker_audience <> 'meri-hermes-scope-worker' OR
       existing.worker_ingress_id IS DISTINCT FROM p_ingress OR
       existing.worker_generation IS DISTINCT FROM p_generation OR
       existing.worker_credential_id IS DISTINCT FROM p_credential_id OR
       existing.source_id IS DISTINCT FROM p_source_id OR
       existing.external_record_id IS DISTINCT FROM p_external_record_id OR
       existing.attested_by_role IS DISTINCT FROM session_user OR
       existing.attestation_sha256 IS DISTINCT FROM binding_digest OR
       existing.not_before_epoch_micros IS DISTINCT FROM p_not_before OR
       existing.not_after_epoch_micros IS DISTINCT FROM p_not_after OR
       existing.binding_version IS DISTINCT FROM 2 OR
       existing.worker_image_digest IS DISTINCT FROM p_worker_image_digest OR
       existing.worker_build_id IS DISTINCT FROM p_worker_build_id OR
       existing.worker_catalog_digest_algorithm IS DISTINCT FROM p_worker_catalog_digest_algorithm OR
       existing.worker_catalog_digest IS DISTINCT FROM p_worker_catalog_digest OR
       existing.applied_tool_view_digest_algorithm IS DISTINCT FROM
         p_applied_tool_view_digest_algorithm OR
       existing.meri_catalog_version IS DISTINCT FROM p_meri_catalog_version OR
       existing.meri_catalog_digest IS DISTINCT FROM p_meri_catalog_digest OR
       existing.capability_mapping_version IS DISTINCT FROM p_capability_mapping_version OR
       existing.capability_mapping_digest IS DISTINCT FROM p_capability_mapping_digest OR
       existing.tool_view_protocol IS DISTINCT FROM p_tool_view_protocol OR
       existing.claim_attestation_protocol IS DISTINCT FROM p_claim_attestation_protocol OR
       existing.attestation_credential_id IS DISTINCT FROM p_attestation_credential_id THEN
      RAISE EXCEPTION 'binding v2 id or external record replay drift' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.binding_id, existing.tenant_id, existing.source_id,
      existing.external_record_id, existing.attestation_sha256,
      existing.revoked_at_epoch_micros;
    RETURN;
  END IF;
  PERFORM public.meri_phase4_lock_route_fence_exclusive(p_tenant_id);
  IF (SELECT count(*) FROM public.meri_phase4_worker_bindings b
      WHERE b.binding_id = p_binding_id OR
        (b.source_id = p_source_id AND b.external_record_id = p_external_record_id)) > 1 THEN
    RAISE EXCEPTION 'binding id and external record identify different rows' USING ERRCODE = '23505';
  END IF;
  SELECT * INTO existing FROM public.meri_phase4_worker_bindings b
    WHERE b.binding_id = p_binding_id OR
      (b.source_id = p_source_id AND b.external_record_id = p_external_record_id)
    FOR SHARE;
  IF FOUND THEN
    IF existing.attestation_sha256 IS DISTINCT FROM binding_digest OR
       existing.binding_id IS DISTINCT FROM p_binding_id OR
       existing.tenant_id IS DISTINCT FROM p_tenant_id OR
       existing.source_id IS DISTINCT FROM p_source_id OR
       existing.external_record_id IS DISTINCT FROM p_external_record_id OR
       existing.binding_version IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'binding v2 id or external record replay drift' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.binding_id, existing.tenant_id, existing.source_id,
      existing.external_record_id, existing.attestation_sha256,
      existing.revoked_at_epoch_micros;
    RETURN;
  END IF;
  PERFORM public.meri_phase4_assert_route_scope(p_tenant_id, p_scope_id);
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  IF db_now < p_not_before OR db_now >= p_not_after THEN
    RAISE EXCEPTION 'external worker binding v2 is outside its DB-clock window'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.meri_phase4_worker_bindings (
    binding_id, tenant_id, scope_id, worker_audience, worker_ingress_id,
    worker_generation, worker_credential_id, source_id, external_record_id,
    attestation_sha256, attested_by_role, not_before_epoch_micros,
    not_after_epoch_micros, attested_at_epoch_micros, binding_version,
    worker_image_digest, worker_build_id, worker_catalog_digest_algorithm,
    worker_catalog_digest, applied_tool_view_digest_algorithm,
    meri_catalog_version, meri_catalog_digest, capability_mapping_version,
    capability_mapping_digest, tool_view_protocol, claim_attestation_protocol,
    attestation_credential_id
  ) VALUES (
    p_binding_id, p_tenant_id, p_scope_id, 'meri-hermes-scope-worker', p_ingress,
    p_generation, p_credential_id, p_source_id, p_external_record_id,
    binding_digest, session_user, p_not_before, p_not_after, db_now, 2,
    p_worker_image_digest, p_worker_build_id, p_worker_catalog_digest_algorithm,
    p_worker_catalog_digest, p_applied_tool_view_digest_algorithm,
    p_meri_catalog_version, p_meri_catalog_digest, p_capability_mapping_version,
    p_capability_mapping_digest, p_tool_view_protocol, p_claim_attestation_protocol,
    p_attestation_credential_id
  );
  RETURN QUERY SELECT b.binding_id, b.tenant_id, b.source_id, b.external_record_id,
    b.attestation_sha256, b.revoked_at_epoch_micros
    FROM public.meri_phase4_worker_bindings b WHERE b.binding_id = p_binding_id;
END;
$$;

CREATE FUNCTION public.meri_phase4_lock_worker_binding_v2(
  p_binding_id uuid, p_tenant_id uuid, p_scope_id varchar, p_audience text,
  p_ingress_id text, p_generation text, p_credential_id text
) RETURNS TABLE (
  active boolean, not_before_epoch_micros bigint, not_after_epoch_micros bigint,
  worker_image_digest char(64), worker_build_id varchar,
  worker_catalog_digest_algorithm varchar, worker_catalog_digest char(64),
  applied_tool_view_digest_algorithm varchar, meri_catalog_version varchar,
  meri_catalog_digest char(64), capability_mapping_version varchar,
  capability_mapping_digest char(64), tool_view_protocol varchar,
  claim_attestation_protocol varchar, attestation_credential_id varchar
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.current_tenant_id() OR
     p_binding_id IS NULL THEN
    RAISE EXCEPTION 'authority binding v2 mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT (b.revoked_at_epoch_micros IS NULL),
      b.not_before_epoch_micros, b.not_after_epoch_micros,
      b.worker_image_digest, b.worker_build_id, b.worker_catalog_digest_algorithm,
      b.worker_catalog_digest, b.applied_tool_view_digest_algorithm,
      b.meri_catalog_version, b.meri_catalog_digest,
      b.capability_mapping_version, b.capability_mapping_digest,
      b.tool_view_protocol, b.claim_attestation_protocol,
      b.attestation_credential_id
    FROM public.meri_phase4_worker_bindings b
    JOIN public.meri_phase4_worker_binding_sources s ON s.source_id=b.source_id
    WHERE b.binding_id = p_binding_id AND b.tenant_id = p_tenant_id
      AND b.scope_id = p_scope_id AND b.worker_audience = p_audience
      AND b.worker_ingress_id = p_ingress_id AND b.worker_generation = p_generation
      AND b.worker_credential_id = p_credential_id AND b.binding_version = 2
      AND s.qualified AND s.producer_role = b.attested_by_role
    FOR SHARE;
END;
$$;

ALTER FUNCTION public.meri_phase4_attest_worker_binding_v2(
  uuid,varchar,varchar,uuid,varchar,varchar,varchar,varchar,bigint,bigint,
  char,varchar,varchar,char,varchar,char,varchar,char,varchar,varchar,varchar,varchar
) OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_lock_worker_binding_v2(
  uuid,uuid,varchar,text,text,text,text
) OWNER TO meri_phase4_authority_owner;

REVOKE ALL ON FUNCTION public.meri_phase4_attest_worker_binding_v2(
  uuid,varchar,varchar,uuid,varchar,varchar,varchar,varchar,bigint,bigint,
  char,varchar,varchar,char,varchar,char,varchar,char,varchar,varchar,varchar,varchar
) FROM PUBLIC, capiro_app, meri_phase4_route_operator;
REVOKE ALL ON FUNCTION public.meri_phase4_lock_worker_binding_v2(
  uuid,uuid,varchar,text,text,text,text
) FROM PUBLIC, meri_phase4_route_operator;
REVOKE ALL ON FUNCTION public.meri_phase4_lock_worker_binding(
  uuid,uuid,varchar,text,text,text,text
) FROM PUBLIC, capiro_app, meri_phase4_route_operator;
GRANT EXECUTE ON FUNCTION public.meri_phase4_lock_worker_binding_v2(
  uuid,uuid,varchar,text,text,text,text
) TO capiro_app;

-- No producer role is provisioned here. Reviewed source qualification must
-- grant only meri_phase4_attest_worker_binding_v2 and the existing revoke
-- function to one source-specific LOGIN after key custody and image evidence.

REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;

DO $$ BEGIN
  EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user);
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
       OR m.member = 'meri_phase4_authority_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner membership survived binding v2 migration'
      USING ERRCODE = '42501';
  END IF;
  IF has_schema_privilege('meri_phase4_authority_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Phase 4 authority owner retained schema CREATE after binding v2 migration'
      USING ERRCODE = '42501';
  END IF;
END $$;

COMMIT;
