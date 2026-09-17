-- California Grants Portal uses the generic workflow identity bridge.  The
-- legacy grants/SAM pointer columns remain untouched and continue to be
-- required for their two legacy sources.
ALTER TABLE "client_funding_opportunity"
  DROP CONSTRAINT IF EXISTS "client_funding_opportunity_source_chk";

ALTER TABLE "client_funding_opportunity"
  ADD CONSTRAINT "client_funding_opportunity_source_chk"
  CHECK ("source" IN ('grants_gov', 'sam_gov', 'agency_forecast', 'dibbs', 'sbir_sttr', 'ca_portal'));

ALTER TABLE "client_funding_opportunity"
  DROP CONSTRAINT IF EXISTS "client_funding_opportunity_one_source_chk";

ALTER TABLE "client_funding_opportunity"
  ADD CONSTRAINT "client_funding_opportunity_one_source_chk" CHECK (
    (
      "source" = 'grants_gov'
      AND "grant_opportunity_id" IS NOT NULL
      AND "sam_opportunity_id" IS NULL
      AND (
        ("source_record_key" IS NULL AND "source_record_type" IS NULL)
        OR ("source_record_key" IS NOT NULL AND "source_record_type" = 'grants_gov_opportunity')
      )
    )
    OR (
      "source" = 'sam_gov'
      AND "sam_opportunity_id" IS NOT NULL
      AND "grant_opportunity_id" IS NULL
      AND (
        ("source_record_key" IS NULL AND "source_record_type" IS NULL)
        OR ("source_record_key" IS NOT NULL AND "source_record_type" = 'sam_notice')
      )
    )
    OR (
      "source" NOT IN ('grants_gov', 'sam_gov')
      AND "grant_opportunity_id" IS NULL
      AND "sam_opportunity_id" IS NULL
      AND "source_record_type" = CASE "source"
        WHEN 'agency_forecast' THEN 'tango_procurement_forecast'
        WHEN 'dibbs' THEN 'dibbs_solicitation'
        WHEN 'sbir_sttr' THEN 'sbir_topic'
        WHEN 'ca_portal' THEN 'ca_grant_opportunity'
        ELSE ''
      END
      AND "source_record_key" IS NOT NULL
      AND "source_record_type" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS "client_funding_opportunity_generic_uniq"
  ON "client_funding_opportunity" ("tenant_id", "client_id", "source", "source_record_key")
  WHERE "source_record_key" IS NOT NULL;