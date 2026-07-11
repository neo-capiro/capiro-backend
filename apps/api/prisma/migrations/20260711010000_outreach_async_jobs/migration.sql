-- Async outreach job pipeline — docs/plans/2026-07-10-outreach-uplift-plan.md (W4 / §3.3).
-- Two tenant-scoped tables driving generate/send off the request path. Canonical
-- RLS: reuses current_tenant_id(), rls_bypass(), set_updated_at() from
-- 20260501000000_init_identity_tenancy — do NOT redefine them here.

CREATE TABLE "outreach_jobs" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID,
  "kind" VARCHAR(16) NOT NULL,
  "outreach_record_id" UUID,
  "params_jsonb" JSONB NOT NULL DEFAULT '{}',
  "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
  "totals_jsonb" JSONB NOT NULL DEFAULT '{}',
  "request_key" VARCHAR(128) NOT NULL,
  "error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_jobs_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE
);

-- Idempotency: a duplicate submit with the same (tenant, requestKey) resolves to
-- the existing job (the service upserts on this key) — never a second fan-out.
CREATE UNIQUE INDEX "outreach_jobs_tenant_request_key"
  ON "outreach_jobs" ("tenant_id", "request_key");
CREATE INDEX "outreach_jobs_status_created_idx"
  ON "outreach_jobs" ("status", "created_at");

CREATE TABLE "outreach_job_items" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "job_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "recipient_key" VARCHAR(256) NOT NULL,
  "payload_jsonb" JSONB NOT NULL DEFAULT '{}',
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "result_jsonb" JSONB,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "claimed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_job_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_job_items_job_fkey" FOREIGN KEY ("job_id")
    REFERENCES "outreach_jobs"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_job_items_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE
);

-- (jobId, recipientKey) is both the server-side dedup and the resume anchor:
-- re-inserting the same recipient into a job is a no-op, so a crashed submit that
-- half-inserted items is safely idempotent on retry.
CREATE UNIQUE INDEX "outreach_job_items_job_recipient"
  ON "outreach_job_items" ("job_id", "recipient_key");
CREATE INDEX "outreach_job_items_job_status_idx"
  ON "outreach_job_items" ("job_id", "status");

CREATE TRIGGER "outreach_jobs_set_updated_at"
  BEFORE UPDATE ON "outreach_jobs"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "outreach_job_items_set_updated_at"
  BEFORE UPDATE ON "outreach_job_items"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row-Level Security: the canonical meeting_bot_sessions / clio_memory pattern.
-- FORCE so the policy applies even to the table owner; every app access runs
-- inside prisma.withTenant (app.current_tenant) or withSystem (app.bypass_rls).
ALTER TABLE "outreach_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_jobs_isolation" ON "outreach_jobs"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "outreach_job_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_job_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_job_items_isolation" ON "outreach_job_items"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "outreach_jobs" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "outreach_job_items" TO capiro_app;
  END IF;
END
$$;
