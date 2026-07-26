-- Engagement Phase 0 — trust boundary + external-send integrity.
--
-- Four ADDITIVE tenant-scoped tables that turn an externally sendable outreach
-- draft into an immutable, versioned, audited artifact and put a DURABLE send
-- intent in front of every provider call:
--
--   outreach_draft_artifacts  one logical recipient/group draft slot
--   outreach_draft_versions   immutable versions of that slot (never mutated in
--                             place for subject/body; audit/approval state is
--                             the only mutable part of a row)
--   outreach_send_intents     the durable intent committed BEFORE any provider
--                             request (idempotent per tenant+user+requestKey)
--   outreach_deliveries       one row per logical send unit, at-most-once
--
-- Canonical RLS: reuses current_tenant_id(), rls_bypass(), set_updated_at() from
-- 20260501000000_init_identity_tenancy — do NOT redefine them here. Policy shape
-- copied verbatim from 20260711010000_outreach_async_jobs.
--
-- Additive by construction: nothing is dropped except the outreach_jobs
-- request-key index, which is REPLACED in a data-shape-safe branch at the bottom
-- (per-user idempotency, plan task c3). outreach_jobs, outreach_job_items,
-- review_request and the legacy content-key hold fields all survive untouched,
-- and no historical OutreachRecord/ReviewRequest row is rewritten.

-- ---------------------------------------------------------------------------
-- 1. outreach_draft_artifacts — the stable per-recipient draft slot
-- ---------------------------------------------------------------------------
CREATE TABLE "outreach_draft_artifacts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "outreach_record_id" UUID NOT NULL,
  -- The wizard's GenerationTargetKey (individual:<rk> | list:<aid>:<rk> |
  -- group:<aid>). 512 because a recipientKey may itself be a composite id.
  "generation_key" VARCHAR(512) NOT NULL,
  "recipient_key" VARCHAR(256) NOT NULL,
  -- 'individual' | 'group'
  "audience_kind" VARCHAR(16) NOT NULL,
  "recipient_snapshot_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_by_user_id" UUID NOT NULL,
  -- Monotonic version counter; the artifact row is the FOR UPDATE lock target
  -- that serializes concurrent version creation for one slot.
  "current_version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_draft_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_draft_artifacts_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_draft_artifacts_record_fkey" FOREIGN KEY ("outreach_record_id")
    REFERENCES "outreach_records"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_draft_artifacts_user_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT
);

-- One artifact per (tenant, outreach record, generation key): a regenerate of
-- the same slot adds a VERSION, never a second artifact.
CREATE UNIQUE INDEX "outreach_draft_artifacts_tenant_record_genkey"
  ON "outreach_draft_artifacts" ("tenant_id", "outreach_record_id", "generation_key");
CREATE INDEX "outreach_draft_artifacts_tenant_record_idx"
  ON "outreach_draft_artifacts" ("tenant_id", "outreach_record_id");

-- ---------------------------------------------------------------------------
-- 2. outreach_draft_versions — the immutable audited artifact
-- ---------------------------------------------------------------------------
CREATE TABLE "outreach_draft_versions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  -- The version this one was edited/improved/reverted FROM (null for a fresh
  -- generation), so the edit chain is reconstructable without mutation.
  "source_version_id" UUID,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  -- sha256 of subject+body: what the audit verdict and any approval attach to.
  "content_hash" VARCHAR(80) NOT NULL,
  -- 'generated' | 'manually_authored' | 'generation_failed'
  "generation_status" VARCHAR(32) NOT NULL,
  -- 'not_required' | 'pending' | 'passed' | 'warning' | 'held' | 'unavailable'
  "audit_status" VARCHAR(32) NOT NULL,
  -- 'not_required' | 'pending' | 'approved' | 'rejected'
  "approval_status" VARCHAR(32) NOT NULL,
  "audit_mode" VARCHAR(16),
  "audit_decision" VARCHAR(32),
  "audit_findings_jsonb" JSONB,
  -- The structured auditor ledger entries this version was judged against.
  "audit_ledger_jsonb" JSONB NOT NULL DEFAULT '[]',
  "review_request_id" UUID,
  "context_packet_id" UUID,
  "provider" VARCHAR(32),
  "model" VARCHAR(160),
  "prompt_spec_version" VARCHAR(32),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_draft_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_draft_versions_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_draft_versions_artifact_fkey" FOREIGN KEY ("artifact_id")
    REFERENCES "outreach_draft_artifacts"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_draft_versions_source_fkey" FOREIGN KEY ("source_version_id")
    REFERENCES "outreach_draft_versions"("id") ON DELETE SET NULL,
  CONSTRAINT "outreach_draft_versions_review_fkey" FOREIGN KEY ("review_request_id")
    REFERENCES "review_request"("id") ON DELETE SET NULL,
  CONSTRAINT "outreach_draft_versions_packet_fkey" FOREIGN KEY ("context_packet_id")
    REFERENCES "context_packet"("id") ON DELETE SET NULL,
  CONSTRAINT "outreach_draft_versions_user_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT
);

-- (artifact, version) is the immutability anchor: a second writer racing on the
-- same next-version number loses here even if it somehow skipped the row lock.
CREATE UNIQUE INDEX "outreach_draft_versions_artifact_version"
  ON "outreach_draft_versions" ("artifact_id", "version");
CREATE INDEX "outreach_draft_versions_tenant_audit_approval_idx"
  ON "outreach_draft_versions" ("tenant_id", "audit_status", "approval_status");

-- ---------------------------------------------------------------------------
-- 3. outreach_send_intents — durable intent, committed before any provider call
-- ---------------------------------------------------------------------------
CREATE TABLE "outreach_send_intents" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "outreach_record_id" UUID NOT NULL,
  "sender_connection_id" UUID NOT NULL,
  -- Client idempotency token, minted once per Send click and retained across
  -- network retries.
  "request_key" VARCHAR(128) NOT NULL,
  "append_signature" BOOLEAN NOT NULL DEFAULT TRUE,
  "attachment_ids_jsonb" JSONB NOT NULL DEFAULT '[]',
  "test_mode" BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'queued' | 'running' | 'partial' | 'complete' | 'failed' | 'canceled'
  "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
  "totals_jsonb" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_send_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_send_intents_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_send_intents_user_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "outreach_send_intents_record_fkey" FOREIGN KEY ("outreach_record_id")
    REFERENCES "outreach_records"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_send_intents_connection_fkey" FOREIGN KEY ("sender_connection_id")
    REFERENCES "engagement_connections"("id") ON DELETE RESTRICT
);

-- Per-USER idempotency (not per-tenant): two users may legitimately mint the
-- same client-side key, and one must never resolve to the other's intent.
CREATE UNIQUE INDEX "outreach_send_intents_tenant_user_request_key"
  ON "outreach_send_intents" ("tenant_id", "user_id", "request_key");
-- Worker driver: the sweep finds queued/running intents oldest-first. Mirrors
-- the existing outreach_jobs_status_created_idx precedent.
CREATE INDEX "outreach_send_intents_status_created_idx"
  ON "outreach_send_intents" ("status", "created_at");
CREATE INDEX "outreach_send_intents_tenant_record_idx"
  ON "outreach_send_intents" ("tenant_id", "outreach_record_id");

-- ---------------------------------------------------------------------------
-- 4. outreach_deliveries — one row per logical send unit, at-most-once
-- ---------------------------------------------------------------------------
CREATE TABLE "outreach_deliveries" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "send_intent_id" UUID NOT NULL,
  "draft_version_id" UUID NOT NULL,
  "generation_key" VARCHAR(512) NOT NULL,
  "recipient_key" VARCHAR(256) NOT NULL,
  -- The exact To/Cc/Bcc envelope submitted to the provider.
  "recipient_envelope_jsonb" JSONB NOT NULL,
  -- sha256(tenant + connection + version + envelope + attachment manifest):
  -- the same exact delivery can never be created twice, under ANY request key.
  "idempotency_key" VARCHAR(160) NOT NULL,
  "correlation_id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  -- The exact rendered bytes handed to the provider, captured at intent
  -- creation — a later signature/body edit cannot mutate an in-flight send.
  "rendered_subject" TEXT NOT NULL,
  "rendered_body" TEXT NOT NULL,
  "attachment_manifest_jsonb" JSONB NOT NULL DEFAULT '[]',
  -- 'microsoft_graph' | 'gmail'
  "provider" VARCHAR(32) NOT NULL,
  -- 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped' | 'held'
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "provider_message_id" TEXT,
  "provider_thread_id" TEXT,
  "provider_draft_id" TEXT,
  "provider_internet_message_id" TEXT,
  "error_code" VARCHAR(120),
  "error_message" TEXT,
  "claimed_at" TIMESTAMPTZ(6),
  "accepted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_deliveries_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_deliveries_intent_fkey" FOREIGN KEY ("send_intent_id")
    REFERENCES "outreach_send_intents"("id") ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: an audited version that has been (or is being) sent
  -- must not be deletable out from under its delivery record.
  CONSTRAINT "outreach_deliveries_version_fkey" FOREIGN KEY ("draft_version_id")
    REFERENCES "outreach_draft_versions"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "outreach_deliveries_tenant_idempotency_key"
  ON "outreach_deliveries" ("tenant_id", "idempotency_key");
CREATE INDEX "outreach_deliveries_intent_status_idx"
  ON "outreach_deliveries" ("send_intent_id", "status");
CREATE INDEX "outreach_deliveries_tenant_correlation_idx"
  ON "outreach_deliveries" ("tenant_id", "correlation_id");

-- ---------------------------------------------------------------------------
-- updated_at triggers (only where the table HAS an updated_at column —
-- outreach_draft_versions deliberately has none: a version is created once).
-- ---------------------------------------------------------------------------
CREATE TRIGGER "outreach_draft_artifacts_set_updated_at"
  BEFORE UPDATE ON "outreach_draft_artifacts"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "outreach_send_intents_set_updated_at"
  BEFORE UPDATE ON "outreach_send_intents"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "outreach_deliveries_set_updated_at"
  BEFORE UPDATE ON "outreach_deliveries"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security — canonical outreach_jobs shape, FORCEd so the policy
-- applies even to the table owner.
-- ---------------------------------------------------------------------------
ALTER TABLE "outreach_draft_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_draft_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_draft_artifacts_isolation" ON "outreach_draft_artifacts"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "outreach_draft_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_draft_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_draft_versions_isolation" ON "outreach_draft_versions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "outreach_send_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_send_intents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_send_intents_isolation" ON "outreach_send_intents"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "outreach_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_deliveries_isolation" ON "outreach_deliveries"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "outreach_draft_artifacts" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "outreach_draft_versions" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "outreach_send_intents" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "outreach_deliveries" TO capiro_app;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- outreach_jobs: per-USER ownership + per-user idempotency (plan task c3).
--
-- getJob/retryItem/cancelJob now scope by user_id as well as tenant_id, so add
-- the covering index. The request-key uniqueness must move from
-- (tenant_id, request_key) to (tenant_id, user_id, request_key) — but ONLY when
-- every existing row actually has an owner. The branch is decided by the real
-- data, never assumed: legacy ownerless rows keep the old tenant-wide guard and
-- get a PARTIAL unique index instead, so this migration cannot fail on a
-- duplicate or leave rows unguarded either way.
--
-- outreach_jobs_tenant_user_request_key exists in BOTH branches (partial in the
-- legacy branch), which is what the Prisma schema declares.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "outreach_jobs_tenant_user_status_idx"
  ON "outreach_jobs" ("tenant_id", "user_id", "status");

DO $$
DECLARE
  ownerless BIGINT;
BEGIN
  SELECT count(*) INTO ownerless FROM "outreach_jobs" WHERE "user_id" IS NULL;

  IF ownerless = 0 THEN
    -- Every row has an owner: promote idempotency to per-user and retire the
    -- tenant-wide unique (which would otherwise make two users' identical
    -- request keys collide across mailboxes).
    CREATE UNIQUE INDEX "outreach_jobs_tenant_user_request_key"
      ON "outreach_jobs" ("tenant_id", "user_id", "request_key");
    DROP INDEX IF EXISTS "outreach_jobs_tenant_request_key";
    RAISE NOTICE 'outreach_jobs: 0 ownerless rows — per-user request-key uniqueness enforced.';
  ELSE
    -- Legacy ownerless rows exist. Keep the tenant-wide unique as their guard
    -- and add a PARTIAL unique for owned rows. Nothing is dropped.
    CREATE UNIQUE INDEX "outreach_jobs_tenant_user_request_key"
      ON "outreach_jobs" ("tenant_id", "user_id", "request_key")
      WHERE "user_id" IS NOT NULL;
    RAISE NOTICE 'outreach_jobs: % ownerless row(s) — kept tenant-wide unique, added PARTIAL per-user unique.', ownerless;
  END IF;
END
$$;
