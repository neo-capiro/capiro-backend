-- Meeting Notetaker bot sessions — docs/plans/meeting-notetaker-bot-plan.md (Phase 0).
-- One row per Recall.ai bot dispatch to a meeting. Tenant-scoped with the canonical
-- RLS policy. Reuses current_tenant_id(), rls_bypass() and set_updated_at() defined
-- in 20260501000000_init_identity_tenancy — do NOT redefine them here.

CREATE TABLE "meeting_bot_sessions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "meeting_id" UUID NOT NULL,
  "client_id" UUID,
  "requested_by_user_id" UUID,
  "provider" TEXT NOT NULL DEFAULT 'recall',
  "region" TEXT,
  "external_bot_id" TEXT,
  "recording_id" TEXT,
  "transcript_id" TEXT,
  "platform" TEXT,
  "join_url" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "recording_policy" TEXT NOT NULL DEFAULT 'transcript_only',
  "consent_jsonb" JSONB NOT NULL DEFAULT '{}',
  "transcript_s3_key" TEXT,
  "debrief_id" UUID,
  "error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "ended_at" TIMESTAMPTZ(6),
  "metadata_jsonb" JSONB NOT NULL DEFAULT '{}',
  "raw_jsonb" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "meeting_bot_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meeting_bot_sessions_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "meeting_bot_sessions_meeting_fkey" FOREIGN KEY ("meeting_id")
    REFERENCES "meetings"("id") ON DELETE CASCADE,
  CONSTRAINT "meeting_bot_sessions_client_fkey" FOREIGN KEY ("client_id")
    REFERENCES "clients"("id") ON DELETE SET NULL
);

CREATE INDEX "meeting_bot_sessions_tenant_meeting_created_idx"
  ON "meeting_bot_sessions" ("tenant_id", "meeting_id", "created_at");

CREATE INDEX "meeting_bot_sessions_external_bot_idx"
  ON "meeting_bot_sessions" ("external_bot_id");

CREATE TRIGGER "meeting_bot_sessions_set_updated_at"
  BEFORE UPDATE ON "meeting_bot_sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row-Level Security: byte-for-byte the meeting_debriefs / clio_memory pattern.
-- FORCE so the policy applies even to the table owner; capiro_app is the
-- least-privilege runtime role. Every app access MUST run inside prisma.withTenant
-- (sets app.current_tenant) or withSystem (sets app.bypass_rls) — a query outside
-- those matches 0 rows / cannot write (intended fail-closed).
ALTER TABLE "meeting_bot_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_bot_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meeting_bot_sessions_isolation" ON "meeting_bot_sessions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meeting_bot_sessions" TO capiro_app;
  END IF;
END
$$;
