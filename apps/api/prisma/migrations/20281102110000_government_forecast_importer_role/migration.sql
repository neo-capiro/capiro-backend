-- Government forecasts (B8): the least-privilege importer identity for the
-- scheduled refresh and the one-off pinned apply (forecast-producer.ts,
-- scripts/sync-government-forecasts.ts, scripts/refresh-government-forecasts.ts).
--
-- Why a migration and not a one-time grant: the role and its privileges are
-- part of the schema the forecast tables were created with (20281101120000),
-- so every environment that carries those tables carries exactly this role, the
-- grants are reviewed with the code that issues the statements, and
-- `prisma migrate status` proves presence. Login is the one environment step:
-- the role is created NOLOGIN with no password in Git, and Release enables it
-- on the target cluster (`ALTER ROLE capiro_forecast_importer LOGIN PASSWORD ...`
-- with the value held in Secrets Manager; see
-- infra/cdk/lib/preview/FORECASTS-OPERATIONS-BRIEF.md). bootstrap-roles.ts is
-- not extended: it is bound to the live dev Compute stack and rotates the
-- serving roles; this job runs on the preview clone only.
--
-- No CREATEDB/CREATEROLE/SUPERUSER/BYPASSRLS/replication (Postgres defaults;
-- not re-asserted, see 20260822010000). Never the master user; never capiro_app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_forecast_importer') THEN
    CREATE ROLE capiro_forecast_importer NOLOGIN;
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

-- Exactly the six forecast tables (20281101120000) and, per table, exactly the
-- verbs the producer issues against it (forecast-producer.ts; verified by a full
-- persistForecastSnapshot run as this role on PostgreSQL 16 with these grants):
--   source       INSERT of the archived XML (ON CONFLICT needs SELECT)
--   head         SELECT ... FOR UPDATE, INSERT of new identities, UPDATE of heads
--   revision     INSERT of immutable content, SELECT of the previous content
--   check        INSERT ... RETURNING id, SELECT for replay/ordering, UPDATE of counts
--   observation  INSERT only
--   terminal     SELECT of first-observed identities, INSERT
-- No DELETE or TRUNCATE anywhere: revisions, observations, checks and terminal
-- identities are immutable history; heads only advance.
REVOKE ALL ON TABLE
  government_forecast_source,
  government_forecast,
  government_forecast_revision,
  government_forecast_check,
  government_forecast_observation,
  government_forecast_terminal
FROM capiro_forecast_importer;
GRANT SELECT, INSERT ON TABLE government_forecast_source TO capiro_forecast_importer;
GRANT SELECT, INSERT, UPDATE ON TABLE government_forecast TO capiro_forecast_importer;
GRANT SELECT, INSERT ON TABLE government_forecast_revision TO capiro_forecast_importer;
GRANT SELECT, INSERT, UPDATE ON TABLE government_forecast_check TO capiro_forecast_importer;
GRANT INSERT ON TABLE government_forecast_observation TO capiro_forecast_importer;
GRANT SELECT, INSERT ON TABLE government_forecast_terminal TO capiro_forecast_importer;

-- government_forecast_check.id is the one bigserial among the six: INSERT ...
-- RETURNING id needs the sequence.
GRANT USAGE, SELECT ON SEQUENCE government_forecast_check_id_seq TO capiro_forecast_importer;

-- pg_advisory_xact_lock(721111, 1) is a pg_catalog function executable by PUBLIC;
-- no grant is needed or possible from the non-superuser master.

COMMENT ON ROLE capiro_forecast_importer IS
  'Government forecasts importer (refresh-government-forecasts, sync-government-forecasts): per-table SELECT/INSERT/UPDATE as the producer issues them on the six government_forecast tables, USAGE on government_forecast_check_id_seq; NOLOGIN until Release enables it; no DELETE, no DDL, no other table.';
