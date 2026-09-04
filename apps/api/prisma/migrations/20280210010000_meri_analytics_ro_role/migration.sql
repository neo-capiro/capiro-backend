-- Meri global-data analytics: a SELECT-only role scoped to exactly the
-- tables the `global-dataset-registry.ts` allowlist exposes to
-- `query_global_data`, plus the audit-log table that tool writes to (as
-- capiro_app, never as this new role).
--
-- Follows the capiro_pe_promoter pattern (migration 20260822010000): a real
-- LOGIN role, created with an unusable placeholder password exactly as
-- capiro_app/capiro_pe_promoter were, rotated to its real Secrets Manager
-- value by the bootstrap-roles ECS task. It intentionally does NOT use the
-- capiro_defense_serve/capiro_defense_job NOLOGIN-capability-role indirection
-- from migration 20261120200000 — that pattern exists to let multiple login
-- identities share one capability profile, which this role has no need for
-- (exactly one login identity, ever).
--
-- Every table below is a GLOBAL, no-tenant_id, ingested-fact table (see the
-- "GLOBAL tables" schema.prisma sections). This role must never be granted
-- access to a tenant-scoped table — that is a harder problem (see the
-- 2026-07-19 capiro_app RLS-bypass remediation doc) explicitly out of scope
-- for this migration.

-- Shape matches what `prisma migrate dev` would emit for the MeriAnalyticsQueryLog
-- model (id is client-generated, as with every other @default(uuid()) model
-- here) so a future `prisma migrate diff` sees no drift.
CREATE TABLE "meri_analytics_query_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID,
    "dataset_key" TEXT NOT NULL,
    "sql" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '[]',
    "row_count" INTEGER,
    "duration_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meri_analytics_query_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meri_analytics_query_log_created_at_idx" ON "meri_analytics_query_log"("created_at");

CREATE INDEX "meri_analytics_query_log_tenant_id_idx" ON "meri_analytics_query_log"("tenant_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_analytics_ro') THEN
    CREATE ROLE capiro_analytics_ro LOGIN PASSWORD 'placeholder-rotate-via-bootstrap-roles';
  END IF;
END
$$;

-- No CREATEDB, no CREATEROLE, no SUPERUSER, no BYPASSRLS, no replication --
-- all already Postgres's default for a bare `CREATE ROLE ... LOGIN PASSWORD`,
-- so nothing needs re-asserting via ALTER ROLE (see the identical note in
-- migration 20260822010000 on why re-asserting them would fail deployment
-- against Aurora's restricted master).

-- DB-enforced ceiling that holds even if application code has a bug: an
-- ad hoc aggregate query gets killed server-side regardless of what the
-- $transaction timeoutMs in AnalyticsDbService does or doesn't catch.
ALTER ROLE capiro_analytics_ro SET statement_timeout = '10s';
ALTER ROLE capiro_analytics_ro SET lock_timeout = '3s';
ALTER ROLE capiro_analytics_ro SET idle_in_transaction_session_timeout = '10s';

GRANT CONNECT ON DATABASE capiro TO capiro_analytics_ro;
GRANT USAGE ON SCHEMA public TO capiro_analytics_ro;

DO $grants$
DECLARE
  relation_name text;
  -- Exactly the base tables referenced by global-dataset-registry.ts's
  -- `table` values (lda_registrations' subquery reads only lda_filing).
  -- Keep this array and that file's registry in sync by hand — deliberately
  -- not auto-derived, so adding a dataset is a reviewed, two-file change.
  ro_relations text[] := ARRAY[
    'lda_filing',
    'federal_grant',
    'sam_opportunity',
    'federal_award',
    'sec_filing',
    'fara_registration',
    'congress_bill',
    'state_bill',
    'gao_report',
    'crs_report',
    'fec_committee',
    'intel_article'
  ];
BEGIN
  FOREACH relation_name IN ARRAY ro_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM capiro_analytics_ro', relation_name);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO capiro_analytics_ro', relation_name);
    END IF;
  END LOOP;
END
$grants$;

-- Explicit belt-and-suspenders: this role never writes anywhere, including
-- its own audit-log table (that write happens over the normal capiro_app
-- connection so the audit trail exists even if an analytics query fails).
REVOKE ALL ON TABLE meri_analytics_query_log FROM capiro_analytics_ro;

COMMENT ON ROLE capiro_analytics_ro IS
  'Meri query_global_data runtime role; SELECT-only on the global-dataset-registry allowlist, no DDL, no bypass-RLS, no write of any kind.';
