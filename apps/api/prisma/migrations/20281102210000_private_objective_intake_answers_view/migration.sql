-- Publish the saved Strategy intake answers of an Objective, read from the same
-- current revision snapshot (same version) the readiness columns use, so Meri
-- describes an intake Objective by its answers rather than by the blank legacy
-- columns. No new grant: the view owner already reads snapshot. The intake
-- owner is the native owner_user_id already published; the opaque intake owner
-- identifier and the free-text Meri context are not exposed. Values are those
-- parseStrategyIntake accepted on write; anything else reads as null. A target
-- date PostgreSQL cannot represent (e.g. year 0000, which older writers
-- accepted) reads as null instead of failing every query on the view (22008).
-- Existing columns, owner, grants and security_barrier are unchanged; three
-- columns are appended.
BEGIN;
SET LOCAL ROLE capiro_private_projection_owner;
CREATE OR REPLACE VIEW meri_private.client_objectives
WITH (security_barrier = true, security_invoker = false) AS
SELECT o.id, o.client_id, o.client_request_id AS request_id, o.outcome,
  o.government_problem, o.ask_type, o.minimum_win, o.limits, o.owner_user_id,
  o.created_by_user_id, o.status, o.version, o.ready_at, o.review_requested_at,
  o.created_at, o.updated_at,
  r.outcome AS readiness_outcome, r.government_problem AS readiness_government_problem,
  r.ask_type AS readiness_ask_type, r.minimum_win AS readiness_minimum_win,
  CASE WHEN i.saved THEN i.objective_type::integer + i.goal::integer + i.owner::integer
    ELSE r.outcome::integer + r.government_problem::integer + r.ask_type::integer + r.minimum_win::integer
  END AS readiness_completed_fields,
  CASE WHEN i.saved THEN 3 ELSE 4 END AS readiness_required_fields,
  CASE WHEN i.saved THEN i.objective_type AND i.goal AND i.owner
    ELSE r.outcome AND r.government_problem AND r.ask_type AND r.minimum_win
  END AS readiness_is_ready,
  CASE WHEN i.saved THEN 'strategy_intake' ELSE 'objective_fields' END AS readiness_basis,
  CASE WHEN i.saved THEN i.objective_type END AS readiness_objective_type,
  CASE WHEN i.saved THEN i.goal END AS readiness_goal,
  CASE WHEN i.saved THEN i.owner END AS readiness_owner,
  CASE WHEN i.saved AND pg_catalog.jsonb_typeof(a.type) = 'string'
    AND a.type #>> '{}' IN ('appropriations', 'authorization', 'regulatory', 'coalition', 'procurement', 'earmark', 'amendment')
    THEN a.type #>> '{}' END AS intake_type,
  CASE WHEN i.saved AND pg_catalog.jsonb_typeof(a.goal) = 'string' THEN a.goal #>> '{}' END AS intake_goal,
  CASE WHEN i.saved AND pg_catalog.jsonb_typeof(a.target_date) = 'string'
    AND a.target_date #>> '{}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND pg_catalog.pg_input_is_valid(a.target_date #>> '{}', 'date')
    THEN (a.target_date #>> '{}')::date END AS intake_target_date
FROM public.client_objectives o
JOIN meri_private.visible_clients v ON v.tenant_id = o.tenant_id AND v.client_id = o.client_id
CROSS JOIN LATERAL (
  SELECT
    pg_catalog.btrim(o.outcome, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '' AS outcome,
    pg_catalog.btrim(o.government_problem, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '' AS government_problem,
    COALESCE(o.ask_type IN ('funding', 'policy_authority', 'both', 'protect_funding', 'meri_propose'), false) AS ask_type,
    pg_catalog.btrim(o.minimum_win, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> '' AS minimum_win
) r
LEFT JOIN public.client_objective_revisions s
  ON s.tenant_id = o.tenant_id AND s.client_id = o.client_id
  AND s.objective_id = o.id AND s.version = o.version
CROSS JOIN LATERAL (
  SELECT
    COALESCE(s.snapshot ? 'strategyIntake', false) AS saved,
    COALESCE(s.snapshot #> '{readiness,checklist,type}' = 'true'::jsonb, false) AS objective_type,
    COALESCE(s.snapshot #> '{readiness,checklist,goal}' = 'true'::jsonb, false) AS goal,
    COALESCE(s.snapshot #> '{readiness,checklist,ownerUserId}' = 'true'::jsonb, false) AS owner
) i
CROSS JOIN LATERAL (
  SELECT s.snapshot #> '{strategyIntake,type}' AS type, s.snapshot #> '{strategyIntake,goal}' AS goal,
    s.snapshot #> '{strategyIntake,targetDate}' AS target_date
) a
WHERE o.deleted_at IS NULL;
COMMIT;
