-- Candidate only. Root/Hermes integrates and executes on the owned database.
-- No changes to existing output-generation leases or append-only receipts.
CREATE TYPE "research_portfolio_client_filing_status" AS ENUM ('pending','outcome_unknown','completed');
CREATE UNIQUE INDEX "research_portfolio_output_receipts_tenant_id_key" ON "research_portfolio_output_client_file_receipts"("tenant_id","id");
CREATE TABLE "research_portfolio_client_filing_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "receipt_operation_key" VARCHAR(128) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "status" "research_portfolio_client_filing_status" NOT NULL DEFAULT 'pending',
  "writer_fence" INTEGER NOT NULL DEFAULT 1,
  "writer_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "external_checkpoint" JSONB NOT NULL DEFAULT '{}',
  "receipt_id" UUID,
  "last_error_code" VARCHAR(128),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_client_filing_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolio_client_filing_jobs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_client_filing_jobs_portfolio_fkey" FOREIGN KEY ("tenant_id","portfolio_id") REFERENCES "research_portfolios"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "research_portfolio_client_filing_jobs_artifact_fkey" FOREIGN KEY ("tenant_id","artifact_id") REFERENCES "research_portfolio_output_artifacts"("tenant_id","id") ON DELETE RESTRICT,
  CONSTRAINT "research_portfolio_client_filing_jobs_client_fkey" FOREIGN KEY ("tenant_id","client_id") REFERENCES "clients"("tenant_id","id") ON DELETE RESTRICT,
  CONSTRAINT "research_portfolio_client_filing_jobs_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "research_portfolio_client_filing_jobs_receipt_fkey" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "research_portfolio_output_client_file_receipts"("tenant_id","id") ON DELETE RESTRICT,
  CONSTRAINT "research_portfolio_client_filing_jobs_fence_check" CHECK ("writer_fence" > 0),
  CONSTRAINT "research_portfolio_client_filing_jobs_checkpoint_object_check" CHECK (jsonb_typeof("external_checkpoint") = 'object'),
  CONSTRAINT "research_portfolio_client_filing_jobs_completed_check" CHECK ("status" <> 'completed' OR ("receipt_id" IS NOT NULL AND "completed_at" IS NOT NULL AND "external_checkpoint" ? 'attachmentId'))
);
CREATE UNIQUE INDEX "research_portfolio_client_filing_jobs_tenant_id_key" ON "research_portfolio_client_filing_jobs"("tenant_id","id");
CREATE UNIQUE INDEX "research_portfolio_client_filing_jobs_actor_operation_key" ON "research_portfolio_client_filing_jobs"("tenant_id","actor_user_id","operation_key");
CREATE UNIQUE INDEX "research_portfolio_client_filing_jobs_receipt_operation_key" ON "research_portfolio_client_filing_jobs"("tenant_id","receipt_operation_key");
CREATE INDEX "research_portfolio_client_filing_jobs_status_idx" ON "research_portfolio_client_filing_jobs"("tenant_id","portfolio_id","status","created_at");
CREATE TRIGGER "research_portfolio_client_filing_jobs_set_updated_at" BEFORE UPDATE ON "research_portfolio_client_filing_jobs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE "research_portfolio_client_filing_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "research_portfolio_client_filing_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "research_portfolio_client_filing_jobs_isolation" ON "research_portfolio_client_filing_jobs" USING (rls_bypass() OR (tenant_id = current_tenant_id() AND actor_user_id = current_user_id())) WITH CHECK (rls_bypass() OR (tenant_id = current_tenant_id() AND actor_user_id = current_user_id()));
REVOKE ALL ON "research_portfolio_client_filing_jobs" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL ON "research_portfolio_client_filing_jobs" FROM capiro_app;
    GRANT SELECT, INSERT, UPDATE ON "research_portfolio_client_filing_jobs" TO capiro_app;
  END IF;
END $$;

-- Explicit least privilege even when database defaults grant mutation rights.
REVOKE ALL ON research_portfolio_fit_versions FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
  REVOKE ALL ON research_portfolio_fit_versions FROM capiro_app;
  GRANT SELECT, INSERT ON research_portfolio_fit_versions TO capiro_app;
 END IF;
END $$;
