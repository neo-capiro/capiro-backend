-- District-scoped action recommendations retain the existing action lifecycle and RLS.
ALTER TABLE "action_recommendation" ADD COLUMN "district_key" VARCHAR(8);
ALTER TABLE "action_recommendation" ADD CONSTRAINT "action_recommendation_district_key_format" CHECK ("district_key" IS NULL OR "district_key" ~ '^[A-Z]{2}-[0-9]{2}$');
CREATE INDEX "action_recommendation_tenant_client_district_idx" ON "action_recommendation" ("tenant_id", "client_id", "district_key");

-- The legacy expression index coalesces every null delta_id into one card per type.
-- Keep its old behavior for non-district cards, while district cards dedupe on their
-- evidence fact-set hash (stored as a source evidence note: r5-fact-set:<sha256>).
DROP INDEX "action_recommendation_dedupe_key";
CREATE UNIQUE INDEX "action_recommendation_dedupe_key" ON "action_recommendation" ("tenant_id", "client_id", (COALESCE("delta_id"::text, '')), "action_type") WHERE "district_key" IS NULL;
CREATE UNIQUE INDEX "action_recommendation_district_fact_dedupe_key" ON "action_recommendation" ("tenant_id", "client_id", "district_key", "action_type", ("evidence_jsonb"->0->>'note')) WHERE "district_key" IS NOT NULL;
