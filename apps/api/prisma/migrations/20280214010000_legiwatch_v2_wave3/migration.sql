-- LegiWatch V2 Wave 3 — Digest generation/history/schedule (§5.8, §7
-- BACKEND REQUIRED: "digest generation, history, scheduling and PDF").
--
-- Analytics has no persisted state of its own (§7 aggregates are computed
-- on demand over the existing intel_alert/committee_hearing/congress_bill
-- tables) so this migration is Digest-only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────
-- Digest run history. `client_id` NULL = "All clients" (tenant-wide). The
-- full rendered content is stored so History reproduces exactly what was
-- generated, never a retroactive recomputation over data that has since
-- changed underneath it.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "legiwatch_digest_run" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "client_id" UUID,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "generated_by" TEXT NOT NULL,
  "item_count" INTEGER NOT NULL,
  "decision_count" INTEGER NOT NULL,
  "source_families" TEXT[] NOT NULL DEFAULT '{}',
  "content_jsonb" JSONB NOT NULL,

  CONSTRAINT "legiwatch_digest_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_digest_run_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_digest_run_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL,
  CONSTRAINT "legiwatch_digest_run_counts_check"
    CHECK ("item_count" >= 0 AND "decision_count" >= 0)
);

CREATE INDEX IF NOT EXISTS "legiwatch_digest_run_tenant_client_idx"
  ON "legiwatch_digest_run" ("tenant_id", "client_id", "generated_at" DESC);

ALTER TABLE "legiwatch_digest_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_digest_run" FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────
-- Digest delivery schedule — one row per (tenant, user, scope). This ONLY
-- stores the schedule; it sends nothing on its own (§1.5 — external send
-- stays behind the Stage H security review; "Send now" is a separate,
-- disabled control).
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "legiwatch_digest_schedule" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "client_id" UUID,
  "cadence" TEXT NOT NULL DEFAULT 'daily',
  "hour_utc" INTEGER NOT NULL DEFAULT 11,
  "email_enabled" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_digest_schedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_digest_schedule_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_digest_schedule_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL,
  CONSTRAINT "legiwatch_digest_schedule_cadence_check"
    CHECK ("cadence" IN ('daily', 'weekly', 'off')),
  CONSTRAINT "legiwatch_digest_schedule_hour_check"
    CHECK ("hour_utc" BETWEEN 0 AND 23)
);

-- Application code upserts by (tenant_id, user_id, client_id) using a
-- findFirst-then-write, NOT a DB-level unique constraint: Postgres treats
-- every NULL client_id as distinct, so a unique index here would silently
-- fail to prevent duplicate "All clients" schedule rows per user.
CREATE INDEX IF NOT EXISTS "legiwatch_digest_schedule_tenant_user_client_idx"
  ON "legiwatch_digest_schedule" ("tenant_id", "user_id", "client_id");

ALTER TABLE "legiwatch_digest_schedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legiwatch_digest_schedule" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  p TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'legiwatch_digest_run',
    'legiwatch_digest_schedule'
  ]
  LOOP
    p := t || '_isolation';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = t
        AND policyname = p
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (rls_bypass() OR tenant_id = current_tenant_id()) '
        || 'WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())',
        p, t
      );
    END IF;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_digest_run" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_digest_schedule" TO capiro_app;
  END IF;
END
$$;
