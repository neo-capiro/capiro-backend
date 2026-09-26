-- Research Portfolios Phase 1: additive manual collections, authority,
-- tenant-safe typed membership, client links and append-only history.

CREATE TYPE "research_portfolio_mode" AS ENUM ('manual', 'rules', 'hybrid');
CREATE TYPE "research_portfolio_lifecycle" AS ENUM ('active', 'archived');
CREATE TYPE "research_portfolio_grant_role" AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE "research_portfolio_member_kind" AS ENUM ('program', 'program_element', 'project', 'budget_line', 'award');
CREATE TYPE "research_portfolio_member_disposition" AS ENUM ('included', 'excluded', 'unresolved');
CREATE TYPE "research_portfolio_event_kind" AS ENUM (
  'created',
  'updated',
  'archived',
  'restored',
  'grant_upserted',
  'grant_removed',
  'client_linked',
  'client_unlinked',
  'member_added',
  'member_decided',
  'member_excluded',
  'member_reinstated',
  'member_resolved'
);

CREATE UNIQUE INDEX "clients_tenant_id_key" ON "clients"("tenant_id", "id");

CREATE TABLE "research_portfolios" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "purpose" TEXT,
  "mode" "research_portfolio_mode" NOT NULL DEFAULT 'manual',
  "lifecycle" "research_portfolio_lifecycle" NOT NULL DEFAULT 'active',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolios_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolios_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "research_portfolios_archive_state_check" CHECK (
    ("lifecycle" = 'archived' AND "archived_at" IS NOT NULL)
    OR ("lifecycle" = 'active' AND "archived_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "research_portfolios_tenant_id_key" ON "research_portfolios"("tenant_id", "id");
CREATE INDEX "research_portfolios_tenant_lifecycle_updated_idx" ON "research_portfolios"("tenant_id", "lifecycle", "updated_at" DESC);
CREATE INDEX "research_portfolios_tenant_owner_idx" ON "research_portfolios"("tenant_id", "owner_user_id");

CREATE TABLE "research_portfolio_grants" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "principal_user_id" UUID NOT NULL,
  "role" "research_portfolio_grant_role" NOT NULL,
  "granted_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "research_portfolio_grants_portfolio_user_key" ON "research_portfolio_grants"("tenant_id", "portfolio_id", "principal_user_id");
CREATE INDEX "research_portfolio_grants_tenant_principal_role_idx" ON "research_portfolio_grants"("tenant_id", "principal_user_id", "role");

CREATE TABLE "research_portfolio_client_links" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "linked_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_client_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "research_portfolio_client_links_portfolio_client_key" ON "research_portfolio_client_links"("tenant_id", "portfolio_id", "client_id");
CREATE INDEX "research_portfolio_client_links_tenant_client_idx" ON "research_portfolio_client_links"("tenant_id", "client_id");

CREATE TABLE "research_portfolio_members" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "target_kind" "research_portfolio_member_kind" NOT NULL,
  "target_id" VARCHAR(256) NOT NULL,
  "label" VARCHAR(300),
  "disposition" "research_portfolio_member_disposition" NOT NULL DEFAULT 'included',
  "reason" TEXT,
  "unresolved_input" JSONB,
  "resolved_at" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL,
  "updated_by_user_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "research_portfolio_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolio_members_revision_check" CHECK ("revision" > 0)
);

CREATE UNIQUE INDEX "research_portfolio_members_target_key" ON "research_portfolio_members"("tenant_id", "portfolio_id", "target_kind", "target_id");
CREATE INDEX "research_portfolio_members_disposition_idx" ON "research_portfolio_members"("tenant_id", "portfolio_id", "disposition", "updated_at" DESC);

CREATE TABLE "research_portfolio_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID NOT NULL,
  "portfolio_id" UUID NOT NULL,
  "event_kind" "research_portfolio_event_kind" NOT NULL,
  "aggregate_revision" INTEGER NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotency_key" VARCHAR(128),
  "payload_fingerprint" VARCHAR(64),
  "payload" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "research_portfolio_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "research_portfolio_events_revision_check" CHECK ("aggregate_revision" > 0),
  CONSTRAINT "research_portfolio_events_idempotency_pair_check" CHECK (
    ("idempotency_key" IS NULL AND "payload_fingerprint" IS NULL)
    OR ("idempotency_key" IS NOT NULL AND "payload_fingerprint" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "research_portfolio_events_revision_id_key" ON "research_portfolio_events"("tenant_id", "portfolio_id", "aggregate_revision", "id");
CREATE UNIQUE INDEX "research_portfolio_events_idempotency_key" ON "research_portfolio_events"("tenant_id", "idempotency_key");
CREATE INDEX "research_portfolio_events_timeline_idx" ON "research_portfolio_events"("tenant_id", "portfolio_id", "occurred_at" DESC);

ALTER TABLE "research_portfolios"
  ADD CONSTRAINT "research_portfolios_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolios_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_grants"
  ADD CONSTRAINT "research_portfolio_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_grants_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_grants_principal_user_id_fkey" FOREIGN KEY ("principal_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_client_links"
  ADD CONSTRAINT "research_portfolio_client_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_client_links_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_client_links_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_members"
  ADD CONSTRAINT "research_portfolio_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_members_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "research_portfolio_events"
  ADD CONSTRAINT "research_portfolio_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "research_portfolio_events_tenant_id_portfolio_id_fkey" FOREIGN KEY ("tenant_id", "portfolio_id") REFERENCES "research_portfolios"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION research_portfolio_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'research_portfolio_events is append-only';
END;
$$;

CREATE TRIGGER "research_portfolio_events_append_only_trigger"
BEFORE UPDATE OR DELETE ON "research_portfolio_events"
FOR EACH ROW EXECUTE FUNCTION research_portfolio_events_append_only();
