-- APPLIED / LIVE (cutover complete). Companion to the hearing-only
-- 20260706000000_hearing_rls_hold; the caller-conversion sweep it depended on is
-- complete, so these policies are active in prod. (Historical note: authored as a
-- HOLD migration under the clio_memory RLS discipline, PR #246; folder name
-- retained — it is the migration's identity in _prisma_migrations, do NOT rename.)
--
-- Completes G3: Row-Level Security for the REMAINING 14 intel_* tables, now that
-- every one of their CRUD callers has been converted to route through
-- PrismaService.withTenant (per-tenant reads/writes) or withSystem (the
-- cross-tenant sweeps: watchlist-sync, bill-change-detector, intel-alert
-- emit/flush, linking sweeps, data-parity/parity audit + reconcile). Applying
-- RLS before that conversion would have silently blanked Radar/LegiWatch for
-- all 4 tenants (0 rows, not an error). The 6 Live Hearing tables are covered by
-- the sibling migration 20260706000000_hearing_rls_hold.
--
-- LANDMINE (PG 42883, "operator does not exist: text = uuid"): every intel_*
-- tenant_id column is plain TEXT (Prisma `String`, no @db.Uuid) while
-- current_tenant_id() returns UUID — every predicate casts
-- current_tenant_id()::text. Verified against schema.prisma (all 20 intel_*
-- tables are TEXT).
--
-- intel_parity_run is the ONE exception: its tenant_id is NULLABLE (a
-- cross-tenant 'all'-scope audit run stores tenant_id = NULL), and it is only
-- ever written/read via withSystem. It therefore gets a BYPASS-ONLY policy
-- (USING/ CHECK rls_bypass()) — a tenant-scoped session sees nothing, which is
-- correct: parity is an operator/audit artifact, never tenant-facing.
--
-- Policy functions current_tenant_id() (reads app.current_tenant) and
-- rls_bypass() (reads app.bypass_rls) are defined in apps/api migration
-- 20260501000000_init_identity_tenancy — this migration only adds policies.

-- ── Standard tenant-isolation tables (13) ────────────────────────────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'intel_feature_flag',
    'intel_watchlist',
    'intel_watchlist_term',
    'intel_watchlist_topic',
    'intel_watchlist_match',
    'intel_tracked_bill',
    'intel_alert',
    'intel_alert_preference',
    'intel_notification_log',
    'intel_alert_digest_queue',
    'intel_sms_verification',
    'intel_feedback',
    'intel_action_item'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (rls_bypass() OR tenant_id = current_tenant_id()::text) '
      || 'WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text)',
      t || '_isolation', t
    );
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO capiro_app', t);
    END IF;
  END LOOP;
END
$$;

-- ── Bypass-only audit table (nullable tenant_id) ─────────────────────────────
ALTER TABLE "intel_parity_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_parity_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY "intel_parity_run_isolation" ON "intel_parity_run"
  USING (rls_bypass())
  WITH CHECK (rls_bypass());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_parity_run" TO capiro_app;
  END IF;
END
$$;
