-- Dormant Phase 4 current-authority foundation. The fence is deliberately not
-- cascade-linked to tenants: deletion leaves a tombstone and tenant lookup
-- still denies. All values are tenant-scoped; no credential secret is stored.
-- The temporary ownership edge must never survive a partial migration.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_authority_owner') THEN
    CREATE ROLE meri_phase4_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_authority_owner' AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR
       rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'existing Phase 4 authority owner has unsafe attributes'
      USING ERRCODE = '42501';
  END IF;
  -- ALTER OWNER needs temporary membership on non-superuser migration hosts.
  -- It is removed before this migration commits; capiro_app receives none.
  EXECUTE format('GRANT meri_phase4_authority_owner TO %I', current_user);
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO meri_phase4_authority_owner;

CREATE TABLE public.meri_phase4_authority_fences (
  tenant_id uuid PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  policy_version text NOT NULL DEFAULT 'meri-phase4-policy-v1'
    CHECK (length(policy_version) > 0 AND btrim(policy_version) = policy_version)
);

INSERT INTO public.meri_phase4_authority_fences (tenant_id)
SELECT id FROM public.tenants ON CONFLICT (tenant_id) DO NOTHING;

-- One current route per tenant/private scope/audience/ingress. Replacing its generation or
-- credential closes every older identity. Only the dedicated owner has write
-- privileges; a future operator provisioning path must be separately granted.
CREATE TABLE public.meri_phase4_worker_routes (
  tenant_id uuid NOT NULL,
  scope_id varchar(200) NOT NULL,
  worker_audience text NOT NULL,
  worker_ingress_id text NOT NULL,
  worker_generation text NOT NULL,
  worker_credential_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  closed_at_epoch_micros bigint,
  not_before_epoch_micros bigint NOT NULL,
  not_after_epoch_micros bigint NOT NULL,
  PRIMARY KEY (tenant_id, scope_id, worker_audience, worker_ingress_id),
  CHECK (length(scope_id) > 0 AND btrim(scope_id) = scope_id),
  CHECK (length(worker_audience) > 0 AND btrim(worker_audience) = worker_audience),
  CHECK (length(worker_ingress_id) > 0 AND btrim(worker_ingress_id) = worker_ingress_id),
  CHECK (length(worker_generation) > 0 AND btrim(worker_generation) = worker_generation),
  CHECK (length(worker_credential_id) > 0 AND btrim(worker_credential_id) = worker_credential_id),
  CHECK (not_before_epoch_micros > 0 AND not_after_epoch_micros > not_before_epoch_micros),
  CHECK (closed_at_epoch_micros IS NULL OR closed_at_epoch_micros > 0)
);

-- The table owner is a dedicated non-login authority role. Explicit owner
-- policies make SECURITY DEFINER trigger writes work even with FORCE RLS;
-- runtime access uses only the tenant policy and never assumes BYPASSRLS.
ALTER TABLE public.meri_phase4_authority_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_authority_fences FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_fence_owner ON public.meri_phase4_authority_fences
  TO PUBLIC USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
    WHERE c.oid = 'public.meri_phase4_authority_fences'::regclass
  )) WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
    WHERE c.oid = 'public.meri_phase4_authority_fences'::regclass
  ));
CREATE POLICY meri_phase4_fence_tenant_read ON public.meri_phase4_authority_fences
  FOR SELECT TO PUBLIC USING (tenant_id = public.current_tenant_id());

ALTER TABLE public.meri_phase4_worker_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meri_phase4_worker_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY meri_phase4_route_owner ON public.meri_phase4_worker_routes
  TO PUBLIC USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
    WHERE c.oid = 'public.meri_phase4_worker_routes'::regclass
  )) WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
    WHERE c.oid = 'public.meri_phase4_worker_routes'::regclass
  ));
CREATE POLICY meri_phase4_route_tenant_read ON public.meri_phase4_worker_routes
  FOR SELECT TO PUBLIC USING (tenant_id = public.current_tenant_id());

-- The user lifecycle trigger must inspect every membership of one global
-- Clerk user, including other tenants, before ON DELETE CASCADE removes them.
-- Only the non-login authority owner can see the two columns it needs; this
-- does not grant the application any cross-tenant membership read.
CREATE POLICY meri_phase4_membership_owner_user_fence ON public.tenant_memberships
  FOR SELECT TO meri_phase4_authority_owner
  USING (current_user = 'meri_phase4_authority_owner');
GRANT SELECT (tenant_id, user_id) ON public.tenant_memberships
  TO meri_phase4_authority_owner;

-- Row locking requires authority the app must not have. Give the app
-- EXECUTE on narrow tenant-checked lock functions instead of table UPDATE.
-- SECURITY DEFINER runs as the table owner, which is explicitly admitted by
-- the FORCE RLS owner policies above; it does not rely on BYPASSRLS.
CREATE FUNCTION public.meri_phase4_lock_authority_fence(p_tenant_id uuid)
RETURNS TABLE (revision bigint, policy_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.current_tenant_id() THEN
    RAISE EXCEPTION 'authority tenant mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.revision, f.policy_version
    FROM public.meri_phase4_authority_fences f
    WHERE f.tenant_id = p_tenant_id FOR SHARE;
END;
$$;

-- Preparation may synchronize one execution-scope authorization generation.
-- Serialize that writer with claims and other authority writers without
-- granting the application UPDATE on the fence itself. NOWAIT lets a caller
-- roll back and retry instead of waiting while holding a source-row lock.
CREATE FUNCTION public.meri_phase4_try_lock_authority_fence_exclusive(p_tenant_id uuid)
RETURNS TABLE (revision bigint, policy_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.current_tenant_id() THEN
    RAISE EXCEPTION 'authority tenant mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT f.revision, f.policy_version
    FROM public.meri_phase4_authority_fences f
    WHERE f.tenant_id = p_tenant_id FOR UPDATE NOWAIT;
END;
$$;

CREATE FUNCTION public.meri_phase4_lock_worker_route(
  p_tenant_id uuid, p_scope_id varchar, p_audience text, p_ingress_id text,
  p_generation text, p_credential_id text
)
RETURNS TABLE (
  enabled boolean, closed_at_epoch_micros bigint,
  not_before_epoch_micros bigint, not_after_epoch_micros bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM public.current_tenant_id() OR
     p_scope_id IS NULL OR p_audience IS NULL OR p_ingress_id IS NULL OR
     p_generation IS NULL OR p_credential_id IS NULL THEN
    RAISE EXCEPTION 'authority route mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT r.enabled, r.closed_at_epoch_micros,
    r.not_before_epoch_micros, r.not_after_epoch_micros
    FROM public.meri_phase4_worker_routes r
    WHERE r.tenant_id = p_tenant_id AND r.scope_id = p_scope_id
      AND r.worker_audience = p_audience
      AND r.worker_ingress_id = p_ingress_id
      AND r.worker_generation = p_generation
      AND r.worker_credential_id = p_credential_id
    FOR SHARE;
END;
$$;

CREATE FUNCTION public.meri_phase4_guard_authority_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authority fence deletion is disabled' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'authority fence tenant is immutable' USING ERRCODE = '55000';
    END IF;
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER meri_phase4_fence_guard
  BEFORE UPDATE OR DELETE ON public.meri_phase4_authority_fences
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_guard_authority_fence();

-- Tenant insertion seeds the fence before any other tenant-scoped authority
-- row can be committed. All other authority mutations require an existing
-- fence and bump it in the writer's own transaction, including DELETE and
-- cross-tenant moves. A missing fence aborts the writer and denies claims.
CREATE FUNCTION public.meri_phase4_seed_authority_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.meri_phase4_authority_fences (tenant_id)
  VALUES (NEW.id) ON CONFLICT (tenant_id)
  DO UPDATE SET revision = meri_phase4_authority_fences.revision + 1;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.meri_phase4_bump_authority_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  old_tenant uuid;
  new_tenant uuid;
  affected_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'tenants' THEN
    IF TG_OP <> 'INSERT' THEN old_tenant := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN new_tenant := NEW.id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN old_tenant := OLD.tenant_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_tenant := NEW.tenant_id; END IF;
  END IF;
  -- Opposite cross-tenant moves must acquire the same two fence rows in the
  -- same order. DISTINCT also keeps same-tenant UPDATE at exactly one bump.
  FOR affected_tenant IN
    SELECT DISTINCT affected.tenant_id
    FROM (VALUES (old_tenant), (new_tenant)) AS affected(tenant_id)
    WHERE affected.tenant_id IS NOT NULL
    ORDER BY affected.tenant_id
  LOOP
    UPDATE public.meri_phase4_authority_fences
    SET revision = revision + 1 WHERE tenant_id = affected_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'authority fence missing' USING ERRCODE = '55000'; END IF;
  END LOOP;
  -- Return value is ignored by these AFTER triggers.
  RETURN NULL;
END;
$$;

-- Acquire the fence before PostgreSQL's unique-index insertion for a new
-- scope. This closes the absent-row race between a prepared authorization and
-- another writer inserting the same natural-key scope. AFTER INSERT still
-- performs the one revision bump used by the predicted m4a2 generation.
CREATE FUNCTION public.meri_phase4_lock_scope_insert_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE locked_tenant uuid;
BEGIN
  SELECT f.tenant_id INTO locked_tenant
  FROM public.meri_phase4_authority_fences f
  WHERE f.tenant_id = NEW.tenant_id FOR UPDATE;
  IF locked_tenant IS NULL THEN
    RAISE EXCEPTION 'authority fence missing' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- A global user may belong to several tenants. The BEFORE trigger runs while
-- membership rows still exist, takes their tenant fences in deterministic
-- order, and aborts the user write if any expected fence is missing.
CREATE FUNCTION public.meri_phase4_fence_user_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE member_tenant uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.clerk_user_id IS NOT DISTINCT FROM OLD.clerk_user_id THEN
    RETURN NEW;
  END IF;
  FOR member_tenant IN
    SELECT DISTINCT m.tenant_id FROM public.tenant_memberships m
    WHERE m.user_id = OLD.id ORDER BY m.tenant_id
  LOOP
    UPDATE public.meri_phase4_authority_fences
    SET revision = revision + 1 WHERE tenant_id = member_tenant;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'authority fence missing' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meri_phase4_tenant_seed AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_seed_authority_fence();
CREATE TRIGGER meri_phase4_tenant_fence AFTER UPDATE OF status, slug OR DELETE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();
CREATE TRIGGER meri_phase4_user_identity_fence
  BEFORE UPDATE OF clerk_user_id OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_fence_user_identity();
CREATE TRIGGER meri_phase4_membership_fence
  AFTER INSERT OR UPDATE OF tenant_id, user_id, role, status OR DELETE ON public.tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();
CREATE TRIGGER meri_phase4_client_fence
  AFTER INSERT OR UPDATE OF tenant_id, memory_wall, status OR DELETE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();
CREATE TRIGGER meri_phase4_client_access_fence
  AFTER INSERT OR UPDATE OR DELETE ON public.client_memory_access
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();
CREATE TRIGGER meri_phase4_mailbox_fence
  AFTER INSERT OR UPDATE OF tenant_id, created_by_user_id, provider, status OR DELETE
  ON public.engagement_connections FOR EACH ROW
  EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();
CREATE TRIGGER meri_phase4_conversation_fence
  AFTER INSERT OR UPDATE OF tenant_id, user_id, client_id, workspace_id, status,
    archived_at, metadata_jsonb OR DELETE ON public.clio_conversations
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();
CREATE TRIGGER meri_phase4_scope_insert_lock BEFORE INSERT ON public.meri_execution_scopes
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_lock_scope_insert_fence();
CREATE TRIGGER meri_phase4_scope_fence
  AFTER INSERT OR UPDATE OF tenant_id, principal_type, principal_id, kind,
    authorization_version OR DELETE ON public.meri_execution_scopes
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();
CREATE TRIGGER meri_phase4_worker_route_fence
  AFTER INSERT OR UPDATE OR DELETE ON public.meri_phase4_worker_routes
  FOR EACH ROW EXECUTE FUNCTION public.meri_phase4_bump_authority_fence();

ALTER TABLE public.meri_phase4_authority_fences OWNER TO meri_phase4_authority_owner;
ALTER TABLE public.meri_phase4_worker_routes OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_lock_authority_fence(uuid)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_try_lock_authority_fence_exclusive(uuid)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_lock_worker_route(uuid, varchar, text, text, text, text)
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_guard_authority_fence()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_seed_authority_fence()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_bump_authority_fence()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_lock_scope_insert_fence()
  OWNER TO meri_phase4_authority_owner;
ALTER FUNCTION public.meri_phase4_fence_user_identity()
  OWNER TO meri_phase4_authority_owner;

REVOKE ALL ON TABLE public.meri_phase4_authority_fences,
  public.meri_phase4_worker_routes FROM PUBLIC;
REVOKE ALL ON FUNCTION public.meri_phase4_seed_authority_fence(),
  public.meri_phase4_bump_authority_fence(),
  public.meri_phase4_lock_scope_insert_fence(),
  public.meri_phase4_fence_user_identity(),
  public.meri_phase4_guard_authority_fence(),
  public.meri_phase4_lock_authority_fence(uuid),
  public.meri_phase4_try_lock_authority_fence_exclusive(uuid),
  public.meri_phase4_lock_worker_route(uuid, varchar, text, text, text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL ON TABLE public.meri_phase4_authority_fences,
      public.meri_phase4_worker_routes FROM capiro_app;
    GRANT SELECT ON TABLE public.meri_phase4_authority_fences,
      public.meri_phase4_worker_routes TO capiro_app;
    REVOKE ALL ON FUNCTION public.meri_phase4_seed_authority_fence(),
      public.meri_phase4_bump_authority_fence(),
      public.meri_phase4_lock_scope_insert_fence(),
      public.meri_phase4_fence_user_identity(),
      public.meri_phase4_guard_authority_fence() FROM capiro_app;
    GRANT EXECUTE ON FUNCTION public.meri_phase4_lock_authority_fence(uuid),
      public.meri_phase4_try_lock_authority_fence_exclusive(uuid),
      public.meri_phase4_lock_worker_route(uuid, varchar, text, text, text, text) TO capiro_app;
  END IF;
END $$;
DO $$ BEGIN
  -- Remove the expected temporary edge before checking indirect membership.
  -- The migration owner may itself be an ancestor role of capiro_app.
  EXECUTE format('REVOKE meri_phase4_authority_owner FROM %I', current_user);
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') AND
     pg_has_role('capiro_app', 'meri_phase4_authority_owner', 'member') THEN
    RAISE EXCEPTION 'runtime role must not own Phase 4 authority';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
    WHERE r.rolname = 'meri_phase4_authority_owner'
  ) THEN
    RAISE EXCEPTION 'Phase 4 authority owner must have no members before provisioning';
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM meri_phase4_authority_owner;

COMMIT;
