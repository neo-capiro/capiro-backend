-- Research Portfolios Phase 7: review decisions, annual continuity, and
-- recoverable imports. All records are tenant-scoped; history records are
-- append-only and operational rows retain explicit unknown outcomes.

ALTER TYPE "research_portfolio_event_kind" ADD VALUE IF NOT EXISTS 'review_updated';
ALTER TYPE "research_portfolio_event_kind" ADD VALUE IF NOT EXISTS 'annual_reopened';
ALTER TYPE "research_portfolio_event_kind" ADD VALUE IF NOT EXISTS 'import_created';
ALTER TYPE "research_portfolio_event_kind" ADD VALUE IF NOT EXISTS 'import_action';

CREATE TYPE "research_portfolio_review_status" AS ENUM ('open','assigned','deferred','resolved','cancelled');
CREATE TYPE "research_portfolio_review_trigger" AS ENUM ('rule_change','annual_continuity','import','dispute','manual');
CREATE TYPE "research_portfolio_review_target_kind" AS ENUM ('program','program_element','project','budget_line','award','rule','portfolio');
CREATE TYPE "research_portfolio_decision_type" AS ENUM ('include','exclude','defer','reopen','dispute');
CREATE TYPE "research_portfolio_continuity_status" AS ENUM ('unchanged','changed','expired','renamed','renumbered','split','merged','unresolved','new');
CREATE TYPE "research_portfolio_import_job_status" AS ENUM ('created','mapped','previewed','applying','paused','completed','partial','failed','cancelled','unknown','needs_reconciliation','compensated');
CREATE TYPE "research_portfolio_import_worksheet_kind" AS ENUM ('membership','rules','reviews');
CREATE TYPE "research_portfolio_import_row_outcome" AS ENUM ('applied','skipped','conflict','failed','unknown');
CREATE TYPE "research_portfolio_import_row_preview_classification" AS ENUM ('resolved','duplicate','invalid','ambiguous','unresolved','inaccessible');

CREATE TABLE "research_portfolio_reviews" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "target_kind" "research_portfolio_review_target_kind" NOT NULL,
  "target_id" VARCHAR(256) NOT NULL,
  "trigger" "research_portfolio_review_trigger" NOT NULL,
  "trigger_identity" VARCHAR(256) NOT NULL,
  "dependency_identity" VARCHAR(256),
  "assignee_user_id" UUID,
  "reason" TEXT NOT NULL,
  "evidence_for" JSONB NOT NULL DEFAULT '[]',
  "evidence_against" JSONB NOT NULL DEFAULT '[]',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "trigger_fingerprint" CHAR(64) NOT NULL,
  "status" "research_portfolio_review_status" NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "research_portfolio_reviews_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "research_portfolio_reviews_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "research_portfolio_reviews_resolution_check" CHECK ("status" <> 'resolved' OR "resolved_at" IS NOT NULL),
  CONSTRAINT "research_portfolio_reviews_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_reviews_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_reviews_tenant_id_key" ON "research_portfolio_reviews"("tenant_id","id");
CREATE UNIQUE INDEX "research_portfolio_reviews_trigger_fingerprint_key" ON "research_portfolio_reviews"("tenant_id","portfolio_id","trigger_fingerprint");
CREATE INDEX "research_portfolio_reviews_status_idx" ON "research_portfolio_reviews"("tenant_id","portfolio_id","status","updated_at" DESC);
CREATE INDEX "research_portfolio_reviews_target_idx" ON "research_portfolio_reviews"("tenant_id","portfolio_id","target_kind","target_id");

CREATE TABLE "research_portfolio_decisions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "target_kind" "research_portfolio_review_target_kind" NOT NULL,
  "target_id" VARCHAR(256) NOT NULL,
  "decision_type" "research_portfolio_decision_type" NOT NULL,
  "reason" TEXT NOT NULL,
  "author_user_id" UUID NOT NULL,
  "decision_time" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "prior_decision_id" UUID,
  "supersedes_id" UUID,
  "evidence_for" JSONB NOT NULL DEFAULT '[]',
  "evidence_against" JSONB NOT NULL DEFAULT '[]',
  "review_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_decisions_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "research_portfolio_decisions_self_check" CHECK ("prior_decision_id" IS DISTINCT FROM "id" AND "supersedes_id" IS DISTINCT FROM "id"),
  CONSTRAINT "research_portfolio_decisions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_decisions_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_decisions_review_fkey" FOREIGN KEY ("tenant_id","review_id") REFERENCES "research_portfolio_reviews"("tenant_id","id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "research_portfolio_decisions_tenant_id_key" ON "research_portfolio_decisions"("tenant_id","id");
ALTER TABLE "research_portfolio_decisions"
  ADD CONSTRAINT "research_portfolio_decisions_prior_fkey" FOREIGN KEY ("tenant_id","prior_decision_id") REFERENCES "research_portfolio_decisions"("tenant_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "research_portfolio_decisions_supersedes_fkey" FOREIGN KEY ("tenant_id","supersedes_id") REFERENCES "research_portfolio_decisions"("tenant_id","id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "research_portfolio_decisions_target_time_key" ON "research_portfolio_decisions"("tenant_id","portfolio_id","target_kind","target_id","decision_time","id");
CREATE INDEX "research_portfolio_decisions_timeline_idx" ON "research_portfolio_decisions"("tenant_id","portfolio_id","decision_time" DESC);
CREATE INDEX "research_portfolio_decisions_review_idx" ON "research_portfolio_decisions"("tenant_id","portfolio_id","review_id");

CREATE TABLE "research_portfolio_continuity_ledger" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "prior_decision_id" UUID,
  "current_decision_id" UUID,
  "continuity_key" CHAR(64) NOT NULL,
  "prior_dependency_fingerprint" CHAR(64),
  "dependency_fingerprint" CHAR(64) NOT NULL,
  "status" "research_portfolio_continuity_status" NOT NULL,
  "identity_mapping" JSONB NOT NULL DEFAULT '{}',
  "changed_dependencies" JSONB NOT NULL DEFAULT '{}',
  "original_evidence" JSONB NOT NULL DEFAULT '{}',
  "source_edition" VARCHAR(128),
  "relevant_period_start" DATE,
  "relevant_period_end" DATE,
  "expiry_date" DATE,
  "reopening_reason" TEXT,
  "reopening_review_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_continuity_period_check" CHECK ("relevant_period_end" IS NULL OR "relevant_period_start" IS NULL OR "relevant_period_end" >= "relevant_period_start"),
  CONSTRAINT "research_portfolio_continuity_changed_check" CHECK ("status" IN ('unchanged','new') OR jsonb_typeof("changed_dependencies") = 'object'),
  CONSTRAINT "research_portfolio_continuity_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_continuity_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_continuity_prior_decision_fkey" FOREIGN KEY ("tenant_id","prior_decision_id") REFERENCES "research_portfolio_decisions"("tenant_id","id") ON DELETE SET NULL,
  CONSTRAINT "research_portfolio_continuity_current_decision_fkey" FOREIGN KEY ("tenant_id","current_decision_id") REFERENCES "research_portfolio_decisions"("tenant_id","id") ON DELETE SET NULL,
  CONSTRAINT "research_portfolio_continuity_review_fkey" FOREIGN KEY ("tenant_id","reopening_review_id") REFERENCES "research_portfolio_reviews"("tenant_id","id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "research_portfolio_continuity_ledger_key" ON "research_portfolio_continuity_ledger"("tenant_id","portfolio_id","continuity_key");
CREATE INDEX "research_portfolio_continuity_ledger_status_idx" ON "research_portfolio_continuity_ledger"("tenant_id","portfolio_id","status","updated_at" DESC);

CREATE TABLE "research_portfolio_import_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "worksheet_kind" "research_portfolio_import_worksheet_kind" NOT NULL,
  "status" "research_portfolio_import_job_status" NOT NULL DEFAULT 'created',
  "original_hash" CHAR(64) NOT NULL,
  "original_size" INTEGER NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "media_type" VARCHAR(128) NOT NULL,
  "original_storage_key" VARCHAR(512),
  "original_bytes" BYTEA NOT NULL,
  "file_metadata" JSONB NOT NULL DEFAULT '{}',
  "parser_version" VARCHAR(32) NOT NULL,
  "schema_version" VARCHAR(32) NOT NULL,
  "target_revision" INTEGER NOT NULL,
  "checkpoint" JSONB,
  "lease_owner" VARCHAR(128),
  "lease_until" TIMESTAMPTZ(6),
  "row_count" INTEGER NOT NULL DEFAULT 0,
  "applied_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_import_jobs_counts_check" CHECK ("original_size" >= 0 AND "target_revision" > 0 AND "row_count" >= 0 AND "applied_count" >= 0 AND "applied_count" <= "row_count"),
  CONSTRAINT "research_portfolio_import_jobs_media_check" CHECK ("media_type" IN ('text/csv','application/vnd.ms-excel')),
  CONSTRAINT "research_portfolio_import_jobs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_import_jobs_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_import_jobs_tenant_id_key" ON "research_portfolio_import_jobs"("tenant_id","id");
CREATE UNIQUE INDEX "research_portfolio_import_jobs_operation_key" ON "research_portfolio_import_jobs"("tenant_id","operation_key");
CREATE INDEX "research_portfolio_import_jobs_status_idx" ON "research_portfolio_import_jobs"("tenant_id","portfolio_id","status","created_at" DESC);

CREATE TABLE "research_portfolio_import_rows" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "import_job_id" UUID NOT NULL,
  "worksheet_kind" "research_portfolio_import_worksheet_kind" NOT NULL,
  "sheet_name" VARCHAR(128),
  "row_number" INTEGER NOT NULL,
  "row_identity" VARCHAR(256) NOT NULL,
  "raw_cells" JSONB NOT NULL DEFAULT '{}',
  "parsed_data" JSONB NOT NULL DEFAULT '{}',
  "repairs" JSONB NOT NULL DEFAULT '{}',
  "validation_issues" JSONB NOT NULL DEFAULT '[]',
  "selected" BOOLEAN NOT NULL DEFAULT TRUE,
  "preview_classification" "research_portfolio_import_row_preview_classification",
  "preview_reason" TEXT,
  "final_outcome" "research_portfolio_import_row_outcome",
  "final_reason" TEXT,
  "final_disposition" JSONB NOT NULL DEFAULT '{}',
  "expected_revision" INTEGER,
  "canonical_target_key" VARCHAR(320),
  "target_kind" VARCHAR(64),
  "target_id" VARCHAR(256),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_import_rows_number_check" CHECK ("row_number" > 0),
  CONSTRAINT "research_portfolio_import_rows_target_check" CHECK (("target_kind" IS NULL) = ("target_id" IS NULL)),
  CONSTRAINT "research_portfolio_import_rows_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_import_rows_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_import_rows_job_fkey" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_import_rows_tenant_id_key" ON "research_portfolio_import_rows"("tenant_id","id");
CREATE UNIQUE INDEX "research_portfolio_import_rows_row_identity_key" ON "research_portfolio_import_rows"("tenant_id","import_job_id","row_identity");
CREATE INDEX "research_portfolio_import_rows_outcome_idx" ON "research_portfolio_import_rows"("tenant_id","portfolio_id","import_job_id","final_outcome");

CREATE TABLE "research_portfolio_import_mapping_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "import_job_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "mapping" JSONB NOT NULL,
  "schema_version" VARCHAR(32) NOT NULL,
  "author_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_import_mappings_version_check" CHECK ("version" > 0),
  CONSTRAINT "rp_import_mappings_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "rp_import_mappings_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "rp_import_mappings_job_fkey" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_import_mappings_version_key" ON "research_portfolio_import_mapping_versions"("tenant_id","import_job_id","version");

CREATE TABLE "research_portfolio_import_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "import_job_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "checkpoint" JSONB NOT NULL DEFAULT '{}',
  "error_code" VARCHAR(128),
  "receipt" JSONB NOT NULL DEFAULT '{}',
  "actor_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_import_attempts_action_check" CHECK ("action" IN ('preview','apply','pause','resume','cancel','retry','reconcile','compensate')),
  CONSTRAINT "research_portfolio_import_attempts_outcome_check" CHECK ("outcome" IN ('succeeded','known_failure','unknown')),
  CONSTRAINT "research_portfolio_import_attempts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_import_attempts_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_import_attempts_job_fkey" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_import_attempts_operation_key" ON "research_portfolio_import_attempts"("tenant_id","operation_key");
CREATE INDEX "research_portfolio_import_attempts_job_idx" ON "research_portfolio_import_attempts"("tenant_id","import_job_id","created_at");

CREATE TABLE "research_portfolio_import_effects" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "import_job_id" UUID NOT NULL,
  "import_row_id" UUID NOT NULL,
  "effect_fingerprint" CHAR(64) NOT NULL,
  "effect_kind" VARCHAR(48) NOT NULL,
  "canonical_target_key" VARCHAR(320) NOT NULL,
  "target_id" VARCHAR(256) NOT NULL,
  "target_revision_at_apply" INTEGER,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_import_effects_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_import_effects_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_import_effects_job_fkey" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_import_effects_row_fkey" FOREIGN KEY ("tenant_id","import_row_id") REFERENCES "research_portfolio_import_rows"("tenant_id","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "research_portfolio_import_effects_fingerprint_key" ON "research_portfolio_import_effects"("tenant_id","import_job_id","effect_fingerprint");
CREATE UNIQUE INDEX "research_portfolio_import_effects_target_key" ON "research_portfolio_import_effects"("tenant_id","import_job_id","canonical_target_key","effect_kind");
CREATE INDEX "research_portfolio_import_effects_row_idx" ON "research_portfolio_import_effects"("tenant_id","import_row_id");

CREATE TABLE "research_portfolio_import_compensation_receipts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "import_job_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "preview_hash" CHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "effects" JSONB NOT NULL DEFAULT '[]',
  "actor_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_import_receipts_status_check" CHECK ("status" IN ('previewed','committed','failed')),
  CONSTRAINT "rp_import_receipts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "rp_import_receipts_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "rp_import_receipts_job_fkey" FOREIGN KEY ("tenant_id","import_job_id") REFERENCES "research_portfolio_import_jobs"("tenant_id","id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "research_portfolio_import_receipts_operation_key" ON "research_portfolio_import_compensation_receipts"("tenant_id","operation_key");
CREATE INDEX "research_portfolio_import_receipts_job_idx" ON "research_portfolio_import_compensation_receipts"("tenant_id","import_job_id","created_at");

CREATE OR REPLACE FUNCTION research_portfolio_phase7_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "research_portfolio_decisions_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_decisions" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase7_append_only();
CREATE TRIGGER "research_portfolio_import_mappings_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_import_mapping_versions" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase7_append_only();
CREATE TRIGGER "research_portfolio_import_attempts_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_import_attempts" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase7_append_only();
CREATE TRIGGER "research_portfolio_import_effects_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_import_effects" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase7_append_only();
CREATE TRIGGER "research_portfolio_import_receipts_append_only_trigger" BEFORE UPDATE OR DELETE ON "research_portfolio_import_compensation_receipts" FOR EACH ROW EXECUTE FUNCTION research_portfolio_phase7_append_only();

CREATE TRIGGER "research_portfolio_reviews_set_updated_at" BEFORE UPDATE ON "research_portfolio_reviews" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "research_portfolio_continuity_set_updated_at" BEFORE UPDATE ON "research_portfolio_continuity_ledger" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "research_portfolio_import_jobs_set_updated_at" BEFORE UPDATE ON "research_portfolio_import_jobs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER "research_portfolio_import_rows_set_updated_at" BEFORE UPDATE ON "research_portfolio_import_rows" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'research_portfolio_reviews','research_portfolio_decisions','research_portfolio_continuity_ledger',
    'research_portfolio_import_jobs','research_portfolio_import_rows','research_portfolio_import_mapping_versions',
    'research_portfolio_import_attempts','research_portfolio_import_effects','research_portfolio_import_compensation_receipts'
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON "research_portfolio_reviews", "research_portfolio_continuity_ledger", "research_portfolio_import_jobs", "research_portfolio_import_rows" TO capiro_app;
    GRANT SELECT, INSERT ON "research_portfolio_decisions", "research_portfolio_import_mapping_versions", "research_portfolio_import_attempts", "research_portfolio_import_effects", "research_portfolio_import_compensation_receipts" TO capiro_app;
  END IF;
END
$$;
