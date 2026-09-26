-- Research Portfolios Phase 2: immutable taxonomy, template and rule versions,
-- durable preview manifests, and bounded recomputation jobs.

ALTER TYPE "research_portfolio_event_kind" ADD VALUE IF NOT EXISTS 'rule_published';
ALTER TYPE "research_portfolio_member_disposition" ADD VALUE IF NOT EXISTS 'candidate';
ALTER TYPE "research_portfolio_member_disposition" ADD VALUE IF NOT EXISTS 'withdrawn';
CREATE TYPE "research_portfolio_member_origin" AS ENUM ('manual', 'rule', 'import');
ALTER TABLE "research_portfolio_members"
  ADD COLUMN "origin" "research_portfolio_member_origin" NOT NULL DEFAULT 'manual',
  ADD COLUMN "evidence" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "qualification" VARCHAR(64),
  ADD COLUMN "rule_version_id" UUID,
  ADD COLUMN "decision_revision" INTEGER;

CREATE TYPE "research_portfolio_recompute_status" AS ENUM (
  'queued', 'running', 'partial', 'completed', 'failed', 'cancelled'
);

CREATE TABLE "research_taxonomy_versions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "label" VARCHAR(160) NOT NULL,
  "vocabulary" VARCHAR(64) NOT NULL,
  "source" TEXT,
  "provenance" JSONB NOT NULL DEFAULT '{}',
  "author_user_id" UUID NOT NULL,
  "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "predecessor_id" UUID,
  CONSTRAINT "research_taxonomy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_taxonomy_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "research_taxonomy_versions_vocabulary_check" CHECK ("vocabulary" IN ('official_current','official_historical','capiro','tenant'))
);
CREATE UNIQUE INDEX "research_taxonomy_versions_tenant_id_key" ON "research_taxonomy_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "research_taxonomy_versions_tenant_version_key" ON "research_taxonomy_versions"("tenant_id", "version");
CREATE INDEX "research_taxonomy_versions_tenant_published_idx" ON "research_taxonomy_versions"("tenant_id", "published_at" DESC);

CREATE TABLE "research_taxonomy_concepts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "taxonomy_version_id" UUID NOT NULL,
  "stable_key" VARCHAR(128) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "kind" VARCHAR(48) NOT NULL,
  "parent_key" VARCHAR(128),
  "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "provenance" JSONB NOT NULL DEFAULT '{}',
  "qualification" VARCHAR(32) NOT NULL DEFAULT 'reviewed',
  CONSTRAINT "research_taxonomy_concepts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "research_taxonomy_concepts_version_key" ON "research_taxonomy_concepts"("tenant_id", "taxonomy_version_id", "stable_key");
CREATE INDEX "research_taxonomy_concepts_parent_idx" ON "research_taxonomy_concepts"("tenant_id", "taxonomy_version_id", "parent_key");

CREATE TABLE "research_portfolio_templates" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "research_portfolio_templates_tenant_id_key" ON "research_portfolio_templates"("tenant_id", "id");
CREATE UNIQUE INDEX "research_portfolio_templates_tenant_name_key" ON "research_portfolio_templates"("tenant_id", "name");
CREATE INDEX "research_portfolio_templates_tenant_archive_idx" ON "research_portfolio_templates"("tenant_id", "archived_at", "created_at" DESC);

CREATE TABLE "research_portfolio_template_versions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "template_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "expression" JSONB NOT NULL,
  "readable_expression" TEXT NOT NULL,
  "mode" "research_portfolio_mode" NOT NULL,
  "qualification_policy" JSONB NOT NULL,
  "taxonomy_version_id" UUID,
  "author_user_id" UUID NOT NULL,
  "predecessor_id" UUID,
  "operation_key" VARCHAR(128) NOT NULL,
  "payload_fingerprint" CHAR(64) NOT NULL,
  "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_template_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolio_template_versions_version_check" CHECK ("version" > 0 AND "schema_version" = 1)
);
CREATE UNIQUE INDEX "research_portfolio_template_versions_number_key" ON "research_portfolio_template_versions"("tenant_id", "template_id", "version");
CREATE UNIQUE INDEX "research_portfolio_template_versions_tenant_id_key" ON "research_portfolio_template_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "research_portfolio_template_versions_operation_key" ON "research_portfolio_template_versions"("tenant_id", "operation_key");
CREATE INDEX "research_portfolio_template_versions_published_idx" ON "research_portfolio_template_versions"("tenant_id", "template_id", "published_at" DESC);

CREATE TABLE "research_portfolio_rule_versions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "expression" JSONB NOT NULL,
  "readable_expression" TEXT NOT NULL,
  "mode" "research_portfolio_mode" NOT NULL,
  "qualification_policy" JSONB NOT NULL,
  "taxonomy_version_id" UUID,
  "template_version_id" UUID,
  "preview_hash" CHAR(64) NOT NULL,
  "author_user_id" UUID NOT NULL,
  "predecessor_id" UUID,
  "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_rule_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolio_rule_versions_version_check" CHECK ("version" > 0 AND "schema_version" = 1)
);
CREATE UNIQUE INDEX "research_portfolio_rule_versions_number_key" ON "research_portfolio_rule_versions"("tenant_id", "portfolio_id", "version");
CREATE UNIQUE INDEX "research_portfolio_rule_versions_tenant_id_key" ON "research_portfolio_rule_versions"("tenant_id", "id");
CREATE INDEX "research_portfolio_rule_versions_published_idx" ON "research_portfolio_rule_versions"("tenant_id", "portfolio_id", "published_at" DESC);

CREATE TABLE "research_portfolio_rule_previews" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "portfolio_revision" INTEGER NOT NULL,
  "preview_hash" CHAR(64) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "expression" JSONB NOT NULL,
  "manifest" JSONB NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "research_portfolio_rule_previews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolio_rule_previews_revision_check" CHECK ("portfolio_revision" > 0)
);
CREATE UNIQUE INDEX "research_portfolio_rule_previews_hash_key" ON "research_portfolio_rule_previews"("tenant_id", "portfolio_id", "preview_hash");
CREATE INDEX "research_portfolio_rule_previews_expiry_idx" ON "research_portfolio_rule_previews"("tenant_id", "portfolio_id", "expires_at");

CREATE TABLE "research_portfolio_recompute_jobs" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "rule_version_id" UUID NOT NULL,
  "operation_key" VARCHAR(128) NOT NULL,
  "status" "research_portfolio_recompute_status" NOT NULL DEFAULT 'queued',
  "cursor" TEXT,
  "processed_count" INTEGER NOT NULL DEFAULT 0,
  "matched_count" INTEGER NOT NULL DEFAULT 0,
  "unknown_count" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" VARCHAR(128),
  "lease_until" TIMESTAMPTZ(6),
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "result" JSONB NOT NULL DEFAULT '{}',
  "error_code" VARCHAR(128),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_recompute_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolio_recompute_jobs_counts_check" CHECK ("processed_count" >= 0 AND "matched_count" >= 0 AND "unknown_count" >= 0 AND "attempt" >= 0)
);
CREATE UNIQUE INDEX "research_portfolio_recompute_jobs_operation_key" ON "research_portfolio_recompute_jobs"("tenant_id", "operation_key");
CREATE INDEX "research_portfolio_recompute_jobs_claim_idx" ON "research_portfolio_recompute_jobs"("tenant_id", "status", "lease_until");
CREATE INDEX "research_portfolio_recompute_jobs_portfolio_idx" ON "research_portfolio_recompute_jobs"("tenant_id", "portfolio_id", "created_at" DESC);

ALTER TABLE "research_taxonomy_versions"
  ADD CONSTRAINT "research_taxonomy_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_taxonomy_concepts"
  ADD CONSTRAINT "research_taxonomy_concepts_version_fkey" FOREIGN KEY ("tenant_id", "taxonomy_version_id") REFERENCES "research_taxonomy_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_portfolio_templates"
  ADD CONSTRAINT "research_portfolio_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_portfolio_template_versions"
  ADD CONSTRAINT "research_portfolio_template_versions_template_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "research_portfolio_templates"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_template_versions_taxonomy_fkey" FOREIGN KEY ("tenant_id", "taxonomy_version_id") REFERENCES "research_taxonomy_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_template_versions_predecessor_fkey" FOREIGN KEY ("tenant_id", "predecessor_id") REFERENCES "research_portfolio_template_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "research_portfolio_rule_versions"
  ADD CONSTRAINT "research_portfolio_rule_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_rule_versions_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_rule_versions_taxonomy_fkey" FOREIGN KEY ("tenant_id", "taxonomy_version_id") REFERENCES "research_taxonomy_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_rule_versions_template_fkey" FOREIGN KEY ("tenant_id", "template_version_id") REFERENCES "research_portfolio_template_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_rule_versions_predecessor_fkey" FOREIGN KEY ("tenant_id", "predecessor_id") REFERENCES "research_portfolio_rule_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "research_portfolio_rule_previews"
  ADD CONSTRAINT "research_portfolio_rule_previews_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_rule_previews_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "research_portfolio_recompute_jobs"
  ADD CONSTRAINT "research_portfolio_recompute_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_recompute_jobs_portfolio_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_recompute_jobs_rule_fkey" FOREIGN KEY ("tenant_id", "rule_version_id") REFERENCES "research_portfolio_rule_versions"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION research_portfolio_versions_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'research portfolio version history is append-only';
END;
$$;
CREATE TRIGGER "research_portfolio_template_versions_append_only_trigger"
BEFORE UPDATE OR DELETE ON "research_portfolio_template_versions"
FOR EACH ROW EXECUTE FUNCTION research_portfolio_versions_append_only();
CREATE TRIGGER "research_portfolio_rule_versions_append_only_trigger"
BEFORE UPDATE OR DELETE ON "research_portfolio_rule_versions"
FOR EACH ROW EXECUTE FUNCTION research_portfolio_versions_append_only();
CREATE TRIGGER "research_taxonomy_versions_append_only_trigger"
BEFORE UPDATE OR DELETE ON "research_taxonomy_versions"
FOR EACH ROW EXECUTE FUNCTION research_portfolio_versions_append_only();
CREATE TRIGGER "research_taxonomy_concepts_append_only_trigger"
BEFORE UPDATE OR DELETE ON "research_taxonomy_concepts"
FOR EACH ROW EXECUTE FUNCTION research_portfolio_versions_append_only();
