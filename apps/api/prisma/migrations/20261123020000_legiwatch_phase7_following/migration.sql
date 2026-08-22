-- LegiWatch Live Hearings — Phase 7 tenant follow state.
--
-- Scheduling remains on hearing_subscription because it is CAPTURE DEMAND.
-- Following is deliberately separate so a user can follow an event for start/
-- update notifications without accidentally creating global server-capture
-- demand. The Phase 6 capture worker counts hearing_subscription rows; keeping
-- follow state out of that table preserves that invariant.
--
-- TENANT scoped + FORCE RLS. The referenced hearing is a soft reference to the
-- GLOBAL committee_hearing table, matching hearing_subscription.

CREATE TABLE IF NOT EXISTS "hearing_follow" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "hearing_id" TEXT NOT NULL,
  "notify_on_start" BOOLEAN NOT NULL DEFAULT true,
  "notify_on_updates" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "hearing_follow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hearing_follow_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "hearing_follow_tenant_user_hearing_key"
  ON "hearing_follow" ("tenant_id", "user_id", "hearing_id");
CREATE INDEX IF NOT EXISTS "hearing_follow_tenant_user_idx"
  ON "hearing_follow" ("tenant_id", "user_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "hearing_follow_hearing_idx"
  ON "hearing_follow" ("hearing_id");

ALTER TABLE "hearing_follow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hearing_follow" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'hearing_follow'
      AND policyname = 'hearing_follow_isolation'
  ) THEN
    CREATE POLICY "hearing_follow_isolation" ON "hearing_follow"
      USING (rls_bypass() OR tenant_id = current_tenant_id())
      WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "hearing_follow" TO capiro_app;
  END IF;
END
$$;
