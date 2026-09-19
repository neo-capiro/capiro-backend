CREATE TABLE "opportunity_bookmarks" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "client_id" UUID,
  "source" VARCHAR(32) NOT NULL,
  "source_record_type" VARCHAR(64) NOT NULL,
  "source_record_key" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "opportunity_bookmarks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "opportunity_bookmarks_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "opportunity_bookmarks_client_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "opportunity_bookmarks_workspace_uniq"
  ON "opportunity_bookmarks" ("tenant_id", "source", "source_record_type", "source_record_key")
  WHERE "client_id" IS NULL;
CREATE UNIQUE INDEX "opportunity_bookmarks_client_uniq"
  ON "opportunity_bookmarks" ("tenant_id", "client_id", "source", "source_record_type", "source_record_key")
  WHERE "client_id" IS NOT NULL;
CREATE INDEX "opportunity_bookmarks_lookup_idx"
  ON "opportunity_bookmarks" ("tenant_id", "client_id", "source", "source_record_type", "source_record_key");
ALTER TABLE "opportunity_bookmarks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opportunity_bookmarks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "opportunity_bookmarks_isolation" ON "opportunity_bookmarks"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "opportunity_bookmarks" TO capiro_app;
  END IF;
END $$;

-- The pre-existing generic index omitted source_record_type, which would make
-- two SBIR record kinds collide when the provider ids happen to match.
DROP INDEX IF EXISTS "client_funding_opportunity_generic_uniq";
CREATE UNIQUE INDEX "client_funding_opportunity_generic_uniq"
  ON "client_funding_opportunity" ("tenant_id", "client_id", "source", "source_record_type", "source_record_key")
  WHERE "source_record_key" IS NOT NULL AND "source_record_type" IS NOT NULL;

ALTER TABLE "client_funding_opportunity" DROP CONSTRAINT IF EXISTS "client_funding_opportunity_one_source_chk";
ALTER TABLE "client_funding_opportunity" ADD CONSTRAINT "client_funding_opportunity_one_source_chk" CHECK (
  ("source" = 'grants_gov' AND "grant_opportunity_id" IS NOT NULL AND "sam_opportunity_id" IS NULL AND
    (("source_record_key" IS NULL AND "source_record_type" IS NULL) OR ("source_record_key" IS NOT NULL AND "source_record_type" IS NOT NULL AND "source_record_type" = 'grants_gov_opportunity'))) OR
  ("source" = 'sam_gov' AND "sam_opportunity_id" IS NOT NULL AND "grant_opportunity_id" IS NULL AND
    (("source_record_key" IS NULL AND "source_record_type" IS NULL) OR ("source_record_key" IS NOT NULL AND "source_record_type" IS NOT NULL AND "source_record_type" = 'sam_notice'))) OR
  ("source" NOT IN ('grants_gov', 'sam_gov') AND "grant_opportunity_id" IS NULL AND "sam_opportunity_id" IS NULL AND
    "source_record_key" IS NOT NULL AND "source_record_type" IS NOT NULL AND
    (("source" = 'agency_forecast' AND "source_record_type" = 'tango_procurement_forecast') OR
     ("source" = 'dibbs' AND "source_record_type" = 'dibbs_solicitation') OR
     ("source" = 'sbir_sttr' AND "source_record_type" IN ('sbir_topic', 'sbir_solicitation')) OR
     ("source" = 'ca_portal' AND "source_record_type" = 'ca_grant_opportunity')))
);