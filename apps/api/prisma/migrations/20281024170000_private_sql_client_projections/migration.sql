-- Q03 B proposal ONLY. Root assigns the immutable forward migration path.
-- No existing policy, application role, data row or applied migration changes.
-- Credentials are provisioned by the release owner, never by this migration.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'capiro_private_projection_owner') THEN
    CREATE ROLE capiro_private_projection_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'capiro_private_query_ro') THEN
    CREATE ROLE capiro_private_query_ro LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname IN ('capiro_private_projection_owner', 'capiro_private_query_ro')
      AND (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR r.rolcanlogin <> (r.rolname = 'capiro_private_query_ro')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid))
  ) THEN
    RAISE EXCEPTION 'Private query roles must be ordinary isolated roles';
  END IF;
END
$roles$;

CREATE SCHEMA meri_private AUTHORIZATION capiro_private_projection_owner;
REVOKE ALL ON SCHEMA meri_private FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO capiro_private_projection_owner;
GRANT SELECT (id, status) ON public.tenants TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, user_id, role, status) ON public.tenant_memberships TO capiro_private_projection_owner;
GRANT SELECT (id, tenant_id, status, memory_wall) ON public.clients TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, client_id, user_id) ON public.client_memory_access TO capiro_private_projection_owner;
GRANT SELECT (
  id, tenant_id, client_id, client_request_id, outcome, government_problem, ask_type,
  minimum_win, limits, owner_user_id, created_by_user_id, status, version,
  ready_at, review_requested_at, deleted_at, created_at, updated_at
) ON public.client_objectives TO capiro_private_projection_owner;
GRANT SELECT (
  id, tenant_id, client_id, kind, occurred_at, title, body, actor_user_id, person_id,
  source_type, source_id, pinned, due_at, settled_at, metadata_jsonb,
  created_by_user_id, created_at, updated_at
) ON public.client_activity TO capiro_private_projection_owner;

-- Server-bound context. Missing/invalid context never means General. UUID casts
-- are guarded; a stale or malformed setting cannot broaden the predicate.
CREATE VIEW meri_private.visible_clients
WITH (security_barrier = true, security_invoker = false) AS
WITH context AS (
  SELECT
    CASE WHEN pg_catalog.current_setting('app.current_tenant', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN pg_catalog.current_setting('app.current_tenant', true)::uuid END AS tenant_id,
    CASE WHEN pg_catalog.current_setting('app.current_user', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN pg_catalog.current_setting('app.current_user', true)::uuid END AS actor_id,
    pg_catalog.current_setting('app.meri_query_scope', true) AS scope_kind,
    pg_catalog.current_setting('app.meri_query_client', true) AS client_setting,
    CASE WHEN pg_catalog.current_setting('app.meri_query_client', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN pg_catalog.current_setting('app.meri_query_client', true)::uuid END AS client_id
)
SELECT c.tenant_id, c.id AS client_id
FROM public.clients c
JOIN public.tenants t ON t.id = c.tenant_id AND t.status = 'active'
JOIN context x ON x.tenant_id = c.tenant_id
JOIN public.tenant_memberships m ON m.tenant_id = x.tenant_id AND m.user_id = x.actor_id
  AND m.status = 'active' AND m.role IN ('standard_user', 'user_admin', 'capiro_admin')
WHERE c.status <> 'archived'
  AND pg_catalog.current_setting('app.bypass_rls', true) = 'off'
  AND ((x.scope_kind = 'general' AND x.client_setting = '')
    OR (x.scope_kind = 'client' AND x.client_id = c.id))
  AND (NOT c.memory_wall OR EXISTS (
    SELECT 1 FROM public.client_memory_access a
    WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id AND a.user_id = x.actor_id
  ));

-- btrim's explicit character set is ECMAScript WhiteSpace + LineTerminator,
-- matching objectiveReadiness String.trim(). Preserve the stored text itself.
CREATE VIEW meri_private.client_objectives
WITH (security_barrier = true, security_invoker = false) AS
SELECT o.id, o.client_id, o.client_request_id AS request_id, o.outcome,
  o.government_problem, o.ask_type, o.minimum_win, o.limits, o.owner_user_id,
  o.created_by_user_id, o.status, o.version, o.ready_at, o.review_requested_at,
  o.created_at, o.updated_at,
  r.outcome AS readiness_outcome, r.government_problem AS readiness_government_problem,
  r.ask_type AS readiness_ask_type, r.minimum_win AS readiness_minimum_win,
  r.outcome::integer + r.government_problem::integer + r.ask_type::integer + r.minimum_win::integer AS readiness_completed_fields,
  4 AS readiness_required_fields,
  (r.outcome AND r.government_problem AND r.ask_type AND r.minimum_win) AS readiness_is_ready
FROM public.client_objectives o
JOIN meri_private.visible_clients v ON v.tenant_id = o.tenant_id AND v.client_id = o.client_id
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.btrim(o.outcome, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '' AS outcome,
    pg_catalog.btrim(o.government_problem, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '' AS government_problem,
    COALESCE(o.ask_type IN ('funding', 'policy_authority', 'both', 'protect_funding', 'meri_propose'), false) AS ask_type,
    pg_catalog.btrim(o.minimum_win, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '' AS minimum_win
) r
WHERE o.deleted_at IS NULL;

-- projectActivityDetails accepts extra envelope keys, but Quick Log and its
-- Objective are strict objects. Invalid details become null as one unit.
-- Safe bounded float conversion matches JSON.parse + z.number(): JSON numeric
-- values are observed as IEEE doubles by the current owner before validation.
CREATE VIEW meri_private.client_activity
WITH (security_barrier = true, security_invoker = false) AS
SELECT a.id, a.client_id, a.kind, a.occurred_at, a.title, a.body, a.actor_user_id,
  a.person_id, a.source_type, a.source_id, a.pinned, a.due_at, a.settled_at,
  a.created_by_user_id, a.created_at, a.updated_at, 'recorded'::text AS origin,
  detail.q ->> 'direction' AS direction, detail.q ->> 'counterparty' AS counterparty,
  reference.objective_id, reference.objective_version, reference.objective_revision_id,
  CASE WHEN reference.objective_id IS NULL THEN NULL
    WHEN current_objective.id IS NULL THEN 'unavailable'
    WHEN current_objective.version = reference.objective_version THEN 'current'
    ELSE 'changed' END AS objective_availability
FROM public.client_activity a
JOIN meri_private.visible_clients v ON v.tenant_id = a.tenant_id AND v.client_id = a.client_id
CROSS JOIN LATERAL (SELECT a.metadata_jsonb -> 'quickLog' AS q) raw
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN pg_catalog.jsonb_typeof(raw.q -> 'version') = 'number' THEN
      CASE WHEN (raw.q ->> 'version')::numeric BETWEEN 0.5 AND 1.5
        THEN (raw.q ->> 'version')::double precision ELSE 0 END ELSE 0 END AS format_version,
    CASE WHEN pg_catalog.jsonb_typeof(raw.q #> '{objective,objectiveVersion}') = 'number' THEN
      CASE WHEN (raw.q #>> '{objective,objectiveVersion}')::numeric BETWEEN 0.5 AND 2147483648
        THEN (raw.q #>> '{objective,objectiveVersion}')::double precision ELSE 0 END ELSE 0 END AS objective_version
) numbers
CROSS JOIN LATERAL (
  SELECT CASE WHEN
    CASE WHEN pg_catalog.jsonb_typeof(raw.q) = 'object' THEN
      raw.q ?& ARRAY['version', 'direction', 'counterparty', 'objective']
      AND raw.q - ARRAY['version', 'direction', 'counterparty', 'objective'] = '{}'::jsonb
      AND numbers.format_version = 1
      AND (raw.q -> 'direction' = 'null'::jsonb
        OR (pg_catalog.jsonb_typeof(raw.q -> 'direction') = 'string' AND raw.q ->> 'direction' IN ('we_owe', 'they_owe')))
      AND (raw.q -> 'counterparty' = 'null'::jsonb OR
        CASE WHEN pg_catalog.jsonb_typeof(raw.q -> 'counterparty') = 'string' THEN
          -- The locked Zod 4.6.7 string limit counts Unicode code points.
          pg_catalog.char_length(raw.q ->> 'counterparty') BETWEEN 1 AND 300
        ELSE false END)
      AND (raw.q -> 'objective' = 'null'::jsonb OR
        CASE WHEN pg_catalog.jsonb_typeof(raw.q -> 'objective') = 'object' THEN
          (raw.q -> 'objective') ?& ARRAY['objectiveId', 'objectiveVersion', 'objectiveRevisionId']
          AND (raw.q -> 'objective') - ARRAY['objectiveId', 'objectiveVersion', 'objectiveRevisionId'] = '{}'::jsonb
          AND pg_catalog.jsonb_typeof(raw.q #> '{objective,objectiveId}') = 'string'
          AND raw.q #>> '{objective,objectiveId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND pg_catalog.jsonb_typeof(raw.q #> '{objective,objectiveRevisionId}') = 'string'
          AND raw.q #>> '{objective,objectiveRevisionId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND numbers.objective_version BETWEEN 1 AND 2147483647
          AND numbers.objective_version = pg_catalog.trunc(numbers.objective_version)
        ELSE false END)
    ELSE false END
    THEN raw.q ELSE NULL END AS q
) detail
CROSS JOIN LATERAL (
  SELECT (detail.q #>> '{objective,objectiveId}')::uuid AS objective_id,
    (detail.q #>> '{objective,objectiveVersion}')::double precision::integer AS objective_version,
    (detail.q #>> '{objective,objectiveRevisionId}')::uuid AS objective_revision_id
) reference
LEFT JOIN public.client_objectives current_objective
  ON current_objective.tenant_id = a.tenant_id AND current_objective.client_id = a.client_id
  AND current_objective.id = reference.objective_id AND current_objective.deleted_at IS NULL;

ALTER VIEW meri_private.visible_clients OWNER TO capiro_private_projection_owner;
ALTER VIEW meri_private.client_objectives OWNER TO capiro_private_projection_owner;
ALTER VIEW meri_private.client_activity OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.visible_clients, meri_private.client_objectives, meri_private.client_activity FROM PUBLIC;
GRANT USAGE ON SCHEMA meri_private TO capiro_private_query_ro;
GRANT SELECT ON meri_private.client_objectives, meri_private.client_activity TO capiro_private_query_ro;
-- No runtime grant on visible_clients, raw tables, metadata, writes, functions,
-- sequences or role membership. Runtime admission checks effective drift.
