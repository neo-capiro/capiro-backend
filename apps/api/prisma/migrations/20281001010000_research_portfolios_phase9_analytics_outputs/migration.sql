-- Research Portfolios Phase 9: personal event state, explicit subscriptions,
-- immutable snapshots, and durable output records.

CREATE TYPE "research_portfolio_output_status" AS ENUM (
  'queued','running','completed','partial','failed','cancelled','outcome_unknown'
);

CREATE UNIQUE INDEX "research_portfolio_events_tenant_id_key"
  ON "research_portfolio_events"("tenant_id","id");

CREATE TABLE "research_portfolio_event_recipient_states" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "seen_at" TIMESTAMPTZ(6),
  "acknowledged_at" TIMESTAMPTZ(6),
  "dismissed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_event_states_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "research_portfolio_event_states_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_event_states_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_event_states_event_fkey" FOREIGN KEY ("tenant_id","event_id") REFERENCES "research_portfolio_events"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_event_states_event_user_key" ON "research_portfolio_event_recipient_states"("tenant_id","event_id","recipient_user_id");
CREATE INDEX "research_portfolio_event_states_recipient_idx" ON "research_portfolio_event_recipient_states"("tenant_id","portfolio_id","recipient_user_id","updated_at" DESC);

CREATE TABLE "research_portfolio_subscriptions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "subscriber_user_id" UUID NOT NULL,
  "target_kind" VARCHAR(48) NOT NULL,
  "target_id" VARCHAR(256) NOT NULL,
  "channel" VARCHAR(32) NOT NULL,
  "cadence" VARCHAR(32) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "baseline_event_id" UUID,
  "baseline_revision" INTEGER NOT NULL,
  "baseline_completed_at" TIMESTAMPTZ(6) NOT NULL,
  "checkpoint" JSONB NOT NULL DEFAULT '{}',
  "lease_owner" VARCHAR(128),
  "lease_until" TIMESTAMPTZ(6),
  "lease_fence" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_subscriptions_baseline_check" CHECK ("baseline_revision" > 0 AND "lease_fence" >= 0),
  CONSTRAINT "research_portfolio_subscriptions_channel_check" CHECK ("channel" IN ('in_app','email')),
  CONSTRAINT "research_portfolio_subscriptions_cadence_check" CHECK ("cadence" IN ('immediate','daily','weekly')),
  CONSTRAINT "research_portfolio_subscriptions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_subscriptions_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_subscriptions_identity_key" ON "research_portfolio_subscriptions"("tenant_id","portfolio_id","subscriber_user_id","target_kind","target_id","channel","cadence");
CREATE INDEX "research_portfolio_subscriptions_recipient_idx" ON "research_portfolio_subscriptions"("tenant_id","subscriber_user_id","active","updated_at" DESC);
CREATE INDEX "research_portfolio_subscriptions_claim_idx" ON "research_portfolio_subscriptions"("tenant_id","active","lease_until");

CREATE TABLE "research_portfolio_snapshots" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "portfolio_revision" INTEGER NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "basis" JSONB NOT NULL,
  "membership" JSONB NOT NULL,
  "projection" JSONB NOT NULL,
  "structure_versions" JSONB NOT NULL DEFAULT '{}',
  "rule_versions" JSONB NOT NULL DEFAULT '[]',
  "decision_versions" JSONB NOT NULL DEFAULT '[]',
  "template_versions" JSONB NOT NULL DEFAULT '[]',
  "taxonomy_versions" JSONB NOT NULL DEFAULT '[]',
  "label_versions" JSONB NOT NULL DEFAULT '[]',
  "source_versions" JSONB NOT NULL DEFAULT '[]',
  "calculation_version" VARCHAR(64) NOT NULL,
  "limitations" JSONB NOT NULL DEFAULT '[]',
  "client_access_requirements" JSONB NOT NULL DEFAULT '[]',
  "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "read_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "research_portfolio_snapshots_revision_check" CHECK ("portfolio_revision" > 0),
  CONSTRAINT "research_portfolio_snapshots_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_snapshots_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_snapshots_tenant_id_key" ON "research_portfolio_snapshots"("tenant_id","id");
CREATE UNIQUE INDEX "research_portfolio_snapshots_operation_key" ON "research_portfolio_snapshots"("tenant_id","operation_key");
CREATE INDEX "research_portfolio_snapshots_timeline_idx" ON "research_portfolio_snapshots"("tenant_id","portfolio_id","captured_at" DESC);

CREATE TABLE "research_portfolio_output_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "snapshot_id" UUID,
  "operation_key" VARCHAR(128) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "context" JSONB NOT NULL DEFAULT '{}',
  "selected_sections" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "include_source_appendix" BOOLEAN NOT NULL DEFAULT FALSE,
  "format" VARCHAR(16) NOT NULL DEFAULT 'csv',
  "status" "research_portfolio_output_status" NOT NULL DEFAULT 'queued',
  "requested_by_user_id" UUID NOT NULL,
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadline_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_output_requests_format_check" CHECK ("format" = 'csv'),
  CONSTRAINT "research_portfolio_output_requests_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_requests_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_requests_snapshot_fkey" FOREIGN KEY ("tenant_id","snapshot_id") REFERENCES "research_portfolio_snapshots"("tenant_id","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "research_portfolio_output_requests_tenant_id_key" ON "research_portfolio_output_requests"("tenant_id","id");
CREATE UNIQUE INDEX "research_portfolio_output_requests_operation_key" ON "research_portfolio_output_requests"("tenant_id","operation_key");
CREATE INDEX "research_portfolio_output_requests_status_idx" ON "research_portfolio_output_requests"("tenant_id","portfolio_id","status","requested_at" DESC);

CREATE TABLE "research_portfolio_output_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "status" "research_portfolio_output_status" NOT NULL DEFAULT 'queued',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "deadline_at" TIMESTAMPTZ(6),
  "lease_owner" VARCHAR(128),
  "lease_until" TIMESTAMPTZ(6),
  "lease_fence" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" VARCHAR(128),
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_output_jobs_counts_check" CHECK ("attempt_count" >= 0 AND "lease_fence" >= 0),
  CONSTRAINT "research_portfolio_output_jobs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_jobs_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_jobs_request_fkey" FOREIGN KEY ("tenant_id","request_id") REFERENCES "research_portfolio_output_requests"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_output_jobs_tenant_id_key" ON "research_portfolio_output_jobs"("tenant_id","id");
CREATE UNIQUE INDEX "research_portfolio_output_jobs_operation_key" ON "research_portfolio_output_jobs"("tenant_id","operation_key");
CREATE INDEX "research_portfolio_output_jobs_claim_idx" ON "research_portfolio_output_jobs"("tenant_id","status","lease_until");

CREATE TABLE "research_portfolio_output_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "outcome" "research_portfolio_output_status" NOT NULL,
  "checkpoint" JSONB NOT NULL DEFAULT '{}',
  "receipt" JSONB NOT NULL DEFAULT '{}',
  "error_code" VARCHAR(128),
  "actor_user_id" UUID NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_output_attempts_number_check" CHECK ("attempt_number" > 0),
  CONSTRAINT "research_portfolio_output_attempts_action_check" CHECK ("action" IN ('process','cancel','retry','reconcile')),
  CONSTRAINT "research_portfolio_output_attempts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_attempts_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_attempts_job_fkey" FOREIGN KEY ("tenant_id","job_id") REFERENCES "research_portfolio_output_jobs"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_output_attempts_number_key" ON "research_portfolio_output_attempts"("tenant_id","job_id","attempt_number");
CREATE UNIQUE INDEX "research_portfolio_output_attempts_operation_key" ON "research_portfolio_output_attempts"("tenant_id","operation_key");
CREATE INDEX "research_portfolio_output_attempts_job_idx" ON "research_portfolio_output_attempts"("tenant_id","job_id","created_at");

CREATE TABLE "research_portfolio_output_artifacts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "media_type" VARCHAR(128) NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "bytes" BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_output_artifacts_size_check" CHECK ("byte_size" >= 0),
  CONSTRAINT "research_portfolio_output_artifacts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_artifacts_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_artifacts_job_fkey" FOREIGN KEY ("tenant_id","job_id") REFERENCES "research_portfolio_output_jobs"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_output_artifacts_tenant_id_key" ON "research_portfolio_output_artifacts"("tenant_id","id");
CREATE UNIQUE INDEX "research_portfolio_output_artifacts_job_key" ON "research_portfolio_output_artifacts"("tenant_id","job_id");
CREATE INDEX "research_portfolio_output_artifacts_hash_idx" ON "research_portfolio_output_artifacts"("tenant_id","content_hash");

CREATE TABLE "research_portfolio_output_client_file_receipts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "attachment_id" UUID NOT NULL,
  "attachment_name" VARCHAR(255) NOT NULL,
  "lifecycle_status" VARCHAR(32),
  "scan_status" VARCHAR(32),
  "indexed_at" TIMESTAMPTZ(6),
  "open_path" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_output_receipts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_receipts_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_output_receipts_artifact_fkey" FOREIGN KEY ("tenant_id","artifact_id") REFERENCES "research_portfolio_output_artifacts"("tenant_id","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "research_portfolio_output_receipts_operation_key" ON "research_portfolio_output_client_file_receipts"("tenant_id","operation_key");
CREATE UNIQUE INDEX "research_portfolio_output_receipts_attachment_key" ON "research_portfolio_output_client_file_receipts"("tenant_id","attachment_id");
CREATE INDEX "research_portfolio_output_receipts_artifact_idx" ON "research_portfolio_output_client_file_receipts"("tenant_id","artifact_id","created_at" DESC);

CREATE OR REPLACE FUNCTION research_portfolio_phase9_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "research_portfolio_snapshots_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_snapshots" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase9_append_only();
CREATE TRIGGER "research_portfolio_output_attempts_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_output_attempts" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase9_append_only();
CREATE TRIGGER "research_portfolio_output_artifacts_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_output_artifacts" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase9_append_only();
CREATE TRIGGER "research_portfolio_output_receipts_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_output_client_file_receipts" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase9_append_only();

CREATE TRIGGER "research_portfolio_event_states_set_updated_at" BEFORE UPDATE ON "research_portfolio_event_recipient_states" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "research_portfolio_subscriptions_set_updated_at" BEFORE UPDATE ON "research_portfolio_subscriptions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "research_portfolio_output_requests_set_updated_at" BEFORE UPDATE ON "research_portfolio_output_requests" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "research_portfolio_output_jobs_set_updated_at" BEFORE UPDATE ON "research_portfolio_output_jobs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'research_portfolio_event_recipient_states','research_portfolio_subscriptions','research_portfolio_snapshots',
    'research_portfolio_output_requests','research_portfolio_output_jobs','research_portfolio_output_attempts',
    'research_portfolio_output_artifacts','research_portfolio_output_client_file_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())', table_name || '_isolation', table_name);
  END LOOP;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "research_portfolio_event_recipient_states", "research_portfolio_subscriptions", "research_portfolio_output_requests", "research_portfolio_output_jobs" TO capiro_app;
    GRANT SELECT, INSERT ON "research_portfolio_snapshots", "research_portfolio_output_attempts", "research_portfolio_output_artifacts", "research_portfolio_output_client_file_receipts" TO capiro_app;
  END IF;
END
$$;
