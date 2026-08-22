-- Cached "Where capabilities create fit" projection for the client Portfolio
-- Capabilities tab. The row is a fan-in of the EXISTING PE relevance / tracker
-- bill / funding-opportunity scorers filtered to capability-grounded matches --
-- not a new matcher. Computing it means a PE fan-out that can take ~30s, so the
-- GET serves this cache and a manual Refresh recomputes. One row per client
-- (tenant-scoped, RLS), mirroring client_target_recommendations.
CREATE TABLE "client_capability_fit_recommendations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "matches_jsonb" JSONB NOT NULL DEFAULT '[]',
  -- sha256 of the capability signal fields at compute time; a read compares it
  -- to the live signals to flag a stale cache without paying for a recompute.
  "input_fingerprint" TEXT,
  "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "client_capability_fit_recommendations_pkey" PRIMARY KEY ("id"),
  -- Canonical Prisma FK names (table_column_fkey) + ON UPDATE CASCADE so the
  -- schema model and this migration stay drift-free under relationMode=foreignKeys.
  CONSTRAINT "client_capability_fit_recommendations_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "client_capability_fit_recommendations_client_id_fkey" FOREIGN KEY ("client_id")
    REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One cache row per client.
CREATE UNIQUE INDEX "client_capability_fit_recommendations_client_key"
  ON "client_capability_fit_recommendations" ("client_id");
CREATE INDEX "client_capability_fit_recommendations_tenant_client_idx"
  ON "client_capability_fit_recommendations" ("tenant_id", "client_id");

ALTER TABLE "client_capability_fit_recommendations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_capability_fit_recommendations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "client_capability_fit_recommendations_isolation" ON "client_capability_fit_recommendations"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "client_capability_fit_recommendations" TO capiro_app;
  END IF;
END
$$;
