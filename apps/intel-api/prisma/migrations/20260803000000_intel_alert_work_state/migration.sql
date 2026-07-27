-- P2-04 (Gate D phase e): per-user alert triage state.
--
-- The intelligence EVENT is global — `intel_alert.status` is shared by the whole
-- firm and is read by DEFAULT_STATUSES (feed.service.ts) and written by
-- dedupeStateActionAlerts and the emitter. Writing per-user triage into it would
-- hide an alert from every other user and collide with the suppression sweep, so
-- work state lives here instead.
--
-- ADDITIVE ONLY: CREATE TABLE + two indexes. No DROP, no type change, no NOT
-- NULL without a DEFAULT. A retry is a no-op (IF NOT EXISTS throughout).
--
-- RLS: the hold-list migration 20260706010000_intel_full_rls_hold enumerated 13
-- tables ONCE — a new intel_* table inherits nothing from it. Both halves below
-- are required and neither is optional:
--   1. the isolation policy, or this table is the only unprotected intel_* table;
--   2. the GRANT to capiro_app, or the application role cannot read or write it
--      at all and every work-state call fails at runtime.
-- tenant_id is plain TEXT (like every other intel_* table) while
-- current_tenant_id() returns UUID, hence the ::text cast — without it Postgres
-- raises 42883 "operator does not exist: text = uuid".

CREATE TABLE IF NOT EXISTS "intel_alert_work_state" (
  "id"            TEXT NOT NULL,
  "tenant_id"     TEXT NOT NULL,
  "client_id"     TEXT NOT NULL,
  "alert_id"      TEXT NOT NULL,
  "user_id"       TEXT NOT NULL,
  -- new | in_review | assigned | actioned | snoozed | dismissed
  "state"         TEXT NOT NULL DEFAULT 'new',
  "assigned_to"   TEXT,
  "snoozed_until" TIMESTAMPTZ(6),
  "note"          TEXT,
  "updated_by"    TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "intel_alert_work_state_pkey" PRIMARY KEY ("id")
);

-- The idempotency key: a repeated "mark reviewed" is an upsert, not a new row.
CREATE UNIQUE INDEX IF NOT EXISTS "intel_alert_work_state_alert_user_key"
  ON "intel_alert_work_state" ("alert_id", "user_id");

-- Covers the feed's per-user exclusion subquery (tenant + client + user + state).
CREATE INDEX IF NOT EXISTS "intel_alert_work_state_scope_idx"
  ON "intel_alert_work_state" ("tenant_id", "client_id", "user_id", "state");

ALTER TABLE "intel_alert_work_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_alert_work_state" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'intel_alert_work_state'
      AND policyname = 'intel_alert_work_state_isolation'
  ) THEN
    CREATE POLICY "intel_alert_work_state_isolation" ON "intel_alert_work_state"
      USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
      WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_alert_work_state" TO capiro_app;
  END IF;
END
$$;
