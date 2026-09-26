-- Remove the retired Meri/Hermes runtime persistence surface.
-- Order matters because the tables form a dependency chain.

DROP TABLE IF EXISTS "meri_agent_interactions" CASCADE;
DROP TABLE IF EXISTS "meri_agent_run_events" CASCADE;
DROP TABLE IF EXISTS "meri_agent_profile_leases" CASCADE;
DROP TABLE IF EXISTS "meri_agent_admission_slots" CASCADE;
DROP TABLE IF EXISTS "meri_agent_run_reservations" CASCADE;
DROP TABLE IF EXISTS "meri_agent_budget_periods" CASCADE;
DROP TABLE IF EXISTS "meri_agent_runs" CASCADE;
DROP TABLE IF EXISTS "meri_execution_scopes" CASCADE;
