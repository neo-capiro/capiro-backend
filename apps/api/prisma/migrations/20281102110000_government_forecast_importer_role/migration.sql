-- Government forecasts (B8): the least-privilege importer identity for the
-- scheduled refresh and the one-off pinned apply (forecast-producer.ts,
-- scripts/sync-government-forecasts.ts, scripts/refresh-government-forecasts.ts).
--
-- Why a migration and not a one-time grant: the role and its privileges are
-- part of the schema the forecast tables were created with (20281101120000),
-- so every environment that carries those tables carries exactly this role, the
-- grants are reviewed with the code that issues the statements, and
-- `prisma migrate status` proves presence. Only the password is environment
-- state: it is set once by Release on the target cluster (ALTER ROLE ... PASSWORD
-- with the value stored in Secrets Manager; see
-- infra/cdk/lib/preview/FORECASTS-OPERATIONS-BRIEF.md). bootstrap-roles.ts is
-- not extended: it is bound to the live dev Compute stack and rotates the
-- serving roles; this job runs on the preview clone only.
--
-- Same role pattern as capiro_analytics_ro (20280210010000): a real LOGIN role
-- with an unusable placeholder password, no CREATEDB/CREATEROLE/SUPERUSER/
-- BYPASSRLS/replication (Postgres defaults; not re-asserted, see
-- 20260822010000). Never the master user; never capiro_app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_forecast_importer') THEN
    CREATE ROLE capiro_forecast_importer LOGIN PASSWORD 'placeholder-rotate-via-release';
  END IF;
END
$$;

-- The producer runs one Serializable transaction (Prisma timeout 120 s) of
-- short statements: per-row SELECT ... FOR UPDATE, INSERT, UPDATE.
--   statement_timeout: no single statement is long; 60 s only catches a stuck one.
--   lock_timeout: the advisory lock is taken first inside the transaction, so a
--     concurrent duplicate waits here at most 10 s and then fails cleanly.
--   idle_in_transaction_session_timeout: above the producer's own 120 s so the
--     database never kills a live transaction before the client's timeout does;
--     a client that dies mid-transaction is cleared within 180 s.
ALTER ROLE capiro_forecast_importer SET statement_timeout = '60s';
ALTER ROLE capiro_forecast_importer SET lock_timeout = '10s';
ALTER ROLE capiro_forecast_importer SET idle_in_transaction_session_timeout = '180s';

GRANT CONNECT ON DATABASE capiro TO capiro_forecast_importer;
GRANT USAGE ON SCHEMA public TO capiro_forecast_importer;

-- Exactly the six forecast tables (20281101120000) and exactly the verbs the
-- producer issues: SELECT (including FOR UPDATE and ON CONFLICT), INSERT and
-- UPDATE. No DELETE or TRUNCATE: revisions, observations, checks and terminal
-- identities are immutable history; heads only advance.
REVOKE ALL ON TABLE
  government_forecast_source,
  government_forecast,
  government_forecast_revision,
  government_forecast_check,
  government_forecast_observation,
  government_forecast_terminal
FROM capiro_forecast_importer;
GRANT SELECT, INSERT, UPDATE ON TABLE
  government_forecast_source,
  government_forecast,
  government_forecast_revision,
  government_forecast_check,
  government_forecast_observation,
  government_forecast_terminal
TO capiro_forecast_importer;

-- government_forecast_check.id is the one bigserial among the six: INSERT ...
-- RETURNING id needs the sequence.
GRANT USAGE, SELECT ON SEQUENCE government_forecast_check_id_seq TO capiro_forecast_importer;

-- pg_advisory_xact_lock(721111, 1) is a pg_catalog function executable by PUBLIC;
-- no grant is needed or possible from the non-superuser master.

COMMENT ON ROLE capiro_forecast_importer IS
  'Government forecasts importer (refresh-government-forecasts, sync-government-forecasts): SELECT/INSERT/UPDATE on the six government_forecast tables and USAGE on government_forecast_check_id_seq; no DELETE, no DDL, no other table.';
