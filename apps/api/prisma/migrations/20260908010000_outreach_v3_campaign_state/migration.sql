-- Outreach V3 Revised Phase 2: canonical campaign state + deterministic command engine.
-- Additive only. No legacy Outreach table is altered or backfilled.
-- State snapshots and events are immutable at the database layer.

CREATE TABLE "outreach_sessions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "current_state_version" INTEGER NOT NULL DEFAULT 1,
  "title" VARCHAR(240),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "archived_at" TIMESTAMPTZ(6),
  CONSTRAINT "outreach_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_sessions_id_tenant_unique" UNIQUE ("id", "tenant_id"),
  CONSTRAINT "outreach_sessions_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_sessions_creator_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "outreach_sessions_status_check"
    CHECK ("status" IN ('active', 'completed', 'archived')),
  CONSTRAINT "outreach_sessions_current_version_check"
    CHECK ("current_state_version" >= 1),
  CONSTRAINT "outreach_sessions_archive_shape_check"
    CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL))
);

CREATE INDEX "outreach_sessions_owner_status_updated_idx"
  ON "outreach_sessions" ("tenant_id", "created_by_user_id", "status", "updated_at" DESC);

CREATE TABLE "outreach_state_versions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "schema_version" VARCHAR(64) NOT NULL,
  "spec_jsonb" JSONB NOT NULL,
  "spec_hash" CHAR(64) NOT NULL,
  "mutation_batch_id" UUID,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_state_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_state_versions_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_state_versions_session_tenant_fkey"
    FOREIGN KEY ("session_id", "tenant_id")
    REFERENCES "outreach_sessions"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "outreach_state_versions_creator_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "outreach_state_versions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "outreach_state_versions_hash_check" CHECK ("spec_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "outreach_state_versions_session_version_unique" UNIQUE ("session_id", "version")
);

CREATE INDEX "outreach_state_versions_tenant_session_created_idx"
  ON "outreach_state_versions" ("tenant_id", "session_id", "created_at" DESC);

CREATE TABLE "outreach_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "sequence" BIGINT NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "source" VARCHAR(32) NOT NULL,
  "state_version_before" INTEGER,
  "state_version_after" INTEGER,
  "command_batch_id" UUID,
  "command_type" VARCHAR(64),
  "payload_jsonb" JSONB,
  "payload_hash" CHAR(64),
  "safe_metadata_jsonb" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_events_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_events_session_tenant_fkey"
    FOREIGN KEY ("session_id", "tenant_id")
    REFERENCES "outreach_sessions"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "outreach_events_actor_fkey" FOREIGN KEY ("actor_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "outreach_events_sequence_check" CHECK ("sequence" >= 1),
  CONSTRAINT "outreach_events_source_check"
    CHECK ("source" IN ('user_control', 'user_proposal', 'future_model', 'system')),
  CONSTRAINT "outreach_events_payload_hash_check"
    CHECK ("payload_hash" IS NULL OR "payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "outreach_events_session_sequence_unique" UNIQUE ("session_id", "sequence")
);

CREATE INDEX "outreach_events_tenant_session_created_idx"
  ON "outreach_events" ("tenant_id", "session_id", "created_at");

-- Only the durable command_batch_result event carries command_batch_id. This
-- partial unique index is therefore the idempotency key for direct command retries.
CREATE UNIQUE INDEX "outreach_events_session_batch_unique"
  ON "outreach_events" ("session_id", "command_batch_id")
  WHERE "command_batch_id" IS NOT NULL;

CREATE TABLE "outreach_command_proposals" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "source" VARCHAR(32) NOT NULL,
  "expected_state_version" INTEGER NOT NULL,
  "commands_jsonb" JSONB NOT NULL,
  "commands_hash" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "decided_at" TIMESTAMPTZ(6),
  "decided_by_user_id" UUID,
  "applied_state_version" INTEGER,
  "rejection_code" VARCHAR(64),
  CONSTRAINT "outreach_command_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_command_proposals_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_command_proposals_session_tenant_fkey"
    FOREIGN KEY ("session_id", "tenant_id")
    REFERENCES "outreach_sessions"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "outreach_command_proposals_creator_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "outreach_command_proposals_decider_fkey" FOREIGN KEY ("decided_by_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "outreach_command_proposals_source_check"
    CHECK ("source" IN ('user', 'future_model', 'system')),
  CONSTRAINT "outreach_command_proposals_status_check"
    CHECK ("status" IN ('pending', 'applied', 'rejected', 'superseded')),
  CONSTRAINT "outreach_command_proposals_expected_version_check"
    CHECK ("expected_state_version" >= 1),
  CONSTRAINT "outreach_command_proposals_applied_version_check"
    CHECK ("applied_state_version" IS NULL OR "applied_state_version" >= 1),
  CONSTRAINT "outreach_command_proposals_hash_check"
    CHECK ("commands_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "outreach_command_proposals_decision_shape_check" CHECK (
    ("status" = 'pending' AND "decided_at" IS NULL AND "decided_by_user_id" IS NULL
      AND "applied_state_version" IS NULL AND "rejection_code" IS NULL)
    OR
    ("status" = 'applied' AND "decided_at" IS NOT NULL AND "decided_by_user_id" IS NOT NULL
      AND "applied_state_version" IS NOT NULL AND "rejection_code" IS NULL)
    OR
    ("status" = 'rejected' AND "decided_at" IS NOT NULL AND "decided_by_user_id" IS NOT NULL
      AND "applied_state_version" IS NULL)
    OR
    ("status" = 'superseded' AND "decided_at" IS NOT NULL
      AND "applied_state_version" IS NULL AND "rejection_code" = 'state_advanced')
  )
);

CREATE INDEX "outreach_command_proposals_session_status_created_idx"
  ON "outreach_command_proposals" ("session_id", "status", "created_at" DESC);
CREATE INDEX "outreach_command_proposals_tenant_owner_created_idx"
  ON "outreach_command_proposals" ("tenant_id", "created_by_user_id", "created_at" DESC);

CREATE TRIGGER "outreach_sessions_set_updated_at"
  BEFORE UPDATE ON "outreach_sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Immutable audit/history rows fail closed on direct UPDATE or DELETE. Tenant
-- lifecycle purge may use the existing app.allow_audit_purge transaction GUC.
CREATE OR REPLACE FUNCTION reject_outreach_v3_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "outreach_state_versions_append_only"
  BEFORE UPDATE OR DELETE ON "outreach_state_versions"
  FOR EACH ROW EXECUTE FUNCTION reject_outreach_v3_history_mutation();

CREATE TRIGGER "outreach_events_append_only"
  BEFORE UPDATE OR DELETE ON "outreach_events"
  FOR EACH ROW EXECUTE FUNCTION reject_outreach_v3_history_mutation();

-- Proposal content is immutable once created, and terminal decisions cannot be
-- rewritten. This is defense in depth around the service's explicit Apply/Reject
-- lifecycle; it prevents a future direct SQL path from changing what was proposed.
CREATE OR REPLACE FUNCTION enforce_outreach_v3_proposal_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'outreach proposal terminal state is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status NOT IN ('applied', 'rejected', 'superseded') THEN
    RAISE EXCEPTION 'invalid outreach proposal transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.expected_state_version IS DISTINCT FROM OLD.expected_state_version
    OR NEW.commands_jsonb IS DISTINCT FROM OLD.commands_jsonb
    OR NEW.commands_hash IS DISTINCT FROM OLD.commands_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'outreach proposal content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "outreach_command_proposals_lifecycle"
  BEFORE UPDATE ON "outreach_command_proposals"
  FOR EACH ROW EXECUTE FUNCTION enforce_outreach_v3_proposal_transition();

ALTER TABLE "outreach_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_sessions_isolation" ON "outreach_sessions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "outreach_state_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_state_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_state_versions_isolation" ON "outreach_state_versions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "outreach_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_events_isolation" ON "outreach_events"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "outreach_command_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_command_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_command_proposals_isolation" ON "outreach_command_proposals"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    -- Earlier repo migrations grant broad default table privileges to capiro_app;
    -- revoke the verbs this substrate never needs rather than assuming narrower
    -- GRANT statements override those defaults.
    GRANT SELECT, INSERT, UPDATE ON "outreach_sessions" TO capiro_app;
    REVOKE DELETE ON "outreach_sessions" FROM capiro_app;

    GRANT SELECT, INSERT ON "outreach_state_versions" TO capiro_app;
    REVOKE UPDATE, DELETE ON "outreach_state_versions" FROM capiro_app;

    GRANT SELECT, INSERT ON "outreach_events" TO capiro_app;
    REVOKE UPDATE, DELETE ON "outreach_events" FROM capiro_app;

    GRANT SELECT, INSERT, UPDATE ON "outreach_command_proposals" TO capiro_app;
    REVOKE DELETE ON "outreach_command_proposals" FROM capiro_app;
  END IF;
END
$$;
