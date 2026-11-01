-- SOURCE PROPOSAL ONLY. No migration identity has been assigned.
-- Separate prerequisite for the accepted Research/Classic domain forward.
-- Requires independent review, producer compatibility and parent-owned DB gates.
-- No grants, role changes, owner changes, shared helper changes or view changes.
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
SET LOCAL idle_in_transaction_session_timeout = '10s';

-- Serialize baseline inspection and the policy changes. ONLY avoids locking any
-- unexpected descendant; the baseline below rejects all inheritance/partitions.
LOCK TABLE ONLY public.research_portfolios,
           ONLY public.research_portfolio_grants,
           ONLY public.research_portfolio_members IN ACCESS EXCLUSIVE MODE;

DO $baseline$
BEGIN
  IF (SELECT count(*)
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = c.relowner
      WHERE n.nspname = 'public'
        AND c.relname IN ('research_portfolios', 'research_portfolio_grants', 'research_portfolio_members')
        AND c.relkind = 'r' AND c.relpersistence = 'p' AND NOT c.relispartition
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
        AND NOT owner_role.rolsuper AND NOT owner_role.rolbypassrls
        AND owner_role.rolname NOT IN ('capiro_private_projection_owner', 'capiro_private_query_ro')
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i
                        WHERE i.inhrelid = c.oid OR i.inhparent = c.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                      AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
                      AND a.atttypid = 'pg_catalog.uuid'::regtype)) <> 3
  THEN
    RAISE EXCEPTION 'Research tenant-policy baseline mismatch; no changes allowed';
  END IF;

  -- Bind the existing canonical helpers, not a new tenant/identity mechanism.
  -- SHA256 pins are derived from init_identity_tenancy's literal function bodies.
  -- Normalize CRLF only for this source comparison; neither helper is rewritten.
  IF (SELECT count(*)
      FROM (VALUES
        ('current_tenant_id', 'pg_catalog.uuid'::regtype,
         '02a8b078a4019d09b7d7b7cbc9aae48e1acea1fbdb68be5b271e1347b837de82'),
        ('rls_bypass', 'pg_catalog.bool'::regtype,
         '358b2808c7e64a80c17d380180cde362fd2371802a13d2dbc71db3b3b000a5c0')
      ) AS expected(name, result_type, body_sha256)
      JOIN pg_catalog.pg_namespace n ON n.nspname = 'public'
      JOIN pg_catalog.pg_proc p ON p.pronamespace = n.oid AND p.proname = expected.name
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE p.prokind = 'f' AND p.pronargs = 0 AND p.prorettype = expected.result_type
        AND NOT p.proretset AND NOT p.prosecdef AND NOT p.proleakproof
        AND p.provolatile = 's' AND p.proconfig IS NULL AND l.lanname = 'plpgsql'
        AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.replace(p.prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') = expected.body_sha256) <> 2
  THEN
    RAISE EXCEPTION 'Canonical tenant policy helpers required; no changes allowed';
  END IF;
END
$baseline$;

-- Canonical tenant isolation only. Current active membership, explicit portfolio
-- grants and source visibility remain with existing application/view owners.
-- TO PUBLIC is policy applicability, not a table privilege grant. The existing
-- trusted system bypass remains app.bypass_rls='on', as in other tenant policies.
ALTER TABLE public.research_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_portfolios FORCE ROW LEVEL SECURITY;
CREATE POLICY research_portfolios_isolation ON public.research_portfolios
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (public.rls_bypass() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.rls_bypass() OR tenant_id = public.current_tenant_id());

ALTER TABLE public.research_portfolio_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_portfolio_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY research_portfolio_grants_isolation ON public.research_portfolio_grants
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (public.rls_bypass() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.rls_bypass() OR tenant_id = public.current_tenant_id());

ALTER TABLE public.research_portfolio_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_portfolio_members FORCE ROW LEVEL SECURITY;
CREATE POLICY research_portfolio_members_isolation ON public.research_portfolio_members
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (public.rls_bypass() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.rls_bypass() OR tenant_id = public.current_tenant_id());

COMMIT;
