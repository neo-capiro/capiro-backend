-- Root-reviewed proposal only. Additive saved comparison ownership, immutable
-- capture versions and idempotent mutation receipts. No source publication.
CREATE TABLE "defense_saved_comparisons" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "portfolio_id" UUID,
  "name" VARCHAR(200) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "current_version_id" UUID,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_saved_comparisons_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defense_saved_compare_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "defense_saved_compare_revision_check" CHECK ("revision" > 0)
);
CREATE UNIQUE INDEX "defense_saved_comparisons_tenant_id_key" ON "defense_saved_comparisons"("tenant_id", "id");
CREATE INDEX "defense_saved_comparisons_owner_list_idx" ON "defense_saved_comparisons"("tenant_id", "owner_user_id", "archived_at", "updated_at" DESC);
CREATE INDEX "defense_saved_comparisons_portfolio_idx" ON "defense_saved_comparisons"("tenant_id", "portfolio_id", "archived_at");

CREATE TABLE "defense_saved_comparison_versions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "comparison_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "creator_user_id" UUID NOT NULL,
  "schema_version" VARCHAR(64) NOT NULL,
  "projection_version" VARCHAR(64) NOT NULL,
  "display_version" VARCHAR(64) NOT NULL,
  "subjects" JSONB NOT NULL,
  "selection" JSONB NOT NULL,
  "basis_pair" JSONB NOT NULL,
  "passage_mode" VARCHAR(32) NOT NULL,
  "source_pins" JSONB NOT NULL,
  "captured_projection" JSONB NOT NULL,
  "limitations" JSONB NOT NULL DEFAULT '[]',
  "content_hash" CHAR(64) NOT NULL,
  "capture_known_at" TIMESTAMPTZ(6) NOT NULL,
  "known_at_support" VARCHAR(32) NOT NULL DEFAULT 'capture_only',
  "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_saved_comparison_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defense_saved_compare_version_check" CHECK ("version" > 0),
  CONSTRAINT "defense_saved_compare_schema_check" CHECK ("schema_version" = 'defense_saved_comparison_v1'),
  CONSTRAINT "defense_saved_compare_capture_time_check" CHECK ("known_at_support" = 'capture_only' AND "capture_known_at" = "captured_at"),
  CONSTRAINT "defense_saved_compare_projection_versions_check" CHECK (length(btrim("projection_version")) > 0 AND length(btrim("display_version")) > 0),
  CONSTRAINT "defense_saved_compare_content_hash_check" CHECK ("content_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "defense_saved_compare_subjects_check" CHECK (jsonb_typeof("subjects") = 'array' AND jsonb_array_length("subjects") BETWEEN 2 AND 5),
  CONSTRAINT "defense_saved_compare_selection_check" CHECK (jsonb_typeof("selection") = 'object' AND "selection" ?& ARRAY['mode', 'subjectKeys', 'passageIds'] AND "selection"->>'mode' = 'explicit' AND jsonb_typeof("selection"->'subjectKeys') = 'array' AND jsonb_typeof("selection"->'passageIds') = 'array'),
  CONSTRAINT "defense_saved_compare_basis_pair_check" CHECK (jsonb_typeof("basis_pair") = 'object' AND "basis_pair" ?& ARRAY['left', 'right'] AND jsonb_typeof("basis_pair"->'left') = 'object' AND jsonb_typeof("basis_pair"->'right') = 'object'),
  CONSTRAINT "defense_saved_compare_passage_mode_check" CHECK ("passage_mode" IN ('none', 'native_sections')),
  CONSTRAINT "defense_saved_compare_projection_check" CHECK (jsonb_typeof("captured_projection") = 'object' AND jsonb_typeof("source_pins") = 'object' AND jsonb_typeof("limitations") = 'array')
);
CREATE UNIQUE INDEX "defense_saved_compare_version_parent_id_key" ON "defense_saved_comparison_versions"("tenant_id", "comparison_id", "id");
CREATE UNIQUE INDEX "defense_saved_compare_version_number_key" ON "defense_saved_comparison_versions"("tenant_id", "comparison_id", "version");
CREATE INDEX "defense_saved_compare_versions_timeline_idx" ON "defense_saved_comparison_versions"("tenant_id", "comparison_id", "captured_at" DESC);

CREATE TABLE "defense_saved_comparison_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "comparison_id" UUID NOT NULL,
  "version_id" UUID,
  "actor_user_id" UUID NOT NULL,
  "aggregate_revision" INTEGER NOT NULL,
  "event_kind" VARCHAR(32) NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "payload_fingerprint" CHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "defense_saved_comparison_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defense_saved_compare_event_revision_check" CHECK ("aggregate_revision" > 0),
  CONSTRAINT "defense_saved_compare_event_kind_check" CHECK ("event_kind" IN ('created', 'revised', 'archived', 'restored', 'portfolio_attached', 'portfolio_detached')),
  CONSTRAINT "defense_saved_compare_event_payload_check" CHECK (jsonb_typeof("payload") = 'object' AND "payload_fingerprint" ~ '^[a-f0-9]{64}$' AND length(btrim("idempotency_key")) > 0)
);
CREATE UNIQUE INDEX "defense_saved_compare_events_idempotency_key" ON "defense_saved_comparison_events"("tenant_id", "actor_user_id", "idempotency_key");
CREATE INDEX "defense_saved_compare_events_timeline_idx" ON "defense_saved_comparison_events"("tenant_id", "comparison_id", "occurred_at" DESC);

ALTER TABLE "defense_saved_comparisons"
  ADD CONSTRAINT "defense_saved_compare_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_saved_compare_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_saved_compare_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_saved_compare_current_version_fkey" FOREIGN KEY ("tenant_id", "id", "current_version_id") REFERENCES "defense_saved_comparison_versions"("tenant_id", "comparison_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "defense_saved_comparison_versions"
  ADD CONSTRAINT "defense_saved_compare_version_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_saved_compare_version_parent_fkey" FOREIGN KEY ("tenant_id", "comparison_id") REFERENCES "defense_saved_comparisons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_saved_compare_version_creator_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "defense_saved_comparison_events"
  ADD CONSTRAINT "defense_saved_compare_event_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_saved_compare_event_parent_fkey" FOREIGN KEY ("tenant_id", "comparison_id") REFERENCES "defense_saved_comparisons"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_saved_compare_event_version_fkey" FOREIGN KEY ("tenant_id", "comparison_id", "version_id") REFERENCES "defense_saved_comparison_versions"("tenant_id", "comparison_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "defense_saved_compare_event_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION defense_saved_comparison_capture_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER "defense_saved_compare_versions_append_only"
BEFORE UPDATE OR DELETE ON "defense_saved_comparison_versions"
FOR EACH ROW EXECUTE FUNCTION defense_saved_comparison_capture_append_only();

-- Tenant isolation applies to metadata, captures and receipts alike. Comparison
-- ownership and current portfolio grants are enforced by the application before
-- every read/mutation/replay; this policy supplies no cross-owner entitlement.
ALTER TABLE "defense_saved_comparisons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "defense_saved_comparisons" FORCE ROW LEVEL SECURITY;
CREATE POLICY "defense_saved_comparisons_isolation" ON "defense_saved_comparisons"
USING (rls_bypass() OR tenant_id = current_tenant_id())
WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "defense_saved_comparison_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "defense_saved_comparison_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "defense_saved_comparison_versions_isolation" ON "defense_saved_comparison_versions"
USING (rls_bypass() OR tenant_id = current_tenant_id())
WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "defense_saved_comparison_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "defense_saved_comparison_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "defense_saved_comparison_events_isolation" ON "defense_saved_comparison_events"
USING (rls_bypass() OR tenant_id = current_tenant_id())
WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
REVOKE ALL ON "defense_saved_comparisons", "defense_saved_comparison_versions", "defense_saved_comparison_events" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL ON "defense_saved_comparisons", "defense_saved_comparison_versions", "defense_saved_comparison_events" FROM capiro_app;
    GRANT SELECT, INSERT, UPDATE ON "defense_saved_comparisons" TO capiro_app;
    GRANT SELECT, INSERT ON "defense_saved_comparison_versions", "defense_saved_comparison_events" TO capiro_app;
  END IF;
END;
$$;
CREATE TRIGGER "defense_saved_compare_events_append_only"
BEFORE UPDATE OR DELETE ON "defense_saved_comparison_events"
FOR EACH ROW EXECUTE FUNCTION defense_saved_comparison_capture_append_only();
