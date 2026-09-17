-- Durable Funding Opportunities v2 saved searches.
CREATE TABLE "saved_opportunity_searches" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "client_id" UUID,
  "is_tenant_wide" BOOLEAN NOT NULL DEFAULT false,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "opportunity_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "query" TEXT NOT NULL,
  "criteria_json" JSONB NOT NULL,
  "sort" TEXT NOT NULL,
  "page_size" INTEGER NOT NULL,
  "match_mode" TEXT NOT NULL,
  "owner_id" UUID NOT NULL,
  "visibility" TEXT NOT NULL,
  "alerts_enabled" BOOLEAN NOT NULL DEFAULT false,
  "alert_cadence" TEXT,
  "alert_channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "alert_deadline_threshold" INTEGER,
  "alert_new_vs_changed" BOOLEAN NOT NULL DEFAULT false,
  "last_evaluated_at" TIMESTAMPTZ(6),
  "last_notified_at" TIMESTAMPTZ(6),
  "last_applied_at" TIMESTAMPTZ(6),
  "last_run_result_count" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "schema_version" INTEGER NOT NULL DEFAULT 2,
  "archived_at" TIMESTAMPTZ(6),
  "original_criteria_json" JSONB,
  "migration_warnings" JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT "saved_opportunity_searches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "saved_opportunity_searches_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "saved_opportunity_searches_client_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT,
  CONSTRAINT "saved_opportunity_searches_owner_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "saved_opportunity_searches_visibility_check"
    CHECK ("visibility" IN ('private', 'tenant')),
  CONSTRAINT "saved_opportunity_searches_match_mode_check"
    CHECK ("match_mode" IN ('matched', 'all')),
  CONSTRAINT "saved_opportunity_searches_scope_check"
    CHECK (("is_tenant_wide" = true AND "client_id" IS NULL) OR ("is_tenant_wide" = false AND "client_id" IS NOT NULL)),
  CONSTRAINT "saved_opportunity_searches_schema_version_check"
    CHECK ("schema_version" >= 1)
);

CREATE INDEX "saved_opportunity_searches_scope_idx"
  ON "saved_opportunity_searches" ("tenant_id", "client_id", "archived_at", "updated_at");
CREATE INDEX "saved_opportunity_searches_owner_idx"
  ON "saved_opportunity_searches" ("tenant_id", "owner_id", "archived_at");

CREATE TRIGGER "saved_opportunity_searches_set_updated_at"
  BEFORE UPDATE ON "saved_opportunity_searches"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "saved_opportunity_searches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_opportunity_searches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "saved_opportunity_searches_isolation" ON "saved_opportunity_searches"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "saved_opportunity_searches" TO capiro_app;
  END IF;
END
$$;
