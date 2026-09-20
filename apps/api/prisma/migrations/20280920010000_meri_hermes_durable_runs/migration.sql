-- Phase 1 backlog #1: durable run/event/interaction tables replacing the Phase 0
-- in-memory MeriHermesRunStore prototype, behind the same MeriHermesRunRepository
-- interface (apps/api/src/meri/hermes/meri-hermes-run-store.ts). Additive only.
-- Design: docs/meri/hermes/phase-0/contracts.md §7.

CREATE TABLE "meri_execution_scopes" (
  "id" VARCHAR(200) NOT NULL,
  "tenant_id" UUID NOT NULL,
  "principal_type" VARCHAR(20) NOT NULL,
  "principal_id" VARCHAR(200) NOT NULL,
  "kind" VARCHAR(20) NOT NULL DEFAULT 'private',
  "authorization_version" VARCHAR(80) NOT NULL,
  "home_volume_ref" VARCHAR(200),
  "persona_version" VARCHAR(80),
  "worker_state_jsonb" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meri_execution_scopes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meri_execution_scopes_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "meri_execution_scopes_tenant_principal_idx"
  ON "meri_execution_scopes"("tenant_id", "principal_type", "principal_id");

CREATE TABLE "meri_agent_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "scope_id" VARCHAR(200) NOT NULL,
  "actor_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "user_message_id" UUID,
  "assistant_message_id" UUID,
  "hermes_run_id" VARCHAR(120),
  "hermes_session_id" VARCHAR(120),
  "status" VARCHAR(32) NOT NULL,
  "finish_reason" VARCHAR(20),
  "partial" BOOLEAN NOT NULL DEFAULT false,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "envelope_jsonb" JSONB NOT NULL,
  "actor_context_jsonb" JSONB NOT NULL,
  "last_seq" INTEGER NOT NULL DEFAULT 0,
  "output" TEXT NOT NULL DEFAULT '',
  "usage_jsonb" JSONB,
  "error" TEXT,
  "detached" BOOLEAN NOT NULL DEFAULT false,
  "stop_requested_at" TIMESTAMPTZ(6),
  "broker_calls" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  CONSTRAINT "meri_agent_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meri_agent_runs_hermes_run_id_key" UNIQUE ("hermes_run_id"),
  CONSTRAINT "meri_agent_runs_scope_idempotency_key" UNIQUE ("scope_id", "idempotency_key"),
  CONSTRAINT "meri_agent_runs_status_check" CHECK ("status" IN (
    'queued','provisioning','running','waiting_for_approval','waiting_for_clarification',
    'cancelling','completed','cancelled','failed','interrupted','expired'
  )),
  CONSTRAINT "meri_agent_runs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "meri_agent_runs_scope_fkey" FOREIGN KEY ("scope_id") REFERENCES "meri_execution_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "meri_agent_runs_conversation_fkey" FOREIGN KEY ("conversation_id") REFERENCES "clio_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "meri_agent_runs_tenant_actor_conversation_idx"
  ON "meri_agent_runs"("tenant_id", "actor_id", "conversation_id", "created_at");
CREATE INDEX "meri_agent_runs_scope_status_idx"
  ON "meri_agent_runs"("scope_id", "status");

CREATE TABLE "meri_agent_run_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "kind" VARCHAR(40) NOT NULL,
  "visibility" VARCHAR(20) NOT NULL DEFAULT 'public',
  "payload_jsonb" JSONB NOT NULL,
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meri_agent_run_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meri_agent_run_events_run_seq_key" UNIQUE ("run_id", "seq"),
  CONSTRAINT "meri_agent_run_events_run_fkey" FOREIGN KEY ("run_id") REFERENCES "meri_agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "meri_agent_run_events_run_seq_idx" ON "meri_agent_run_events"("run_id", "seq");

CREATE TABLE "meri_agent_interactions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "request_id" VARCHAR(120) NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "continuation" VARCHAR(24) NOT NULL,
  "prompt" TEXT NOT NULL,
  "choices_jsonb" JSONB NOT NULL DEFAULT '[]',
  "multi_select" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6),
  "resolution_jsonb" JSONB,
  CONSTRAINT "meri_agent_interactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meri_agent_interactions_run_request_key" UNIQUE ("run_id", "request_id"),
  CONSTRAINT "meri_agent_interactions_kind_check" CHECK ("kind" IN ('approval','clarification')),
  CONSTRAINT "meri_agent_interactions_continuation_check" CHECK ("continuation" IN ('live_process','durable_continuation')),
  CONSTRAINT "meri_agent_interactions_run_fkey" FOREIGN KEY ("run_id") REFERENCES "meri_agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RLS: canonical isolation policy shape (see 20260501000000_init_identity_tenancy).
-- meri_execution_scopes / meri_agent_runs carry tenant_id directly. The two child
-- tables (events, interactions) deliberately do not duplicate tenant_id (contracts.md
-- §7); they inherit tenant scope through a verified relationship to meri_agent_runs,
-- per the audit's "a child table without tenantId inherits scope through a verified
-- relationship" rule -- enforced here as an EXISTS join, not app-level trust.

ALTER TABLE "meri_execution_scopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_execution_scopes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_execution_scopes_isolation" ON "meri_execution_scopes"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "meri_agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_agent_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_agent_runs_isolation" ON "meri_agent_runs"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE "meri_agent_run_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_agent_run_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_agent_run_events_isolation" ON "meri_agent_run_events"
  USING (rls_bypass() OR EXISTS (
    SELECT 1 FROM "meri_agent_runs" r
    WHERE r."id" = "meri_agent_run_events"."run_id" AND r."tenant_id" = current_tenant_id()
  ))
  WITH CHECK (rls_bypass() OR EXISTS (
    SELECT 1 FROM "meri_agent_runs" r
    WHERE r."id" = "meri_agent_run_events"."run_id" AND r."tenant_id" = current_tenant_id()
  ));

ALTER TABLE "meri_agent_interactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_agent_interactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_agent_interactions_isolation" ON "meri_agent_interactions"
  USING (rls_bypass() OR EXISTS (
    SELECT 1 FROM "meri_agent_runs" r
    WHERE r."id" = "meri_agent_interactions"."run_id" AND r."tenant_id" = current_tenant_id()
  ))
  WITH CHECK (rls_bypass() OR EXISTS (
    SELECT 1 FROM "meri_agent_runs" r
    WHERE r."id" = "meri_agent_interactions"."run_id" AND r."tenant_id" = current_tenant_id()
  ));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_execution_scopes" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_agent_runs" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_agent_run_events" TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "meri_agent_interactions" TO capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "meri_agent_runs" IS
  'Durable Hermes (or future runtime) agent run record. envelope_jsonb/actor_context_jsonb never contain broker credentials.';
COMMENT ON COLUMN "meri_execution_scopes"."id" IS
  'Natural composed key (tenant:<tenantId>:user:<userId> for Phase 1 private scopes), not a random uuid.';
