-- Document Agent vNext: append-only messages, immutable firm blueprints,
-- revision proposals, delivery approval requests, secure share links.

-- ── Agent messages ────────────────────────────────────────────────────────
CREATE TYPE "ws_agent_message_role" AS ENUM ('user', 'assistant', 'system');

CREATE TABLE "ws_agent_message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "actor_id" TEXT,
    "role" "ws_agent_message_role" NOT NULL,
    "phase" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_agent_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ws_agent_message_tenant_id_draft_id_created_at_idx"
    ON "ws_agent_message"("tenant_id", "draft_id", "created_at");

ALTER TABLE "ws_agent_message"
    ADD CONSTRAINT "ws_agent_message_draft_id_fkey"
    FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id")
    ON DELETE CASCADE;

-- ── Firm blueprints ───────────────────────────────────────────────────────
CREATE TYPE "ws_blueprint_scope" AS ENUM ('capiro', 'firm');
CREATE TYPE "ws_blueprint_version_status" AS ENUM ('draft', 'published', 'retired');

CREATE TABLE "ws_blueprint" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "scope" "ws_blueprint_scope" NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "description" TEXT,
    "owner_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ws_blueprint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ws_blueprint_tenant_id_slug_key"
    ON "ws_blueprint"("tenant_id", "slug");

CREATE INDEX "ws_blueprint_tenant_id_product_idx"
    ON "ws_blueprint"("tenant_id", "product");

CREATE TABLE "ws_blueprint_version" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "blueprint_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ws_blueprint_version_status" NOT NULL DEFAULT 'draft',
    "definition" JSONB NOT NULL,
    "definition_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "ws_blueprint_version_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ws_blueprint_version_blueprint_id_version_key"
    ON "ws_blueprint_version"("blueprint_id", "version");

CREATE INDEX "ws_blueprint_version_tenant_id_status_idx"
    ON "ws_blueprint_version"("tenant_id", "status");

ALTER TABLE "ws_blueprint_version"
    ADD CONSTRAINT "ws_blueprint_version_blueprint_id_fkey"
    FOREIGN KEY ("blueprint_id") REFERENCES "ws_blueprint"("id")
    ON DELETE CASCADE;

-- ── Revision proposals ────────────────────────────────────────────────────
CREATE TYPE "ws_agent_proposal_status" AS ENUM ('pending', 'accepted', 'rejected', 'stale');

CREATE TABLE "ws_agent_proposal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "ws_agent_proposal_status" NOT NULL DEFAULT 'pending',
    "base_revision" INTEGER NOT NULL,
    "base_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by_id" TEXT,

    CONSTRAINT "ws_agent_proposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ws_agent_proposal_tenant_id_draft_id_created_at_idx"
    ON "ws_agent_proposal"("tenant_id", "draft_id", "created_at");

ALTER TABLE "ws_agent_proposal"
    ADD CONSTRAINT "ws_agent_proposal_draft_id_fkey"
    FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id")
    ON DELETE CASCADE;

-- ── Delivery: approval requests + share links ────────────────────────────
CREATE TYPE "ws_approval_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');

CREATE TABLE "ws_approval_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "reviewer_id" TEXT,
    "status" "ws_approval_status" NOT NULL DEFAULT 'pending',
    "version_id" UUID,
    "notes" TEXT,
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "ws_approval_request_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ws_approval_request_tenant_id_draft_id_created_at_idx"
    ON "ws_approval_request"("tenant_id", "draft_id", "created_at");

ALTER TABLE "ws_approval_request"
    ADD CONSTRAINT "ws_approval_request_draft_id_fkey"
    FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id")
    ON DELETE CASCADE;

CREATE TABLE "ws_share_link" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "version_id" UUID,
    "label" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ws_share_link_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ws_share_link_tenant_id_draft_id_idx"
    ON "ws_share_link"("tenant_id", "draft_id");

CREATE INDEX "ws_share_link_token_hash_idx"
    ON "ws_share_link"("token_hash");

ALTER TABLE "ws_share_link"
    ADD CONSTRAINT "ws_share_link_draft_id_fkey"
    FOREIGN KEY ("draft_id") REFERENCES "ws_draft"("id")
    ON DELETE CASCADE;
