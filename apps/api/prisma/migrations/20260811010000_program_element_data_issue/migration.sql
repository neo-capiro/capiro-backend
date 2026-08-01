-- Phase I / closeout Phase 6: tenant-scoped PE data-issue workflow with fail-closed RLS.
-- Resolution of issues NEVER mutates ProgramElement / ProgramElementYear canonical rows.

CREATE TABLE IF NOT EXISTS "program_element_data_issue" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "reported_by_user_id" UUID NOT NULL,
  "pe_code" VARCHAR(16) NOT NULL,
  "fy" INTEGER,
  "field_name" TEXT,
  "issue_type" VARCHAR(40) NOT NULL,
  "description" TEXT NOT NULL,
  "suggested_source_url" TEXT,
  "status" VARCHAR(20) NOT NULL DEFAULT 'open',
  "resolution_notes" TEXT,
  "resolved_by_user_id" UUID,
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "program_element_data_issue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "program_element_data_issue_tenant_status_created_idx"
  ON "program_element_data_issue" ("tenant_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "program_element_data_issue_pe_fy_idx"
  ON "program_element_data_issue" ("pe_code", "fy");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'program_element_data_issue_tenant_fkey'
  ) THEN
    ALTER TABLE "program_element_data_issue"
      ADD CONSTRAINT "program_element_data_issue_tenant_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'program_element_data_issue_reporter_fkey'
  ) THEN
    ALTER TABLE "program_element_data_issue"
      ADD CONSTRAINT "program_element_data_issue_reporter_fkey"
      FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'program_element_data_issue_resolver_fkey'
  ) THEN
    ALTER TABLE "program_element_data_issue"
      ADD CONSTRAINT "program_element_data_issue_resolver_fkey"
      FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'program_element_data_issue_pe_fkey'
  ) THEN
    ALTER TABLE "program_element_data_issue"
      ADD CONSTRAINT "program_element_data_issue_pe_fkey"
      FOREIGN KEY ("pe_code") REFERENCES "program_element"("pe_code") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'program_element_data_issue'
  ) THEN
    RAISE EXCEPTION
      'program_element_data_issue already has an RLS policy; review it before applying the canonical isolation policy';
  END IF;
END
$$;

ALTER TABLE "program_element_data_issue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "program_element_data_issue" FORCE ROW LEVEL SECURITY;

CREATE POLICY "program_element_data_issue_isolation" ON "program_element_data_issue"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
