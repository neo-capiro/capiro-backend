-- Dormant Phase 4 route provisioning boundary.
--
-- `capiro_app` receives no route/binding/receipt DML and no route mutation
-- EXECUTE. The externally-authenticated route operator is a passwordless
-- LOGIN. Every binding source must later receive its own independently
-- reviewed LOGIN role through a separate qualification operation; this
-- migration creates no shared attestor identity. The binding-source registry
-- is intentionally empty and cannot be qualified by any runtime identity.
-- An enabled DB route is not proof of ingress closure or worker termination.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A role-specific REVOKE cannot override authority inherited from PUBLIC.
-- Refuse to provision the LOGIN until the cluster is on this explicit
-- baseline. CONNECT/TEMPORARY, public-schema USAGE, and the five reviewed
-- extension APIs are the only inherited capabilities accepted here.
DO $$
DECLARE
  exposure text;
BEGIN
  SELECT string_agg(item, ', ' ORDER BY item) INTO exposure FROM (
    SELECT 'database:' || x.privilege_type AS item
      FROM pg_database d
      CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) x
      WHERE d.datname = current_database() AND x.grantee = 0
        AND x.privilege_type NOT IN ('CONNECT', 'TEMPORARY')
    UNION ALL
    SELECT 'schema:' || n.nspname || ':' || x.privilege_type
      FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) x
      WHERE x.grantee = 0 AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND NOT (n.nspname = 'public' AND x.privilege_type = 'USAGE')
    UNION ALL
    SELECT 'relation:' || n.nspname || '.' || c.relname || ':' || x.privilege_type
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,
        acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END, c.relowner))) x
      WHERE x.grantee = 0 AND c.relkind IN ('r','p','v','m','f','S')
        AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT 'routine:' || n.nspname || '.' || p.proname || ':' || x.privilege_type
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
      WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE'
        AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend dep JOIN pg_extension ext ON ext.oid = dep.refobjid
          WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'e'
            AND ext.extname IN ('pgcrypto', 'uuid-ossp', 'vector', 'pg_trgm', 'citext')
        )
  ) inherited;
  IF exposure IS NOT NULL THEN
    RAISE EXCEPTION 'unsafe PostgreSQL PUBLIC privilege baseline: %', exposure
      USING ERRCODE = '42501';
  END IF;
END $$;

-- PostgreSQL otherwise grants PUBLIC EXECUTE to every newly created routine.
-- Close that future-object path for the migration/qualification principal
-- before any authority LOGIN exists. The end-of-migration probe and invariant
-- below prove the default stayed closed.
DO $$ BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    current_user
  );
END $$;

DO $$ BEGIN
  -- Fail instead of adopting a pre-existing principal whose password/auth
  -- state this migration cannot safely inspect on managed PostgreSQL. New
  -- identities are created passwordless with closed role attributes.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_route_operator') THEN
    RAISE EXCEPTION 'Phase 4 route operator identity must not pre-exist migration'
      USING ERRCODE = '42501';
  END IF;
  CREATE ROLE meri_phase4_route_operator LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_route_operator'::regrole
    ) OR m.member IN (
      'meri_phase4_authority_owner'::regrole,
      'meri_phase4_route_operator'::regrole
    )
  ) THEN
    RAISE EXCEPTION 'Phase 4 owner/operator roles must have no memberships'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') AND (
    pg_has_role('capiro_app', 'meri_phase4_authority_owner', 'member') OR
    pg_has_role('capiro_app', 'meri_phase4_route_operator', 'member')
  ) THEN
    RAISE EXCEPTION 'capiro_app must not inherit Phase 4 authority roles'
      USING ERRCODE = '42501';
  END IF;
  -- The dedicated owner is non-login and has no surviving members. Grant the
  -- migration executor temporary membership solely for ALTER OWNER below;
  -- the edge is removed before COMMIT.
  EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user);
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE meri_phase4_authority_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE public.meri_phase4_worker_binding_sources (
  source_id varchar(64) PRIMARY KEY,
  producer_role varchar(63) NOT NULL,
  qualified boolean NOT NULL DEFAULT false,
  qualification_sha256 char(64),
  qualified_at_epoch_micros bigint,
  CONSTRAINT meri_phase4_binding_source_producer_key UNIQUE (source_id, producer_role),
  CONSTRAINT meri_phase4_binding_source_role_key UNIQUE (producer_role),
  CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  CHECK (producer_role ~ '^[A-Za-z0-9_]{1,63}$'),
  CHECK (
    (qualified = false AND qualification_sha256 IS NULL AND qualified_at_epoch_micros IS NULL) OR
    (qualified = true AND qualification_sha256 IS NOT NULL AND
      qualification_sha256 ~ '^[0-9a-f]{64}$' AND qualified_at_epoch_micros IS NOT NULL AND
      qualified_at_epoch_micros > 0)
  )
);
COMMENT ON TABLE public.meri_phase4_worker_binding_sources IS
  'DBA-qualified external producers only. Intentionally empty until deployment and credential key custody are independently reviewed.';

CREATE TABLE public.meri_phase4_worker_bindings (
  binding_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  scope_id varchar(200) NOT NULL,
  worker_audience varchar(64) NOT NULL,
  worker_ingress_id varchar(128) NOT NULL,
  worker_generation varchar(128) NOT NULL,
  worker_credential_id varchar(128) NOT NULL,
  source_id varchar(64) NOT NULL,
  external_record_id varchar(128) NOT NULL,
  attestation_sha256 char(64) NOT NULL,
  attested_by_role varchar(63) NOT NULL,
  not_before_epoch_micros bigint NOT NULL,
  not_after_epoch_micros bigint NOT NULL,
  attested_at_epoch_micros bigint NOT NULL,
  revoked_at_epoch_micros bigint,
  revocation_id uuid,
  revocation_digest char(64),
  CONSTRAINT meri_phase4_binding_source_record_key UNIQUE (source_id, external_record_id),
  CONSTRAINT meri_phase4_binding_source_fk FOREIGN KEY (source_id, attested_by_role)
    REFERENCES public.meri_phase4_worker_binding_sources(source_id, producer_role) ON DELETE RESTRICT,
  CONSTRAINT meri_phase4_binding_exact_route_key UNIQUE (
    binding_id, tenant_id, scope_id, worker_audience, worker_ingress_id,
    worker_generation, worker_credential_id
  ),
  CONSTRAINT meri_phase4_binding_route_identity_key UNIQUE (
    tenant_id, scope_id, worker_audience, worker_ingress_id,
    worker_generation, worker_credential_id
  ),
  CHECK (scope_id ~ ('^tenant:' || tenant_id::text || ':user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  CHECK (worker_audience = 'meri-hermes-scope-worker'),
  CHECK (worker_ingress_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (worker_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (worker_credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  CHECK (external_record_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (attestation_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (attested_by_role ~ '^[A-Za-z0-9_]{1,63}$'),
  CHECK (not_before_epoch_micros > 0 AND
    not_after_epoch_micros > not_before_epoch_micros AND
    not_after_epoch_micros - not_before_epoch_micros <= 2592000000000),
  CHECK (attested_at_epoch_micros > 0),
  CHECK (
    (revoked_at_epoch_micros IS NULL AND revocation_id IS NULL AND revocation_digest IS NULL) OR
    (revoked_at_epoch_micros IS NOT NULL AND revoked_at_epoch_micros > 0 AND
      revocation_id IS NOT NULL AND revocation_digest IS NOT NULL AND
      revocation_digest ~ '^[0-9a-f]{64}$')
  )
);
COMMENT ON TABLE public.meri_phase4_worker_bindings IS
  'Authenticated nonsecret deployment/credential metadata. No key bytes, bearer, URL, or token are stored.';

CREATE TABLE public.meri_phase4_route_operator_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  operation varchar(24) NOT NULL,
  request_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  actor_user_id uuid NOT NULL,
  impersonation_session_id uuid NOT NULL,
  reason varchar(500) NOT NULL,
  nonce_sha256 char(64) NOT NULL,
  issued_at_epoch_micros bigint NOT NULL,
  expires_at_epoch_micros bigint NOT NULL,
  consumed_at_epoch_micros bigint,
  CONSTRAINT meri_phase4_route_grant_request_key UNIQUE (tenant_id, request_id),
  CHECK (operation IN ('provision', 'enable', 'close', 'rotate')),
  CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (length(btrim(reason)) BETWEEN 10 AND 500 AND reason = btrim(reason) AND
    reason !~ '[[:cntrl:]]'),
  CHECK (issued_at_epoch_micros > 0 AND expires_at_epoch_micros > issued_at_epoch_micros AND
    expires_at_epoch_micros - issued_at_epoch_micros <= 300000000),
  CHECK (consumed_at_epoch_micros IS NULL OR
    (consumed_at_epoch_micros >= issued_at_epoch_micros AND
      consumed_at_epoch_micros < expires_at_epoch_micros))
);
COMMENT ON TABLE public.meri_phase4_route_operator_grants IS
  'Append-only one-command grants derived from a live admin impersonation. Only a SHA-256 nonce digest is retained.';

CREATE TABLE public.meri_phase4_worker_route_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  operation varchar(24) NOT NULL,
  outcome varchar(16) NOT NULL,
  actor_user_id uuid NOT NULL,
  impersonation_session_id uuid NOT NULL,
  reason varchar(500) NOT NULL,
  scope_id varchar(200) NOT NULL,
  worker_audience varchar(64) NOT NULL,
  worker_ingress_id varchar(128) NOT NULL,
  old_generation varchar(128),
  old_credential_id varchar(128),
  new_generation varchar(128),
  new_credential_id varchar(128),
  binding_id uuid,
  old_not_before_epoch_micros bigint,
  old_not_after_epoch_micros bigint,
  new_not_before_epoch_micros bigint,
  new_not_after_epoch_micros bigint,
  occurred_at_epoch_micros bigint NOT NULL,
  fence_revision bigint NOT NULL,
  CONSTRAINT meri_phase4_route_receipt_request_key UNIQUE (tenant_id, request_id),
  CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  CHECK (operation IN ('provision', 'enable', 'close', 'rotate')),
  CHECK (outcome IN ('changed', 'no_op')),
  CHECK (length(btrim(reason)) BETWEEN 10 AND 500 AND reason = btrim(reason)),
  CHECK (scope_id ~ ('^tenant:' || tenant_id::text || ':user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  CHECK (worker_audience = 'meri-hermes-scope-worker'),
  CHECK (worker_ingress_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (occurred_at_epoch_micros > 0 AND fence_revision > 0)
);
COMMENT ON TABLE public.meri_phase4_worker_route_receipts IS
  'Append-only idempotency receipts for route metadata operations; never proof of ingress closure or worker termination.';

-- A prior dormant version of the table has no trusted external binding.
-- Never guess/backfill one from route strings: fail the whole migration if any
-- row was manually inserted before the independent attestor existed.
ALTER TABLE public.meri_phase4_worker_routes ADD COLUMN binding_id uuid;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.meri_phase4_worker_routes) THEN
    RAISE EXCEPTION 'cannot bind existing Phase 4 routes without external attestation'
      USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE public.meri_phase4_worker_routes ALTER COLUMN binding_id SET NOT NULL;
ALTER TABLE public.meri_phase4_worker_routes
  ALTER COLUMN worker_audience TYPE varchar(64) USING worker_audience::varchar(64),
  ALTER COLUMN worker_ingress_id TYPE varchar(128) USING worker_ingress_id::varchar(128),
  ALTER COLUMN worker_generation TYPE varchar(128) USING worker_generation::varchar(128),
  ALTER COLUMN worker_credential_id TYPE varchar(128) USING worker_credential_id::varchar(128);
ALTER TABLE public.meri_phase4_worker_routes
  ADD CONSTRAINT meri_phase4_route_binding_identity_fk FOREIGN KEY (
    binding_id, tenant_id, scope_id, worker_audience, worker_ingress_id,
    worker_generation, worker_credential_id
  ) REFERENCES public.meri_phase4_worker_bindings (
    binding_id, tenant_id, scope_id, worker_audience, worker_ingress_id,
    worker_generation, worker_credential_id
  ) ON DELETE RESTRICT,
  ADD CONSTRAINT meri_phase4_route_scope_canonical_check CHECK (
    scope_id ~ ('^tenant:' || tenant_id::text || ':user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ),
  ADD CONSTRAINT meri_phase4_route_audience_check CHECK (
    worker_audience = 'meri-hermes-scope-worker'
  ),
  ADD CONSTRAINT meri_phase4_route_ingress_check CHECK (
    worker_ingress_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  ADD CONSTRAINT meri_phase4_route_generation_check CHECK (
    worker_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  ADD CONSTRAINT meri_phase4_route_credential_check CHECK (
    worker_credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  ADD CONSTRAINT meri_phase4_route_window_max_check CHECK (
    not_after_epoch_micros - not_before_epoch_micros <= 2592000000000
  ),
  ADD CONSTRAINT meri_phase4_route_closed_disabled_check CHECK (
    closed_at_epoch_micros IS NULL OR enabled = false
  );

ALTER TABLE public.meri_phase4_worker_binding_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_worker_binding_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_binding_source_owner ON public.meri_phase4_worker_binding_sources
  TO PUBLIC USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

ALTER TABLE public.meri_phase4_worker_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_worker_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_binding_owner ON public.meri_phase4_worker_bindings
  TO PUBLIC USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

-- Minimal global reads used only inside the grant SECURITY DEFINER functions.
-- Column grants below keep the authority owner from reading unrelated data.
CREATE POLICY meri_phase4_tenant_owner_grant_read ON public.tenants
  FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_phase4_impersonation_owner_grant_read ON public.impersonation_sessions
  FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');
CREATE POLICY meri_phase4_scope_owner_route_read ON public.meri_execution_scopes
  FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');

ALTER TABLE public.meri_phase4_route_operator_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_route_operator_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_route_grant_owner ON public.meri_phase4_route_operator_grants
  TO PUBLIC USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

ALTER TABLE public.meri_phase4_worker_route_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_worker_route_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_route_receipt_owner ON public.meri_phase4_worker_route_receipts
  TO PUBLIC USING (current_user = 'meri_phase4_authority_owner')
  WITH CHECK (current_user = 'meri_phase4_authority_owner');

CREATE FUNCTION public.meri_phase4_route_digest_v1(p_parts text[])
RETURNS char(64)
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  part text;
  payload bytea := decode('', 'hex');
BEGIN
  IF p_parts IS NULL OR cardinality(p_parts) < 2 OR array_position(p_parts, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid Phase 4 route digest fields' USING ERRCODE = '22023';
  END IF;
  FOREACH part IN ARRAY p_parts LOOP
    payload := payload || pg_catalog.int4send(pg_catalog.octet_length(part)) ||
      pg_catalog.convert_to(part, 'UTF8');
  END LOOP;
  RETURN pg_catalog.encode(public.digest(payload, 'sha256'), 'hex')::char(64);
END;
$$;

CREATE FUNCTION public.meri_phase4_issue_route_operator_grant(
  p_tenant_id uuid, p_impersonation_session_id uuid, p_operation varchar,
  p_request_id uuid, p_request_digest char(64)
) RETURNS TABLE (
  grant_id uuid, tenant_id uuid, actor_user_id uuid, impersonation_session_id uuid,
  reason varchar, operation varchar, request_id uuid, request_digest char(64),
  grant_nonce char(64), expires_at_epoch_micros bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  session_row record;
  raw_nonce bytea;
  db_now bigint;
  expiry bigint;
  inserted public.meri_phase4_route_operator_grants%ROWTYPE;
BEGIN
  IF session_user <> 'capiro_app' OR p_tenant_id IS NULL OR
     p_impersonation_session_id IS NULL OR p_request_id IS NULL OR
     p_operation NOT IN ('provision','enable','close','rotate') OR
     p_request_digest IS NULL OR p_request_digest::text !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid Phase 4 route grant request' USING ERRCODE = '42501';
  END IF;
  SELECT i.actor_user_id, i.tenant_id, i.reason,
      floor(extract(epoch FROM i.expires_at) * 1000000)::bigint AS expires_micros
    INTO session_row
    FROM public.impersonation_sessions i JOIN public.tenants t ON t.id = i.tenant_id
    WHERE i.id = p_impersonation_session_id AND i.tenant_id = p_tenant_id
      AND i.ended_at IS NULL AND i.expires_at > clock_timestamp()
      AND t.status::text = 'active';
  IF NOT FOUND OR session_row.reason IS NULL OR
     length(session_row.reason) NOT BETWEEN 10 AND 500 OR
     session_row.reason <> btrim(session_row.reason) OR
     session_row.reason ~ '[[:cntrl:]]' OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships m
       WHERE m.user_id = session_row.actor_user_id AND m.role::text = 'capiro_admin'
         AND m.status::text = 'active'
     ) THEN
    RAISE EXCEPTION 'live Capiro-admin impersonation required' USING ERRCODE = '42501';
  END IF;
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  expiry := least(session_row.expires_micros, db_now + 300000000);
  IF expiry <= db_now THEN
    RAISE EXCEPTION 'impersonation expires before grant issuance' USING ERRCODE = '42501';
  END IF;
  raw_nonce := public.gen_random_bytes(32);
  INSERT INTO public.meri_phase4_route_operator_grants (
    tenant_id, operation, request_id, request_digest, actor_user_id,
    impersonation_session_id, reason, nonce_sha256,
    issued_at_epoch_micros, expires_at_epoch_micros
  ) VALUES (
    p_tenant_id, p_operation, p_request_id, p_request_digest,
    session_row.actor_user_id, p_impersonation_session_id, session_row.reason,
    encode(public.digest(raw_nonce, 'sha256'), 'hex'), db_now, expiry
  ) RETURNING * INTO inserted;
  RETURN QUERY SELECT inserted.grant_id, inserted.tenant_id, inserted.actor_user_id,
    inserted.impersonation_session_id, inserted.reason, inserted.operation,
    inserted.request_id, inserted.request_digest, encode(raw_nonce, 'hex')::char(64),
    inserted.expires_at_epoch_micros;
END;
$$;

CREATE FUNCTION public.meri_phase4_authorize_route_grant(
  p_grant_id uuid, p_grant_nonce char(64), p_tenant_id uuid, p_operation varchar,
  p_request_id uuid, p_request_digest char(64), p_consume boolean
) RETURNS TABLE (actor_user_id uuid, impersonation_session_id uuid, reason varchar)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  grant_row public.meri_phase4_route_operator_grants%ROWTYPE;
  db_now bigint;
BEGIN
  IF session_user <> 'meri_phase4_route_operator' OR p_grant_id IS NULL OR
     p_grant_nonce IS NULL OR p_grant_nonce::text !~ '^[0-9a-f]{64}$' OR
     p_tenant_id IS NULL OR p_operation NOT IN ('provision','enable','close','rotate') OR
     p_request_id IS NULL OR p_request_digest IS NULL OR
     p_request_digest::text !~ '^[0-9a-f]{64}$' OR p_consume IS NULL THEN
    RAISE EXCEPTION 'valid route-operator grant required' USING ERRCODE = '42501';
  END IF;
  IF p_consume THEN
    SELECT * INTO grant_row FROM public.meri_phase4_route_operator_grants g
      WHERE g.grant_id = p_grant_id FOR UPDATE;
  ELSE
    SELECT * INTO grant_row FROM public.meri_phase4_route_operator_grants g
      WHERE g.grant_id = p_grant_id;
  END IF;
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  IF NOT FOUND OR grant_row.tenant_id IS DISTINCT FROM p_tenant_id OR
     grant_row.operation IS DISTINCT FROM p_operation OR
     grant_row.request_id IS DISTINCT FROM p_request_id OR
     grant_row.request_digest IS DISTINCT FROM p_request_digest OR
     grant_row.nonce_sha256 IS DISTINCT FROM
       encode(public.digest(decode(p_grant_nonce::text, 'hex'), 'sha256'), 'hex') THEN
    RAISE EXCEPTION 'route-operator grant identity mismatch' USING ERRCODE = '42501';
  END IF;
  -- Static possession is enough only to recover an already committed exact
  -- receipt. A command miss reaches the consuming call below, which rechecks
  -- every live authority fact under the tenant fence.
  IF p_consume AND (db_now >= grant_row.expires_at_epoch_micros OR NOT EXISTS (
       SELECT 1 FROM public.impersonation_sessions i
       WHERE i.id = grant_row.impersonation_session_id
         AND i.actor_user_id = grant_row.actor_user_id
         AND i.tenant_id = grant_row.tenant_id AND i.reason = grant_row.reason
         AND i.ended_at IS NULL AND i.expires_at > clock_timestamp()
     ) OR NOT EXISTS (
       SELECT 1 FROM public.tenants t
       WHERE t.id = grant_row.tenant_id AND t.status::text = 'active'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.tenant_memberships m
       WHERE m.user_id = grant_row.actor_user_id AND m.role::text = 'capiro_admin'
         AND m.status::text = 'active'
     )) THEN
    RAISE EXCEPTION 'route-operator grant is invalid or expired' USING ERRCODE = '42501';
  END IF;
  IF p_consume THEN
    IF grant_row.consumed_at_epoch_micros IS NOT NULL THEN
      RAISE EXCEPTION 'route-operator grant already consumed without receipt'
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.meri_phase4_route_operator_grants g
      SET consumed_at_epoch_micros = db_now WHERE g.grant_id = grant_row.grant_id;
  END IF;
  RETURN QUERY SELECT grant_row.actor_user_id, grant_row.impersonation_session_id,
    grant_row.reason;
END;
$$;

CREATE FUNCTION public.meri_phase4_assert_route_scope(p_tenant_id uuid, p_scope_id varchar)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tenant_status text;
  scope_row record;
BEGIN
  IF p_scope_id IS NULL OR p_scope_id !~
    ('^tenant:' || p_tenant_id::text || ':user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'noncanonical private execution scope' USING ERRCODE = '22023';
  END IF;
  SELECT t.status::text INTO tenant_status FROM public.tenants t WHERE t.id = p_tenant_id;
  IF tenant_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Phase 4 route tenant is not active' USING ERRCODE = '42501';
  END IF;
  SELECT s.tenant_id, s.principal_type, s.principal_id, s.kind
    INTO scope_row FROM public.meri_execution_scopes s
    WHERE s.tenant_id = p_tenant_id AND s.id = p_scope_id;
  IF NOT FOUND OR scope_row.tenant_id IS DISTINCT FROM p_tenant_id OR
     scope_row.principal_type <> 'user' OR scope_row.kind <> 'private' OR
     p_scope_id <> 'tenant:' || p_tenant_id::text || ':user:' || scope_row.principal_id THEN
    RAISE EXCEPTION 'Phase 4 route requires an existing tenant private user scope'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION public.meri_phase4_lock_route_fence_exclusive(p_tenant_id uuid)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_revision bigint;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'authority tenant mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT f.revision INTO v_revision FROM public.meri_phase4_authority_fences f
    WHERE f.tenant_id = p_tenant_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR v_revision IS NULL OR v_revision <= 0 THEN
    RAISE EXCEPTION 'authority fence missing' USING ERRCODE = '55000';
  END IF;
  RETURN v_revision;
END;
$$;

CREATE FUNCTION public.meri_phase4_worker_route_receipt_replay(
  p_tenant_id uuid, p_request_id uuid, p_request_digest char(64)
) RETURNS SETOF public.meri_phase4_worker_route_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r public.meri_phase4_worker_route_receipts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.meri_phase4_worker_route_receipts
    WHERE tenant_id = p_tenant_id AND request_id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF r.request_digest IS DISTINCT FROM p_request_digest THEN
    RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command'
      USING ERRCODE = '23505';
  END IF;
  RETURN NEXT r;
END;
$$;

CREATE FUNCTION public.meri_phase4_write_route_receipt(
  p_tenant_id uuid, p_request_id uuid, p_request_digest char(64),
  p_operation varchar, p_outcome varchar, p_actor uuid, p_session uuid, p_reason varchar,
  p_scope varchar, p_ingress varchar, p_old_generation varchar, p_old_credential varchar,
  p_new_generation varchar, p_new_credential varchar, p_binding_id uuid,
  p_old_not_before bigint, p_old_not_after bigint,
  p_new_not_before bigint, p_new_not_after bigint, p_now bigint
) RETURNS SETOF public.meri_phase4_worker_route_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_revision bigint;
BEGIN
  SELECT f.revision INTO v_revision FROM public.meri_phase4_authority_fences f
    WHERE f.tenant_id = p_tenant_id;
  IF NOT FOUND OR v_revision IS NULL THEN
    RAISE EXCEPTION 'authority fence missing while recording route receipt'
      USING ERRCODE = '55000';
  END IF;
  RETURN QUERY INSERT INTO public.meri_phase4_worker_route_receipts (
    tenant_id, request_id, request_digest, operation, outcome,
    actor_user_id, impersonation_session_id, reason, scope_id,
    worker_audience, worker_ingress_id, old_generation, old_credential_id,
    new_generation, new_credential_id, binding_id,
    old_not_before_epoch_micros, old_not_after_epoch_micros,
    new_not_before_epoch_micros, new_not_after_epoch_micros,
    occurred_at_epoch_micros, fence_revision
  ) VALUES (
    p_tenant_id, p_request_id, p_request_digest, p_operation, p_outcome,
    p_actor, p_session, p_reason, p_scope,
    'meri-hermes-scope-worker', p_ingress, p_old_generation, p_old_credential,
    p_new_generation, p_new_credential, p_binding_id,
    p_old_not_before, p_old_not_after, p_new_not_before, p_new_not_after,
    p_now, v_revision
  ) RETURNING *;
END;
$$;

CREATE FUNCTION public.meri_phase4_attest_worker_binding(
  p_binding_id uuid, p_source_id varchar, p_external_record_id varchar,
  p_tenant_id uuid, p_scope_id varchar, p_ingress varchar, p_generation varchar,
  p_credential_id varchar, p_not_before bigint, p_not_after bigint
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
    RAISE EXCEPTION 'authenticated Phase 4 binding attestor required' USING ERRCODE = '42501';
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
     p_not_before IS NULL OR p_not_after IS NULL OR p_not_before <= 0 OR p_not_after <= p_not_before OR
     p_not_after - p_not_before > 2592000000000 THEN
    RAISE EXCEPTION 'invalid external worker binding' USING ERRCODE = '22023';
  END IF;
  binding_digest := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.worker-binding/v1', p_tenant_id::text, p_scope_id,
    'meri-hermes-scope-worker', p_ingress, p_generation, p_credential_id,
    p_source_id, p_external_record_id, p_not_before::text, p_not_after::text,
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
       existing.not_after_epoch_micros IS DISTINCT FROM p_not_after THEN
      RAISE EXCEPTION 'binding id or external record replay drift' USING ERRCODE = '23505';
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
       existing.not_after_epoch_micros IS DISTINCT FROM p_not_after THEN
      RAISE EXCEPTION 'binding id or external record replay drift' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.binding_id, existing.tenant_id, existing.source_id,
      existing.external_record_id, existing.attestation_sha256,
      existing.revoked_at_epoch_micros;
    RETURN;
  END IF;
  PERFORM public.meri_phase4_assert_route_scope(p_tenant_id, p_scope_id);
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  IF db_now < p_not_before OR db_now >= p_not_after THEN
    RAISE EXCEPTION 'external worker binding is outside its DB-clock window'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.meri_phase4_worker_bindings (
    binding_id, tenant_id, scope_id, worker_audience, worker_ingress_id,
    worker_generation, worker_credential_id, source_id, external_record_id,
    attestation_sha256, attested_by_role, not_before_epoch_micros,
    not_after_epoch_micros, attested_at_epoch_micros
  ) VALUES (
    p_binding_id, p_tenant_id, p_scope_id, 'meri-hermes-scope-worker', p_ingress,
    p_generation, p_credential_id, p_source_id, p_external_record_id,
    binding_digest, session_user, p_not_before, p_not_after, db_now
  );
  RETURN QUERY SELECT b.binding_id, b.tenant_id, b.source_id, b.external_record_id,
    b.attestation_sha256, b.revoked_at_epoch_micros
    FROM public.meri_phase4_worker_bindings b WHERE b.binding_id = p_binding_id;
END;
$$;

CREATE FUNCTION public.meri_phase4_revoke_worker_binding(
  p_binding_id uuid, p_tenant_id uuid, p_source_id varchar, p_revocation_id uuid
) RETURNS TABLE (
  binding_id uuid, tenant_id uuid, source_id varchar, external_record_id varchar,
  attestation_sha256 char(64), revoked_at_epoch_micros bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  source_row public.meri_phase4_worker_binding_sources%ROWTYPE;
  binding_row public.meri_phase4_worker_bindings%ROWTYPE;
  db_now bigint;
  computed_revocation_digest char(64);
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.current_tenant_id() OR
     p_binding_id IS NULL OR p_revocation_id IS NULL OR p_source_id IS NULL OR
     p_source_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' THEN
    RAISE EXCEPTION 'authenticated Phase 4 binding attestor required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO source_row FROM public.meri_phase4_worker_binding_sources s
    WHERE s.source_id = p_source_id AND s.producer_role = session_user FOR SHARE;
  IF NOT FOUND OR source_row.qualified IS DISTINCT FROM true OR
     source_row.qualification_sha256 IS NULL THEN
    RAISE EXCEPTION 'binding source is not independently qualified' USING ERRCODE = '42501';
  END IF;
  computed_revocation_digest := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.worker-binding-revocation/v1', p_tenant_id::text,
    p_binding_id::text, p_source_id, p_revocation_id::text, session_user,
    source_row.qualification_sha256::text
  ]);
  SELECT * INTO binding_row FROM public.meri_phase4_worker_bindings b
    WHERE b.binding_id = p_binding_id AND b.tenant_id = p_tenant_id
      AND b.source_id = p_source_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker binding not found' USING ERRCODE = '55000'; END IF;
  IF binding_row.revoked_at_epoch_micros IS NOT NULL THEN
    IF binding_row.revocation_id IS DISTINCT FROM p_revocation_id OR
       binding_row.revocation_digest IS DISTINCT FROM computed_revocation_digest THEN
      RAISE EXCEPTION 'binding revocation replay drift' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT binding_row.binding_id, binding_row.tenant_id,
      binding_row.source_id, binding_row.external_record_id,
      binding_row.attestation_sha256, binding_row.revoked_at_epoch_micros;
    RETURN;
  END IF;
  PERFORM public.meri_phase4_lock_route_fence_exclusive(p_tenant_id);
  SELECT * INTO binding_row FROM public.meri_phase4_worker_bindings b
    WHERE b.binding_id = p_binding_id AND b.tenant_id = p_tenant_id
      AND b.source_id = p_source_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker binding not found' USING ERRCODE = '55000'; END IF;
  IF binding_row.revoked_at_epoch_micros IS NOT NULL THEN
    IF binding_row.revocation_id IS DISTINCT FROM p_revocation_id OR
       binding_row.revocation_digest IS DISTINCT FROM computed_revocation_digest THEN
      RAISE EXCEPTION 'binding revocation replay drift' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT binding_row.binding_id, binding_row.tenant_id,
      binding_row.source_id, binding_row.external_record_id,
      binding_row.attestation_sha256, binding_row.revoked_at_epoch_micros;
    RETURN;
  END IF;
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  UPDATE public.meri_phase4_worker_bindings b
    SET revoked_at_epoch_micros = db_now, revocation_id = p_revocation_id,
      revocation_digest = computed_revocation_digest
    WHERE b.binding_id = p_binding_id AND b.tenant_id = p_tenant_id
      AND b.source_id = p_source_id;
  RETURN QUERY SELECT b.binding_id, b.tenant_id, b.source_id, b.external_record_id,
    b.attestation_sha256, b.revoked_at_epoch_micros
    FROM public.meri_phase4_worker_bindings b WHERE b.binding_id = p_binding_id;
END;
$$;

CREATE FUNCTION public.meri_phase4_lock_worker_route_bound(
  p_tenant_id uuid, p_scope_id varchar, p_audience text, p_ingress_id text,
  p_generation text, p_credential_id text
) RETURNS TABLE (
  binding_id uuid, enabled boolean, closed_at_epoch_micros bigint,
  not_before_epoch_micros bigint, not_after_epoch_micros bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.current_tenant_id() OR
     p_scope_id IS NULL OR p_audience IS NULL OR p_ingress_id IS NULL OR
     p_generation IS NULL OR p_credential_id IS NULL THEN
    RAISE EXCEPTION 'authority route mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT r.binding_id, r.enabled, r.closed_at_epoch_micros,
      r.not_before_epoch_micros, r.not_after_epoch_micros
    FROM public.meri_phase4_worker_routes r
    WHERE r.tenant_id = p_tenant_id AND r.scope_id = p_scope_id
      AND r.worker_audience = p_audience AND r.worker_ingress_id = p_ingress_id
      AND r.worker_generation = p_generation AND r.worker_credential_id = p_credential_id
    FOR SHARE;
END;
$$;

CREATE FUNCTION public.meri_phase4_lock_worker_binding(
  p_binding_id uuid, p_tenant_id uuid, p_scope_id varchar, p_audience text,
  p_ingress_id text, p_generation text, p_credential_id text
) RETURNS TABLE (
  active boolean, not_before_epoch_micros bigint, not_after_epoch_micros bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.current_tenant_id() OR
     p_binding_id IS NULL THEN
    RAISE EXCEPTION 'authority binding mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT (b.revoked_at_epoch_micros IS NULL),
      b.not_before_epoch_micros, b.not_after_epoch_micros
    FROM public.meri_phase4_worker_bindings b
    JOIN public.meri_phase4_worker_binding_sources s ON s.source_id=b.source_id
    WHERE b.binding_id = p_binding_id AND b.tenant_id = p_tenant_id
      AND b.scope_id = p_scope_id AND b.worker_audience = p_audience
      AND b.worker_ingress_id = p_ingress_id AND b.worker_generation = p_generation
      AND b.worker_credential_id = p_credential_id AND s.qualified
      AND s.producer_role = b.attested_by_role
    FOR SHARE;
END;
$$;

CREATE FUNCTION public.meri_phase4_route_provision_disabled(
  p_tenant_id uuid, p_grant_id uuid, p_grant_nonce char(64),
  p_request_id uuid, p_binding_id uuid, p_lifetime bigint, p_request_digest char(64)
) RETURNS SETOF public.meri_phase4_worker_route_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prior public.meri_phase4_worker_route_receipts%ROWTYPE;
  b public.meri_phase4_worker_bindings%ROWTYPE;
  db_now bigint;
  route_after bigint;
  actual_digest char(64);
  grant_authority record;
BEGIN
  SELECT * INTO grant_authority FROM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,'provision',p_request_id,p_request_digest,false
  );
  actual_digest := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.route-command/v1','provision',p_tenant_id::text,
    grant_authority.actor_user_id::text,grant_authority.impersonation_session_id::text,grant_authority.reason,
    p_binding_id::text,p_lifetime::text
  ]);
  IF p_request_id IS NULL OR p_binding_id IS NULL OR
     p_request_digest::text !~ '^[0-9a-f]{64}$' OR p_request_digest IS DISTINCT FROM actual_digest THEN
    RAISE EXCEPTION 'invalid provision request digest' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts receipt_row
    WHERE receipt_row.tenant_id=p_tenant_id AND receipt_row.request_id=p_request_id;
  IF FOUND THEN
    IF prior.request_digest IS DISTINCT FROM actual_digest THEN
      RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.*; RETURN;
  END IF;
  PERFORM public.meri_phase4_lock_route_fence_exclusive(p_tenant_id);
  SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts receipt_row
    WHERE receipt_row.tenant_id=p_tenant_id AND receipt_row.request_id=p_request_id;
  IF FOUND THEN
    IF prior.request_digest IS DISTINCT FROM actual_digest THEN
      RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.*; RETURN;
  END IF;
  SELECT * INTO grant_authority FROM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,'provision',p_request_id,p_request_digest,true
  );
  IF p_lifetime <= 0 OR p_lifetime > 2592000000000 THEN
    RAISE EXCEPTION 'route lifetime outside approved maximum' USING ERRCODE = '22023';
  END IF;
  PERFORM public.meri_phase4_assert_route_scope(p_tenant_id,
    (SELECT scope_id FROM public.meri_phase4_worker_bindings WHERE binding_id=p_binding_id));
  SELECT x.* INTO b FROM public.meri_phase4_worker_bindings x
    JOIN public.meri_phase4_worker_binding_sources s ON s.source_id=x.source_id
    WHERE x.binding_id=p_binding_id AND x.tenant_id=p_tenant_id
      AND s.qualified AND s.producer_role=x.attested_by_role FOR SHARE OF x;
  IF NOT FOUND OR b.revoked_at_epoch_micros IS NOT NULL THEN
    RAISE EXCEPTION 'qualified active binding required' USING ERRCODE = '42501';
  END IF;
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  IF db_now < b.not_before_epoch_micros OR db_now >= b.not_after_epoch_micros THEN
    RAISE EXCEPTION 'binding outside DB-clock validity window' USING ERRCODE = '42501';
  END IF;
  route_after := least(db_now + p_lifetime, b.not_after_epoch_micros);
  IF route_after <= db_now THEN RAISE EXCEPTION 'route window expired' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.meri_phase4_worker_routes (
    tenant_id,scope_id,binding_id,worker_audience,worker_ingress_id,
    worker_generation,worker_credential_id,enabled,closed_at_epoch_micros,
    not_before_epoch_micros,not_after_epoch_micros
  ) VALUES (
    p_tenant_id,b.scope_id,b.binding_id,b.worker_audience,b.worker_ingress_id,
    b.worker_generation,b.worker_credential_id,false,NULL,db_now,route_after
  );
  RETURN QUERY SELECT * FROM public.meri_phase4_write_route_receipt(
    p_tenant_id,p_request_id,actual_digest,'provision','changed',grant_authority.actor_user_id,
    grant_authority.impersonation_session_id,grant_authority.reason,
    b.scope_id,b.worker_ingress_id,NULL,NULL,b.worker_generation,b.worker_credential_id,
    b.binding_id,NULL,NULL,db_now,route_after,db_now
  );
END;
$$;

CREATE FUNCTION public.meri_phase4_route_enable(
  p_tenant_id uuid,p_grant_id uuid,p_grant_nonce char(64),p_request_id uuid,
  p_scope varchar,p_ingress varchar,p_expected_generation varchar,
  p_expected_credential varchar,p_request_digest char(64)
) RETURNS SETOF public.meri_phase4_worker_route_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prior public.meri_phase4_worker_route_receipts%ROWTYPE;
  r public.meri_phase4_worker_routes%ROWTYPE;
  b public.meri_phase4_worker_bindings%ROWTYPE;
  db_now bigint;
  actual_digest char(64);
  grant_authority record;
BEGIN
  SELECT * INTO grant_authority FROM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,'enable',p_request_id,p_request_digest,false
  );
  actual_digest := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.route-command/v1','enable',p_tenant_id::text,
    grant_authority.actor_user_id::text,grant_authority.impersonation_session_id::text,grant_authority.reason,
    p_scope,p_ingress,p_expected_generation,p_expected_credential
  ]);
  IF p_request_id IS NULL OR p_request_digest::text !~ '^[0-9a-f]{64}$' OR
     p_request_digest IS DISTINCT FROM actual_digest THEN
    RAISE EXCEPTION 'invalid enable request digest' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts receipt_row
    WHERE receipt_row.tenant_id=p_tenant_id AND receipt_row.request_id=p_request_id;
  IF FOUND THEN
    IF prior.request_digest IS DISTINCT FROM actual_digest THEN
      RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.*; RETURN;
  END IF;
  PERFORM public.meri_phase4_lock_route_fence_exclusive(p_tenant_id);
  SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts receipt_row
    WHERE receipt_row.tenant_id=p_tenant_id AND receipt_row.request_id=p_request_id;
  IF FOUND THEN
    IF prior.request_digest IS DISTINCT FROM actual_digest THEN
      RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.*; RETURN;
  END IF;
  SELECT * INTO grant_authority FROM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,'enable',p_request_id,p_request_digest,true
  );
  PERFORM public.meri_phase4_assert_route_scope(p_tenant_id,p_scope);
  SELECT * INTO r FROM public.meri_phase4_worker_routes x
    WHERE x.tenant_id=p_tenant_id AND x.scope_id=p_scope
      AND x.worker_audience='meri-hermes-scope-worker' AND x.worker_ingress_id=p_ingress
      AND x.worker_generation=p_expected_generation
      AND x.worker_credential_id=p_expected_credential FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'route generation compare-and-swap failed' USING ERRCODE = '40001'; END IF;
  SELECT x.* INTO b FROM public.meri_phase4_worker_bindings x
    JOIN public.meri_phase4_worker_binding_sources s ON s.source_id=x.source_id
    WHERE x.binding_id=r.binding_id AND x.tenant_id=p_tenant_id
      AND x.scope_id=p_scope AND x.worker_audience=r.worker_audience
      AND x.worker_ingress_id=r.worker_ingress_id AND x.worker_generation=r.worker_generation
      AND x.worker_credential_id=r.worker_credential_id AND s.qualified
      AND s.producer_role=x.attested_by_role FOR SHARE OF x;
  IF NOT FOUND OR b.revoked_at_epoch_micros IS NOT NULL THEN
    RAISE EXCEPTION 'active route binding unavailable' USING ERRCODE = '42501';
  END IF;
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  IF db_now < r.not_before_epoch_micros OR db_now >= r.not_after_epoch_micros OR
     db_now < b.not_before_epoch_micros OR db_now >= b.not_after_epoch_micros THEN
    RAISE EXCEPTION 'route or binding outside DB-clock validity window' USING ERRCODE = '42501';
  END IF;
  IF r.closed_at_epoch_micros IS NOT NULL THEN
    RAISE EXCEPTION 'closed route generation cannot be re-enabled' USING ERRCODE = '55000';
  END IF;
  IF r.enabled THEN
    RETURN QUERY SELECT * FROM public.meri_phase4_write_route_receipt(
      p_tenant_id,p_request_id,actual_digest,'enable','no_op',grant_authority.actor_user_id,
      grant_authority.impersonation_session_id,grant_authority.reason,
      r.scope_id,r.worker_ingress_id,r.worker_generation,r.worker_credential_id,
      r.worker_generation,r.worker_credential_id,r.binding_id,
      r.not_before_epoch_micros,r.not_after_epoch_micros,
      r.not_before_epoch_micros,r.not_after_epoch_micros,db_now
    );
    RETURN;
  END IF;
  UPDATE public.meri_phase4_worker_routes SET enabled=true
    WHERE tenant_id=p_tenant_id AND scope_id=p_scope
      AND worker_audience='meri-hermes-scope-worker' AND worker_ingress_id=p_ingress;
  RETURN QUERY SELECT * FROM public.meri_phase4_write_route_receipt(
    p_tenant_id,p_request_id,actual_digest,'enable','changed',grant_authority.actor_user_id,
    grant_authority.impersonation_session_id,grant_authority.reason,
    r.scope_id,r.worker_ingress_id,r.worker_generation,r.worker_credential_id,
    r.worker_generation,r.worker_credential_id,r.binding_id,
    r.not_before_epoch_micros,r.not_after_epoch_micros,
    r.not_before_epoch_micros,r.not_after_epoch_micros,db_now
  );
END;
$$;

CREATE FUNCTION public.meri_phase4_route_close(
  p_tenant_id uuid,p_grant_id uuid,p_grant_nonce char(64),p_request_id uuid,
  p_scope varchar,p_ingress varchar,p_expected_generation varchar,
  p_expected_credential varchar,p_request_digest char(64)
) RETURNS SETOF public.meri_phase4_worker_route_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prior public.meri_phase4_worker_route_receipts%ROWTYPE;
  r public.meri_phase4_worker_routes%ROWTYPE;
  db_now bigint;
  actual_digest char(64);
  grant_authority record;
BEGIN
  SELECT * INTO grant_authority FROM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,'close',p_request_id,p_request_digest,false
  );
  actual_digest := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.route-command/v1','close',p_tenant_id::text,
    grant_authority.actor_user_id::text,grant_authority.impersonation_session_id::text,grant_authority.reason,
    p_scope,p_ingress,p_expected_generation,p_expected_credential
  ]);
  IF p_request_id IS NULL OR p_request_digest::text !~ '^[0-9a-f]{64}$' OR
     p_request_digest IS DISTINCT FROM actual_digest THEN
    RAISE EXCEPTION 'invalid close request digest' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts receipt_row
    WHERE receipt_row.tenant_id=p_tenant_id AND receipt_row.request_id=p_request_id;
  IF FOUND THEN
    IF prior.request_digest IS DISTINCT FROM actual_digest THEN
      RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.*; RETURN;
  END IF;
  PERFORM public.meri_phase4_lock_route_fence_exclusive(p_tenant_id);
  SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts receipt_row
    WHERE receipt_row.tenant_id=p_tenant_id AND receipt_row.request_id=p_request_id;
  IF FOUND THEN
    IF prior.request_digest IS DISTINCT FROM actual_digest THEN
      RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.*; RETURN;
  END IF;
  SELECT * INTO grant_authority FROM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,'close',p_request_id,p_request_digest,true
  );
  PERFORM public.meri_phase4_assert_route_scope(p_tenant_id,p_scope);
  SELECT * INTO r FROM public.meri_phase4_worker_routes x
    WHERE x.tenant_id=p_tenant_id AND x.scope_id=p_scope
      AND x.worker_audience='meri-hermes-scope-worker' AND x.worker_ingress_id=p_ingress
      AND x.worker_generation=p_expected_generation
      AND x.worker_credential_id=p_expected_credential FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'route generation compare-and-swap failed' USING ERRCODE = '40001'; END IF;
  IF r.closed_at_epoch_micros IS NOT NULL THEN
    RETURN QUERY SELECT * FROM public.meri_phase4_write_route_receipt(
      p_tenant_id,p_request_id,actual_digest,'close','no_op',grant_authority.actor_user_id,
      grant_authority.impersonation_session_id,grant_authority.reason,
      r.scope_id,r.worker_ingress_id,r.worker_generation,r.worker_credential_id,
      r.worker_generation,r.worker_credential_id,r.binding_id,
      r.not_before_epoch_micros,r.not_after_epoch_micros,
      r.not_before_epoch_micros,r.not_after_epoch_micros,
      floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
    );
    RETURN;
  END IF;
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  UPDATE public.meri_phase4_worker_routes SET enabled=false,closed_at_epoch_micros=db_now
    WHERE tenant_id=p_tenant_id AND scope_id=p_scope
      AND worker_audience='meri-hermes-scope-worker' AND worker_ingress_id=p_ingress;
  RETURN QUERY SELECT * FROM public.meri_phase4_write_route_receipt(
    p_tenant_id,p_request_id,actual_digest,'close','changed',grant_authority.actor_user_id,
    grant_authority.impersonation_session_id,grant_authority.reason,
    r.scope_id,r.worker_ingress_id,r.worker_generation,r.worker_credential_id,
    r.worker_generation,r.worker_credential_id,r.binding_id,
    r.not_before_epoch_micros,r.not_after_epoch_micros,
    r.not_before_epoch_micros,r.not_after_epoch_micros,db_now
  );
END;
$$;

CREATE FUNCTION public.meri_phase4_route_rotate_cas(
  p_tenant_id uuid,p_grant_id uuid,p_grant_nonce char(64),p_request_id uuid,
  p_scope varchar,p_ingress varchar,p_expected_generation varchar,
  p_expected_credential varchar,p_binding_id uuid,p_lifetime bigint,p_request_digest char(64)
) RETURNS SETOF public.meri_phase4_worker_route_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  prior public.meri_phase4_worker_route_receipts%ROWTYPE;
  old_route public.meri_phase4_worker_routes%ROWTYPE;
  b public.meri_phase4_worker_bindings%ROWTYPE;
  db_now bigint;
  route_after bigint;
  actual_digest char(64);
  grant_authority record;
BEGIN
  SELECT * INTO grant_authority FROM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,'rotate',p_request_id,p_request_digest,false
  );
  actual_digest := public.meri_phase4_route_digest_v1(ARRAY[
    'capiro.meri.phase4.route-command/v1','rotate',p_tenant_id::text,
    grant_authority.actor_user_id::text,grant_authority.impersonation_session_id::text,grant_authority.reason,
    p_scope,p_ingress,p_expected_generation,p_expected_credential,
    p_binding_id::text,p_lifetime::text
  ]);
  IF p_request_id IS NULL OR p_binding_id IS NULL OR
     p_request_digest::text !~ '^[0-9a-f]{64}$' OR p_request_digest IS DISTINCT FROM actual_digest THEN
    RAISE EXCEPTION 'invalid rotate request digest' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts receipt_row
    WHERE receipt_row.tenant_id=p_tenant_id AND receipt_row.request_id=p_request_id;
  IF FOUND THEN
    IF prior.request_digest IS DISTINCT FROM actual_digest THEN
      RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.*; RETURN;
  END IF;
  PERFORM public.meri_phase4_lock_route_fence_exclusive(p_tenant_id);
  SELECT * INTO prior FROM public.meri_phase4_worker_route_receipts receipt_row
    WHERE receipt_row.tenant_id=p_tenant_id AND receipt_row.request_id=p_request_id;
  IF FOUND THEN
    IF prior.request_digest IS DISTINCT FROM actual_digest THEN
      RAISE EXCEPTION 'Phase 4 route idempotency key reused with different command' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT prior.*; RETURN;
  END IF;
  SELECT * INTO grant_authority FROM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,'rotate',p_request_id,p_request_digest,true
  );
  IF p_lifetime <= 0 OR p_lifetime > 2592000000000 THEN
    RAISE EXCEPTION 'route lifetime outside approved maximum' USING ERRCODE = '22023';
  END IF;
  PERFORM public.meri_phase4_assert_route_scope(p_tenant_id,p_scope);
  SELECT * INTO old_route FROM public.meri_phase4_worker_routes x
    WHERE x.tenant_id=p_tenant_id AND x.scope_id=p_scope
      AND x.worker_audience='meri-hermes-scope-worker' AND x.worker_ingress_id=p_ingress
      AND x.worker_generation=p_expected_generation
      AND x.worker_credential_id=p_expected_credential FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'route generation compare-and-swap failed' USING ERRCODE = '40001'; END IF;
  SELECT x.* INTO b FROM public.meri_phase4_worker_bindings x
    JOIN public.meri_phase4_worker_binding_sources s ON s.source_id=x.source_id
    WHERE x.binding_id=p_binding_id AND x.tenant_id=p_tenant_id
      AND x.scope_id=p_scope AND x.worker_audience=old_route.worker_audience
      AND x.worker_ingress_id=p_ingress AND x.revoked_at_epoch_micros IS NULL
      AND s.qualified AND s.producer_role=x.attested_by_role FOR SHARE OF x;
  IF NOT FOUND THEN RAISE EXCEPTION 'qualified active replacement binding required' USING ERRCODE = '42501'; END IF;
  IF b.worker_generation=old_route.worker_generation OR
     b.worker_credential_id=old_route.worker_credential_id THEN
    RAISE EXCEPTION 'rotation must change both generation and credential identity'
      USING ERRCODE = '22023';
  END IF;
  db_now := floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
  IF db_now < b.not_before_epoch_micros OR db_now >= b.not_after_epoch_micros THEN
    RAISE EXCEPTION 'replacement binding outside DB-clock validity window' USING ERRCODE = '42501';
  END IF;
  route_after := least(db_now + p_lifetime,b.not_after_epoch_micros);
  IF route_after <= db_now THEN RAISE EXCEPTION 'replacement route window expired' USING ERRCODE = '22023'; END IF;
  UPDATE public.meri_phase4_worker_routes SET
    binding_id=b.binding_id,worker_generation=b.worker_generation,
    worker_credential_id=b.worker_credential_id,enabled=false,closed_at_epoch_micros=NULL,
    not_before_epoch_micros=db_now,not_after_epoch_micros=route_after
  WHERE tenant_id=p_tenant_id AND scope_id=p_scope
    AND worker_audience='meri-hermes-scope-worker' AND worker_ingress_id=p_ingress;
  RETURN QUERY SELECT * FROM public.meri_phase4_write_route_receipt(
    p_tenant_id,p_request_id,actual_digest,'rotate','changed',grant_authority.actor_user_id,
    grant_authority.impersonation_session_id,grant_authority.reason,
    old_route.scope_id,old_route.worker_ingress_id,old_route.worker_generation,
    old_route.worker_credential_id,b.worker_generation,b.worker_credential_id,b.binding_id,
    old_route.not_before_epoch_micros,old_route.not_after_epoch_micros,db_now,route_after,db_now
  );
END;
$$;

CREATE FUNCTION public.meri_phase4_route_operator_receipt(
  p_tenant_id uuid,p_grant_id uuid,p_grant_nonce char(64),p_operation varchar,
  p_request_id uuid,p_request_digest char(64)
) RETURNS SETOF public.meri_phase4_worker_route_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.meri_phase4_authorize_route_grant(
    p_grant_id,p_grant_nonce,p_tenant_id,p_operation,p_request_id,p_request_digest,false
  );
  RETURN QUERY SELECT * FROM public.meri_phase4_worker_route_receipt_replay(
    p_tenant_id,p_request_id,p_request_digest
  );
END;
$$;

CREATE FUNCTION public.meri_phase4_guard_worker_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Phase 4 worker bindings are tombstones' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['revoked_at_epoch_micros','revocation_id','revocation_digest']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['revoked_at_epoch_micros','revocation_id','revocation_digest']) OR
     OLD.revoked_at_epoch_micros IS NOT NULL OR NEW.revoked_at_epoch_micros IS NULL OR
     NEW.revocation_id IS NULL OR NEW.revocation_digest IS NULL OR
     NEW.revocation_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'only one-way worker-binding revocation is permitted' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.meri_phase4_guard_binding_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'qualified Phase 4 binding sources are immutable; supersede through reviewed qualification'
    USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION public.meri_phase4_guard_route_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Phase 4 route receipts are append-only tombstones' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION public.meri_phase4_guard_route_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR
     (to_jsonb(NEW) - 'consumed_at_epoch_micros') IS DISTINCT FROM
       (to_jsonb(OLD) - 'consumed_at_epoch_micros') OR
     OLD.consumed_at_epoch_micros IS NOT NULL OR
     NEW.consumed_at_epoch_micros IS NULL THEN
    RAISE EXCEPTION 'Phase 4 route grants are append-only one-way tombstones'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- Serialize every impersonation-session lifecycle change with Phase 4 route
-- mutations. A route mutation takes the same tenant fence before rechecking
-- the session. Therefore either the mutation commits before an end/update
-- returns, or the mutation observes the new session state and is denied.
CREATE FUNCTION public.meri_phase4_fence_impersonation_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  old_tenant uuid;
  new_tenant uuid;
  affected_tenant uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_tenant := OLD.tenant_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_tenant := NEW.tenant_id; END IF;
  FOR affected_tenant IN
    SELECT DISTINCT affected.tenant_id
    FROM (VALUES (old_tenant), (new_tenant)) AS affected(tenant_id)
    WHERE affected.tenant_id IS NOT NULL
    ORDER BY affected.tenant_id
  LOOP
    UPDATE public.meri_phase4_authority_fences
      SET revision = revision + 1 WHERE tenant_id = affected_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'authority fence missing for impersonation lifecycle'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meri_phase4_binding_guard
  BEFORE UPDATE OR DELETE ON public.meri_phase4_worker_bindings
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_worker_binding();
CREATE TRIGGER meri_phase4_binding_source_immutable
  BEFORE UPDATE OR DELETE ON public.meri_phase4_worker_binding_sources
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_binding_source();
CREATE TRIGGER meri_phase4_binding_fence
  AFTER INSERT OR UPDATE OF revoked_at_epoch_micros ON public.meri_phase4_worker_bindings
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();
CREATE TRIGGER meri_phase4_route_receipt_append_only
  BEFORE UPDATE OR DELETE ON public.meri_phase4_worker_route_receipts
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_route_receipt();
CREATE TRIGGER meri_phase4_route_grant_append_only
  BEFORE UPDATE OR DELETE ON public.meri_phase4_route_operator_grants
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_route_grant();
CREATE TRIGGER meri_phase4_impersonation_session_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.impersonation_sessions
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_fence_impersonation_session();

-- Match locked row sources to the non-login FORCE-RLS table owner. It has no
-- role members; SECURITY DEFINER functions are the only runtime write path.
GRANT USAGE, CREATE ON SCHEMA public TO meri_phase4_authority_owner;
GRANT USAGE ON SCHEMA public TO meri_phase4_route_operator;
-- The PUBLIC baseline removes inherited EXECUTE. Preserve only the existing
-- RLS helpers required by capiro_app and by the owner-specific FORCE-RLS
-- policies used inside the fixed SECURITY DEFINER entry points.
GRANT EXECUTE ON FUNCTION public.current_tenant_id(), public.current_user_id(),
  public.rls_bypass() TO capiro_app, meri_phase4_authority_owner;
GRANT SELECT (id,status) ON public.tenants TO meri_phase4_authority_owner;
GRANT SELECT (id,actor_user_id,tenant_id,reason,expires_at,ended_at)
  ON public.impersonation_sessions TO meri_phase4_authority_owner;
GRANT SELECT (tenant_id,user_id,role,status)
  ON public.tenant_memberships TO meri_phase4_authority_owner;
GRANT SELECT (id,tenant_id,principal_type,principal_id,kind)
  ON public.meri_execution_scopes TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_worker_binding_sources OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_worker_bindings OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_route_operator_grants OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_worker_route_receipts OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_worker_routes OWNER TO meri_phase4_authority_owner;

ALTER FUNCTION public.meri_phase4_route_digest_v1(text[])
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_issue_route_operator_grant(uuid,uuid,varchar,uuid,char)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_authorize_route_grant(uuid,char,uuid,varchar,uuid,char,boolean)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_assert_route_scope(uuid,varchar)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_lock_route_fence_exclusive(uuid)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_worker_route_receipt_replay(uuid,uuid,char)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_write_route_receipt(uuid,uuid,char,varchar,varchar,uuid,uuid,varchar,varchar,varchar,varchar,varchar,varchar,varchar,uuid,bigint,bigint,bigint,bigint,bigint)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_attest_worker_binding(uuid,varchar,varchar,uuid,varchar,varchar,varchar,varchar,bigint,bigint)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_revoke_worker_binding(uuid,uuid,varchar,uuid)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_lock_worker_route_bound(uuid,varchar,text,text,text,text)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_lock_worker_binding(uuid,uuid,varchar,text,text,text,text)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_route_provision_disabled(uuid,uuid,char,uuid,uuid,bigint,char)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_route_enable(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,char)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_route_close(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,char)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_route_rotate_cas(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,uuid,bigint,char)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_route_operator_receipt(uuid,uuid,char,varchar,uuid,char)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_worker_binding()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_route_receipt()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_binding_source()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_route_grant()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_fence_impersonation_session()
  OWNER TO meri_phase4_authority_owner;

REVOKE ALL ON TABLE public.meri_phase4_worker_binding_sources,
  public.meri_phase4_worker_bindings, public.meri_phase4_route_operator_grants,
  public.meri_phase4_worker_route_receipts,
  public.meri_phase4_worker_routes FROM PUBLIC, meri_phase4_route_operator;
REVOKE ALL ON TABLE public.meri_phase4_worker_binding_sources,
  public.meri_phase4_worker_bindings, public.meri_phase4_route_operator_grants,
  public.meri_phase4_worker_route_receipts,
  public.meri_phase4_worker_routes FROM capiro_app;
GRANT SELECT ON public.meri_phase4_worker_routes TO capiro_app;

REVOKE ALL ON FUNCTION public.meri_phase4_route_digest_v1(text[]),
  public.meri_phase4_issue_route_operator_grant(uuid,uuid,varchar,uuid,char),
  public.meri_phase4_authorize_route_grant(uuid,char,uuid,varchar,uuid,char,boolean),
  public.meri_phase4_assert_route_scope(uuid,varchar),
  public.meri_phase4_lock_route_fence_exclusive(uuid),
  public.meri_phase4_worker_route_receipt_replay(uuid,uuid,char),
  public.meri_phase4_write_route_receipt(uuid,uuid,char,varchar,varchar,uuid,uuid,varchar,varchar,varchar,varchar,varchar,varchar,varchar,uuid,bigint,bigint,bigint,bigint,bigint),
  public.meri_phase4_attest_worker_binding(uuid,varchar,varchar,uuid,varchar,varchar,varchar,varchar,bigint,bigint),
  public.meri_phase4_revoke_worker_binding(uuid,uuid,varchar,uuid),
  public.meri_phase4_lock_worker_route_bound(uuid,varchar,text,text,text,text),
  public.meri_phase4_lock_worker_binding(uuid,uuid,varchar,text,text,text,text),
  public.meri_phase4_route_provision_disabled(uuid,uuid,char,uuid,uuid,bigint,char),
  public.meri_phase4_route_enable(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,char),
  public.meri_phase4_route_close(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,char),
  public.meri_phase4_route_rotate_cas(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,uuid,bigint,char),
  public.meri_phase4_route_operator_receipt(uuid,uuid,char,varchar,uuid,char),
  public.meri_phase4_guard_worker_binding(),
  public.meri_phase4_guard_route_receipt(),
  public.meri_phase4_guard_binding_source(),
  public.meri_phase4_guard_route_grant(),
  public.meri_phase4_fence_impersonation_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.meri_phase4_route_digest_v1(text[]),
  public.meri_phase4_issue_route_operator_grant(uuid,uuid,varchar,uuid,char),
  public.meri_phase4_authorize_route_grant(uuid,char,uuid,varchar,uuid,char,boolean),
  public.meri_phase4_assert_route_scope(uuid,varchar),
  public.meri_phase4_lock_route_fence_exclusive(uuid),
  public.meri_phase4_worker_route_receipt_replay(uuid,uuid,char),
  public.meri_phase4_write_route_receipt(uuid,uuid,char,varchar,varchar,uuid,uuid,varchar,varchar,varchar,varchar,varchar,varchar,varchar,uuid,bigint,bigint,bigint,bigint,bigint),
  public.meri_phase4_attest_worker_binding(uuid,varchar,varchar,uuid,varchar,varchar,varchar,varchar,bigint,bigint),
  public.meri_phase4_revoke_worker_binding(uuid,uuid,varchar,uuid),
  public.meri_phase4_lock_worker_route_bound(uuid,varchar,text,text,text,text),
  public.meri_phase4_lock_worker_binding(uuid,uuid,varchar,text,text,text,text),
  public.meri_phase4_route_provision_disabled(uuid,uuid,char,uuid,uuid,bigint,char),
  public.meri_phase4_route_enable(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,char),
  public.meri_phase4_route_close(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,char),
  public.meri_phase4_route_rotate_cas(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,uuid,bigint,char),
  public.meri_phase4_route_operator_receipt(uuid,uuid,char,varchar,uuid,char),
  public.meri_phase4_guard_worker_binding(),
  public.meri_phase4_guard_route_receipt(),
  public.meri_phase4_guard_binding_source(),
  public.meri_phase4_guard_route_grant(),
  public.meri_phase4_fence_impersonation_session() FROM capiro_app;
-- Cut off the predecessor helper: it validates only route identity and omits
-- the externally authenticated binding/source authority added by this
-- migration. Keeping EXECUTE would let a stale claimer bypass revocation.
REVOKE ALL ON FUNCTION public.meri_phase4_lock_worker_route(
  uuid,varchar,text,text,text,text
) FROM PUBLIC, capiro_app;
GRANT EXECUTE ON FUNCTION public.meri_phase4_route_provision_disabled(uuid,uuid,char,uuid,uuid,bigint,char),
  public.meri_phase4_route_enable(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,char),
  public.meri_phase4_route_close(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,char),
  public.meri_phase4_route_rotate_cas(uuid,uuid,char,uuid,varchar,varchar,varchar,varchar,uuid,bigint,char),
  public.meri_phase4_route_operator_receipt(uuid,uuid,char,varchar,uuid,char)
  TO meri_phase4_route_operator;
GRANT EXECUTE ON FUNCTION public.meri_phase4_issue_route_operator_grant(
  uuid,uuid,varchar,uuid,char
) TO capiro_app;
-- No source-specific producer exists yet. A later independently reviewed
-- qualification operation must create one LOGIN per source, add the exact
-- (source_id, producer_role) row, grant schema USAGE, and grant only these two
-- fixed functions to that one role.
GRANT EXECUTE ON FUNCTION public.meri_phase4_lock_worker_route_bound(uuid,varchar,text,text,text,text),
  public.meri_phase4_lock_worker_binding(uuid,uuid,varchar,text,text,text,text)
  TO capiro_app;

-- Post-create negative control: prove a routine created by the migration role
-- no longer receives PUBLIC EXECUTE from PostgreSQL's built-in default.
CREATE FUNCTION public.meri_phase4_default_acl_probe() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS 'SELECT 1';
DO $$
DECLARE exposure text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    WHERE p.oid = 'public.meri_phase4_default_acl_probe()'::regprocedure
      AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'new routines still inherit PUBLIC EXECUTE'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) x
    WHERE d.defaclobjtype = 'f'
      AND d.defaclnamespace = 0
      AND d.defaclrole IN (current_user::regrole, 'meri_phase4_authority_owner'::regrole)
      AND x.grantee = 0 AND x.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Phase 4 DDL owners retain default PUBLIC routine authority'
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
    RAISE EXCEPTION 'unsafe PostgreSQL PUBLIC routine after Phase 4 migration: %', exposure
      USING ERRCODE = '42501';
  END IF;
END $$;
DROP FUNCTION public.meri_phase4_default_acl_probe();

DO $$ BEGIN
  EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') AND
     pg_has_role('capiro_app','meri_phase4_authority_owner','member') THEN
    RAISE EXCEPTION 'capiro_app inherited Phase 4 owner authority' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_authority_owner'::regrole
       OR m.member = 'meri_phase4_authority_owner'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner membership survived migration' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    WHERE m.roleid = 'meri_phase4_route_operator'::regrole
       OR m.member = 'meri_phase4_route_operator'::regrole
  ) THEN
    RAISE EXCEPTION 'Phase 4 operator identities unexpectedly have memberships'
      USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;
COMMIT;
