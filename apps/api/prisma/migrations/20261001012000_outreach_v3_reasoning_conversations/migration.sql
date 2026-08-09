-- Outreach V3 Revised Phase 3: thin reasoning conversation continuity.
-- Additive only. Campaign truth remains in Phase 2 outreach_state_versions.
-- No hidden reasoning/chain-of-thought field exists in these tables.

CREATE TABLE "outreach_reasoning_conversations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "state_mode" VARCHAR(32) NOT NULL,
  "model" VARCHAR(160) NOT NULL,
  "reasoning_effort" VARCHAR(16) NOT NULL,
  "last_response_id" VARCHAR(255),
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "archived_at" TIMESTAMPTZ(6),
  CONSTRAINT "outreach_reasoning_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_reasoning_conversations_id_tenant_unique" UNIQUE ("id", "tenant_id"),
  CONSTRAINT "outreach_reasoning_conversations_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_reasoning_conversations_session_tenant_fkey"
    FOREIGN KEY ("session_id", "tenant_id")
    REFERENCES "outreach_sessions"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "outreach_reasoning_conversations_creator_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "outreach_reasoning_conversations_provider_check" CHECK ("provider" = 'openai'),
  CONSTRAINT "outreach_reasoning_conversations_state_mode_check"
    CHECK ("state_mode" IN ('capiro_managed', 'provider_state')),
  CONSTRAINT "outreach_reasoning_conversations_effort_check"
    CHECK ("reasoning_effort" IN ('low', 'medium', 'high')),
  CONSTRAINT "outreach_reasoning_conversations_status_check"
    CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "outreach_reasoning_conversations_archive_shape_check"
    CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL))
);

CREATE INDEX "outreach_reasoning_conversations_owner_session_used_idx"
  ON "outreach_reasoning_conversations"
    ("tenant_id", "created_by_user_id", "session_id", "last_used_at" DESC);

CREATE TABLE "outreach_reasoning_turns" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "state_version" INTEGER NOT NULL,
  "user_message_text" TEXT,
  "assistant_message_text" TEXT,
  "user_message_hash" CHAR(64) NOT NULL,
  "assistant_message_hash" CHAR(64),
  "provider_response_id" VARCHAR(255),
  "tool_result_refs_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "proposal_ids_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "open_questions_jsonb" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "usage_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "latency_ms" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "failure_code" VARCHAR(96),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "outreach_reasoning_turns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outreach_reasoning_turns_tenant_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "outreach_reasoning_turns_conversation_tenant_fkey"
    FOREIGN KEY ("conversation_id", "tenant_id")
    REFERENCES "outreach_reasoning_conversations"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "outreach_reasoning_turns_session_tenant_fkey"
    FOREIGN KEY ("session_id", "tenant_id")
    REFERENCES "outreach_sessions"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "outreach_reasoning_turns_actor_fkey" FOREIGN KEY ("actor_user_id")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "outreach_reasoning_turns_state_version_check" CHECK ("state_version" >= 1),
  CONSTRAINT "outreach_reasoning_turns_user_hash_check"
    CHECK ("user_message_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "outreach_reasoning_turns_assistant_hash_check"
    CHECK ("assistant_message_hash" IS NULL OR "assistant_message_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "outreach_reasoning_turns_latency_check" CHECK ("latency_ms" >= 0),
  CONSTRAINT "outreach_reasoning_turns_status_check" CHECK ("status" IN ('succeeded', 'failed')),
  CONSTRAINT "outreach_reasoning_turns_failure_shape_check" CHECK (
    ("status" = 'succeeded' AND "assistant_message_hash" IS NOT NULL AND "failure_code" IS NULL)
    OR
    ("status" = 'failed' AND "failure_code" IS NOT NULL)
  )
);

CREATE INDEX "outreach_reasoning_turns_conversation_created_idx"
  ON "outreach_reasoning_turns" ("conversation_id", "created_at" ASC, "id" ASC);
CREATE INDEX "outreach_reasoning_turns_tenant_session_created_idx"
  ON "outreach_reasoning_turns" ("tenant_id", "session_id", "created_at" DESC);

-- Visible reasoning turns are append-only product/audit records. Tenant lifecycle
-- purge may use the existing transaction-local app.allow_audit_purge convention.
CREATE TRIGGER "outreach_reasoning_turns_append_only"
  BEFORE UPDATE OR DELETE ON "outreach_reasoning_turns"
  FOR EACH ROW EXECUTE FUNCTION reject_outreach_v3_history_mutation();

CREATE TRIGGER "outreach_reasoning_conversations_delete_protected"
  BEFORE DELETE ON "outreach_reasoning_conversations"
  FOR EACH ROW EXECUTE FUNCTION reject_outreach_v3_delete();

CREATE OR REPLACE FUNCTION enforce_outreach_reasoning_conversation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.state_mode IS DISTINCT FROM OLD.state_mode
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.reasoning_effort IS DISTINCT FROM OLD.reasoning_effort
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'outreach reasoning conversation identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'archived' THEN
    RAISE EXCEPTION 'archived outreach reasoning conversation is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status NOT IN ('active', 'archived') THEN
    RAISE EXCEPTION 'invalid outreach reasoning conversation status' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "outreach_reasoning_conversations_lifecycle"
  BEFORE UPDATE ON "outreach_reasoning_conversations"
  FOR EACH ROW EXECUTE FUNCTION enforce_outreach_reasoning_conversation_update();

ALTER TABLE "outreach_reasoning_conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_reasoning_conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_reasoning_conversations_isolation" ON "outreach_reasoning_conversations"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "outreach_reasoning_turns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_reasoning_turns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outreach_reasoning_turns_isolation" ON "outreach_reasoning_turns"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "outreach_reasoning_conversations" TO capiro_app;
    REVOKE DELETE ON "outreach_reasoning_conversations" FROM capiro_app;
    GRANT SELECT, INSERT ON "outreach_reasoning_turns" TO capiro_app;
    REVOKE UPDATE, DELETE ON "outreach_reasoning_turns" FROM capiro_app;
  END IF;
END
$$;
