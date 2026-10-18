-- PROPOSAL (Core lane, capiro-backend #84) for meri-greenfield
-- infra/product-preview/first-chat-database-integration.sql, integration_grants phase (R0 places it).
-- Requested by dot #121 6248138427 / 6248171459 (instead of a column-level UPDATE grant to Core).
-- NOT applied anywhere. Core's receiver (apps/api/src/meri/execution-capability/meri-admitted-run.reader.ts)
-- calls exactly this signature on its existing transaction connection.
-- Install as the verified Aurora installer (current_user = session_user), which must be able to
-- CREATE ROLE, SET ROLE meri_product_migrator, grant a temporary SET-only reader membership,
-- and create the authority schema. The Meri packet must read back these capabilities first.
--
-- Contract `capiro.meri-core-admission-snapshot.v1`:
--   meri_core_authority.current_admission_v1(p_tenant_id uuid, p_conversation_id uuid, p_run_id uuid) RETURNS jsonb
--   SECURITY DEFINER, VOLATILE, PARALLEL UNSAFE, SET search_path = pg_catalog, pg_temp,
--   owned by the dedicated NOLOGIN role meri_core_admission_reader.
-- Order inside the call (Core takes its proposal advisory lock BEFORE calling it):
--   1. FOR SHARE on meri_product_budget.budget id=1, the canonical lock Meri's admission, revocation,
--      execution-grant installation and fence changes take FOR UPDATE first;
--   2. clock_timestamp(), in its own statement after the lock;
--   3. Meri's saved ADMITTED record (meri_conversations.native_allocations, read only, no lock: run retirement
--      revokes the grants under the budget lock first), then runs, tool_run_allocations and grants LEFT JOIN
--      tool_grant_bindings (grants in stable grant_id order).
-- Returned JSON (closed; every key always present; times are integer epoch milliseconds, floored):
--   {
--     "contract": "capiro.meri-core-admission-snapshot.v1",
--     "budgetPresent": true|false,
--     "quarantined": true|false|null,
--     "dbNowMs": <int>,
--     "admitted": null | {"state", "binding", "allocationSha256", "grantFactsJsons"},   -- from native_allocations.record
--     "run": null | {"runId","attempt","workerArn","fence","policyRevision"},
--     "allocation": null | {"allocation": <jsonb>, "allocationSha256", "startedAtMs"},
--     "grants": [ {"grantId","runId","attempt","workerArn","fence","policyRevision","capabilitySha256",
--                  "expiresAtMs","state","boundGrantId","boundRunId","facts"} ... ]   -- ORDER BY grant_id, at most 65
--   }
-- The predicate stays Core's (meri-admitted-run.reader.ts); the function only reads under the lock.

BEGIN;

DO $install$
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'MERI_CORE_ADMISSION_INSTALLER_ROLE_REQUIRED';
  END IF;
END
$install$;

-- Dedicated owner: no login, no inheritance, not a superuser; only what the four reads and the row lock need.
CREATE ROLE meri_core_admission_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
-- PostgreSQL 16 grants a CREATEROLE installer ADMIN but not SET on a newly created role.
-- Add SET without inherited privileges, then remove this installer-issued membership before COMMIT.
-- PostgreSQL retains the bootstrap ADMIN-only membership (SET FALSE, INHERIT FALSE) for
-- a non-superuser CREATEROLE installer; that creator cannot revoke it.
GRANT meri_core_admission_reader TO SESSION_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;

-- The base objects belong to Meri's migrator. Grant as that owner, not as the Aurora installer.
SET ROLE meri_product_migrator;
GRANT USAGE ON SCHEMA meri_product_budget TO meri_core_admission_reader;
GRANT USAGE ON SCHEMA meri_conversations TO meri_core_admission_reader;
GRANT SELECT ON meri_conversations.native_allocations TO meri_core_admission_reader;
GRANT SELECT ON meri_product_budget.budget, meri_product_budget.runs, meri_product_budget.tool_run_allocations,
  meri_product_budget.grants, meri_product_budget.tool_grant_bindings TO meri_core_admission_reader;
-- PostgreSQL requires UPDATE privilege for FOR SHARE; one column only, held by the definer role, never used.
GRANT UPDATE (quarantined) ON meri_product_budget.budget TO meri_core_admission_reader;
SET ROLE NONE;

CREATE SCHEMA meri_core_authority;
REVOKE ALL ON SCHEMA meri_core_authority FROM PUBLIC;
-- The reader needs CREATE only while installing its SECURITY DEFINER function. Retain USAGE.
GRANT USAGE, CREATE ON SCHEMA meri_core_authority TO meri_core_admission_reader;
-- Core API runtime role only (the preview Core task's DB_USER; `capiro_app` in Core source, to be
-- confirmed by the packet readback of the app credential's username).
GRANT USAGE ON SCHEMA meri_core_authority TO capiro_app;

-- Create as the definer so no ALTER OWNER (which also requires schema CREATE) is needed.
SET ROLE meri_core_admission_reader;

CREATE FUNCTION meri_core_authority.current_admission_v1(p_tenant_id uuid, p_conversation_id uuid, p_run_id uuid)
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
  v_admitted jsonb;
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
  -- 3. Meri's saved ADMITTED record for exactly this tenant/conversation/run, then the admission rows.
  SELECT pg_catalog.jsonb_build_object(
           'state', n.record -> 'state', 'binding', n.record -> 'binding',
           'allocationSha256', n.record -> 'allocationSha256', 'grantFactsJsons', n.record -> 'resource' -> 'grantFactsJsons')
    INTO v_admitted
    FROM meri_conversations.native_allocations AS n
   WHERE n.tenant_id = p_tenant_id::text AND n.conversation_id = p_conversation_id AND n.run_id = p_run_id;
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
    'admitted', v_admitted,
    'run', v_run,
    'allocation', v_allocation,
    'grants', v_grants);
END
$fn$;

REVOKE EXECUTE ON FUNCTION meri_core_authority.current_admission_v1(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION meri_core_authority.current_admission_v1(uuid, uuid, uuid) TO capiro_app;
SET ROLE NONE;

REVOKE CREATE ON SCHEMA meri_core_authority FROM meri_core_admission_reader;
-- Revoke the installer-issued SET membership; the bootstrap ADMIN-only edge remains.
REVOKE meri_core_admission_reader FROM SESSION_USER;

COMMIT;

-- ROLLBACK (run as one transaction):
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION meri_core_authority.current_admission_v1(uuid, uuid, uuid) FROM capiro_app;
-- REVOKE USAGE ON SCHEMA meri_core_authority FROM capiro_app;
-- DROP FUNCTION meri_core_authority.current_admission_v1(uuid, uuid, uuid);
-- DROP SCHEMA meri_core_authority;
-- REVOKE UPDATE (quarantined) ON meri_product_budget.budget FROM meri_core_admission_reader;
-- REVOKE SELECT ON meri_product_budget.budget, meri_product_budget.runs, meri_product_budget.tool_run_allocations,
--   meri_product_budget.grants, meri_product_budget.tool_grant_bindings FROM meri_core_admission_reader;
-- REVOKE SELECT ON meri_conversations.native_allocations FROM meri_core_admission_reader;
-- REVOKE USAGE ON SCHEMA meri_conversations FROM meri_core_admission_reader;
-- REVOKE USAGE ON SCHEMA meri_product_budget FROM meri_core_admission_reader;
-- DROP ROLE meri_core_admission_reader;
-- COMMIT;
