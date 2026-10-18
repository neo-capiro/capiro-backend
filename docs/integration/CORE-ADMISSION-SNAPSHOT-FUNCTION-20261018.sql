-- PROPOSAL (Core lane, capiro-backend #84) for meri-greenfield
-- infra/product-preview/first-chat-database-integration.sql, integration_grants phase (R0 places it).
-- Requested by dot #121 6248138427 / 6248171459 (instead of a column-level UPDATE grant to Core).
-- NOT applied anywhere. Core's receiver (apps/api/src/meri/execution-capability/meri-admitted-run.reader.ts)
-- calls exactly this signature on its existing transaction connection.
--
-- Contract `capiro.meri-core-admission-snapshot.v1`:
--   meri_core_authority.current_admission_v1(p_run_id uuid) RETURNS jsonb
--   SECURITY DEFINER, VOLATILE, PARALLEL UNSAFE, SET search_path = pg_catalog, pg_temp,
--   owned by the dedicated NOLOGIN role meri_core_admission_reader.
-- Order inside the call (Core takes its proposal advisory lock BEFORE calling it):
--   1. FOR SHARE on meri_product_budget.budget id=1, the canonical lock Meri's admission, revocation,
--      execution-grant installation and fence changes take FOR UPDATE first;
--   2. clock_timestamp(), in its own statement after the lock;
--   3. runs, tool_run_allocations, grants LEFT JOIN tool_grant_bindings (grants in stable grant_id order).
-- Returned JSON (closed; every key always present; times are integer epoch milliseconds, floored):
--   {
--     "contract": "capiro.meri-core-admission-snapshot.v1",
--     "budgetPresent": true|false,
--     "quarantined": true|false|null,
--     "dbNowMs": <int>,
--     "run": null | {"runId","attempt","workerArn","fence","policyRevision"},
--     "allocation": null | {"allocation": <jsonb>, "allocationSha256", "startedAtMs"},
--     "grants": [ {"grantId","runId","attempt","workerArn","fence","policyRevision","capabilitySha256",
--                  "expiresAtMs","state","boundGrantId","boundRunId","facts"} ... ]   -- ORDER BY grant_id, at most 65
--   }
-- The predicate stays Core's (meri-admitted-run.reader.ts); the function only reads under the lock.

BEGIN;

-- Dedicated owner: no login, no inheritance, not a superuser; only what the four reads and the row lock need.
CREATE ROLE meri_core_admission_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA meri_product_budget TO meri_core_admission_reader;
GRANT SELECT ON meri_product_budget.budget, meri_product_budget.runs, meri_product_budget.tool_run_allocations,
  meri_product_budget.grants, meri_product_budget.tool_grant_bindings TO meri_core_admission_reader;
-- PostgreSQL requires UPDATE privilege for FOR SHARE; one column only, held by the definer role, never used.
GRANT UPDATE (quarantined) ON meri_product_budget.budget TO meri_core_admission_reader;

CREATE SCHEMA meri_core_authority;
REVOKE ALL ON SCHEMA meri_core_authority FROM PUBLIC;

CREATE FUNCTION meri_core_authority.current_admission_v1(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_present boolean := false;
  v_quarantined boolean;
  v_now timestamptz;
  v_run jsonb;
  v_allocation jsonb;
  v_grants jsonb;
BEGIN
  -- 1. The canonical budget lock, first.
  SELECT true, b.quarantined INTO v_present, v_quarantined
    FROM meri_product_budget.budget AS b WHERE b.id = 1 FOR SHARE;
  v_present := COALESCE(v_present, false);
  -- 2. The database clock, in its own statement after the lock.
  v_now := pg_catalog.clock_timestamp();
  -- 3. The admission rows.
  SELECT pg_catalog.jsonb_build_object(
           'runId', r.run_id::text, 'attempt', r.attempt, 'workerArn', r.worker_arn,
           'fence', r.fence, 'policyRevision', r.policy_revision::text)
    INTO v_run
    FROM meri_product_budget.runs AS r WHERE r.run_id = p_run_id;
  SELECT pg_catalog.jsonb_build_object(
           'allocation', a.allocation, 'allocationSha256', a.allocation_sha256::text,
           'startedAtMs', pg_catalog.floor(pg_catalog.date_part('epoch', a.started_at) * 1000)::bigint)
    INTO v_allocation
    FROM meri_product_budget.tool_run_allocations AS a WHERE a.run_id = p_run_id;
  SELECT COALESCE(pg_catalog.jsonb_agg(x.item ORDER BY x.grant_id), '[]'::jsonb)
    INTO v_grants
    FROM (
      SELECT g.grant_id, pg_catalog.jsonb_build_object(
               'grantId', g.grant_id::text, 'runId', g.run_id::text, 'attempt', g.attempt, 'workerArn', g.worker_arn,
               'fence', g.fence, 'policyRevision', g.policy_revision::text, 'capabilitySha256', g.capability_sha256::text,
               'expiresAtMs', pg_catalog.floor(pg_catalog.date_part('epoch', g.expires_at) * 1000)::bigint,
               'state', g.state, 'boundGrantId', b.grant_id::text, 'boundRunId', b.run_id::text, 'facts', b.facts) AS item
        FROM meri_product_budget.grants AS g
        LEFT JOIN meri_product_budget.tool_grant_bindings AS b ON b.grant_id = g.grant_id
       WHERE g.run_id = p_run_id
       ORDER BY g.grant_id
       LIMIT 65
    ) AS x;
  RETURN pg_catalog.jsonb_build_object(
    'contract', 'capiro.meri-core-admission-snapshot.v1',
    'budgetPresent', v_present,
    'quarantined', v_quarantined,
    'dbNowMs', pg_catalog.floor(pg_catalog.date_part('epoch', v_now) * 1000)::bigint,
    'run', v_run,
    'allocation', v_allocation,
    'grants', v_grants);
END
$fn$;

ALTER FUNCTION meri_core_authority.current_admission_v1(uuid) OWNER TO meri_core_admission_reader;
REVOKE EXECUTE ON FUNCTION meri_core_authority.current_admission_v1(uuid) FROM PUBLIC;
-- Core API runtime role only (the preview Core task's DB_USER; `capiro_app` in Core source, to be
-- confirmed by the packet readback of the app credential's username).
GRANT USAGE ON SCHEMA meri_core_authority TO capiro_app;
GRANT EXECUTE ON FUNCTION meri_core_authority.current_admission_v1(uuid) TO capiro_app;

COMMIT;

-- ROLLBACK (run as one transaction):
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION meri_core_authority.current_admission_v1(uuid) FROM capiro_app;
-- REVOKE USAGE ON SCHEMA meri_core_authority FROM capiro_app;
-- DROP FUNCTION meri_core_authority.current_admission_v1(uuid);
-- DROP SCHEMA meri_core_authority;
-- REVOKE UPDATE (quarantined) ON meri_product_budget.budget FROM meri_core_admission_reader;
-- REVOKE SELECT ON meri_product_budget.budget, meri_product_budget.runs, meri_product_budget.tool_run_allocations,
--   meri_product_budget.grants, meri_product_budget.tool_grant_bindings FROM meri_core_admission_reader;
-- REVOKE USAGE ON SCHEMA meri_product_budget FROM meri_core_admission_reader;
-- DROP ROLE meri_core_admission_reader;
-- COMMIT;
