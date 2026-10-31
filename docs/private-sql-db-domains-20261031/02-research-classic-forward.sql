-- SOURCE ONLY: forward for separate review, not an applied migration.
-- Prerequisite: exact old14 projections plus separately qualified meeting335 forward.
-- Parent DB owner assigns the immutable migration path and operates the transaction.
-- No roles, policies, existing views, credentials or application grants are changed.
BEGIN;
SET LOCAL search_path = pg_catalog;
DO $prerequisite$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meri_private' AND c.relkind = 'v'
        AND c.relowner = 'capiro_private_projection_owner'::regrole
        AND c.reloptions @> ARRAY['security_barrier=true']
        AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)) <> 16
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meri_private' AND c.relname = 'client_meetings' AND c.relkind = 'v')
  THEN RAISE EXCEPTION 'Exact meeting predecessor required'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN
        ('research_portfolios','research_portfolio_grants','research_portfolio_members','outreach_records')
        AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relforcerowsecurity
        AND c.relowner NOT IN ('capiro_private_projection_owner'::regrole,'capiro_private_query_ro'::regrole)) <> 4
  THEN RAISE EXCEPTION 'Domain tenant source FORCE RLS prerequisite required'; END IF;
END
$prerequisite$;

GRANT SELECT (tenant_id, id, name, purpose, mode, lifecycle, revision, archived_at, created_at, updated_at) ON public.research_portfolios TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, portfolio_id, principal_user_id, role) ON public.research_portfolio_grants TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, portfolio_id, id, target_kind, target_id, label, disposition, origin, reason, resolved_at, revision, created_by_user_id, updated_by_user_id, created_at, updated_at) ON public.research_portfolio_members TO capiro_private_projection_owner;
GRANT SELECT (id, client_id, type, status, title, subject, body, recipient_count, sent_at, opened_in_email_at, created_at, updated_at, tenant_id, created_by_user_id, deleted_at) ON public.outreach_records TO capiro_private_projection_owner;

SET LOCAL ROLE capiro_private_projection_owner;

CREATE VIEW meri_private.research_portfolios
WITH (security_barrier = true, security_invoker = false) AS
WITH context AS (
  SELECT CASE WHEN pg_catalog.current_setting('app.current_tenant', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.current_tenant', true)::uuid END AS tenant_id,
    CASE WHEN pg_catalog.current_setting('app.current_user', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.current_user', true)::uuid END AS actor_id,
    CASE WHEN pg_catalog.current_setting('app.meri_query_portfolio', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.meri_query_portfolio', true)::uuid END AS portfolio_id
  WHERE pg_catalog.current_setting('app.meri_query_scope', true) = 'research_portfolio'
    AND pg_catalog.current_setting('app.meri_query_client', true) = ''
    AND pg_catalog.current_setting('app.meri_query_classic_ids', true) = ''
    AND pg_catalog.current_setting('app.bypass_rls', true) = 'off'
)
SELECT p.id AS portfolio_id, p.name::text AS name, p.purpose, p.mode::text AS mode,
  p.lifecycle::text AS lifecycle, p.revision, g.role::text AS my_role,
  p.archived_at, p.created_at, p.updated_at
FROM context x
JOIN public.research_portfolios p ON p.tenant_id = x.tenant_id AND p.id = x.portfolio_id
JOIN public.tenants t ON t.id = p.tenant_id AND t.status = 'active'
JOIN public.tenant_memberships m ON m.tenant_id = x.tenant_id AND m.user_id = x.actor_id
  AND m.status = 'active' AND m.role IN ('standard_user', 'user_admin', 'capiro_admin')
JOIN public.research_portfolio_grants g ON g.tenant_id = p.tenant_id AND g.portfolio_id = p.id
  AND g.principal_user_id = x.actor_id AND g.role IN ('viewer', 'editor', 'owner');

-- No lifecycle/disposition filter and no private target hydration.
CREATE VIEW meri_private.research_portfolio_members
WITH (security_barrier = true, security_invoker = false) AS
SELECT m.portfolio_id, m.id, m.target_kind::text AS target_kind, m.target_id::text AS target_id,
  m.label::text AS label, m.disposition::text AS disposition, m.origin::text AS origin,
  m.reason, m.resolved_at, m.revision, m.created_by_user_id, m.updated_by_user_id,
  m.created_at, m.updated_at
FROM public.research_portfolio_members m
JOIN meri_private.research_portfolios p ON p.portfolio_id = m.portfolio_id
WHERE m.tenant_id = CASE
  WHEN pg_catalog.current_setting('app.current_tenant', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN pg_catalog.current_setting('app.current_tenant', true)::uuid END;

-- IDs are the COMPLETE canonical server observation, before model aggregation.
-- Empty, missing, malformed, duplicate and over-100 settings yield no rows.
-- Linked-source checks remain canonical application pre/post observations.
CREATE VIEW meri_private.classic_outreach_records
WITH (security_barrier = true, security_invoker = false) AS
WITH raw_context AS (
  SELECT CASE WHEN pg_catalog.current_setting('app.current_tenant', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.current_tenant', true)::uuid END AS tenant_id,
    CASE WHEN pg_catalog.current_setting('app.current_user', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.current_user', true)::uuid END AS actor_id,
    CASE WHEN pg_catalog.current_setting('app.meri_query_client', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.meri_query_client', true)::uuid END AS client_id,
    pg_catalog.current_setting('app.meri_query_client', true) AS client_setting,
    pg_catalog.current_setting('app.meri_query_classic_ids', true) AS ids_setting
  WHERE pg_catalog.current_setting('app.meri_query_scope', true) = 'classic_outreach'
    AND pg_catalog.current_setting('app.meri_query_portfolio', true) = ''
    AND pg_catalog.current_setting('app.bypass_rls', true) = 'off'
), context AS (
  SELECT x.*, CASE WHEN pg_catalog.length(x.ids_setting) <= 3699
    AND x.ids_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,99}$'
    THEN pg_catalog.string_to_array(x.ids_setting, ',')::uuid[]
    ELSE ARRAY[]::uuid[] END AS eligible_ids
  FROM raw_context x
)
SELECT r.id, r.client_id, r.type, r.status, r.title, r.subject, r.body,
  r.recipient_count, r.sent_at, r.opened_in_email_at, r.created_at, r.updated_at
FROM context x
JOIN public.outreach_records r ON r.tenant_id = x.tenant_id
  AND r.created_by_user_id = x.actor_id AND r.id = ANY(x.eligible_ids)
JOIN public.tenants t ON t.id = x.tenant_id AND t.status = 'active'
JOIN public.tenant_memberships m ON m.tenant_id = x.tenant_id AND m.user_id = x.actor_id
  AND m.status = 'active' AND m.role IN ('standard_user', 'user_admin', 'capiro_admin')
WHERE r.deleted_at IS NULL AND r.type <> 'outreach_v3'
  AND pg_catalog.cardinality(x.eligible_ids) =
    (SELECT count(DISTINCT id) FROM pg_catalog.unnest(x.eligible_ids) AS selected(id))
  AND (x.client_setting = '' OR (r.client_id = x.client_id AND EXISTS (
    SELECT 1 FROM public.clients c WHERE c.tenant_id = x.tenant_id AND c.id = x.client_id
      AND c.status <> 'archived' AND (NOT c.memory_wall OR EXISTS (
        SELECT 1 FROM public.client_memory_access a
        WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id AND a.user_id = x.actor_id
      ))
  )));

RESET ROLE;
REVOKE ALL ON meri_private.research_portfolios FROM PUBLIC;
GRANT SELECT ON meri_private.research_portfolios TO capiro_private_query_ro;
REVOKE ALL ON meri_private.research_portfolio_members FROM PUBLIC;
GRANT SELECT ON meri_private.research_portfolio_members TO capiro_private_query_ro;
REVOKE ALL ON meri_private.classic_outreach_records FROM PUBLIC;
GRANT SELECT ON meri_private.classic_outreach_records TO capiro_private_query_ro;
COMMIT;
