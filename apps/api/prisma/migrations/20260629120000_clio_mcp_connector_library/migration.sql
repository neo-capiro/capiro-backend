-- Connector library (connector-library v1).
--
-- Turns the manual MCP-server settings into a Claude-style connector library:
--   1. Per-user vs firm-wide scope on clio_mcp_servers (scope + owner_user_id),
--      so OAuth connectors can be authorized per-person while shared API
--      connectors stay firm-wide. catalog_id links a row to its library entry.
--   2. auth_type ('none' | 'token' | 'oauth') + connection_status drive the new
--      connect flow and status UI.
--   3. clio_mcp_oauth_credentials: 1:1 OAuth 2.1 credential store for
--      auth_type = 'oauth' servers (RFC 7591 dynamic client registration + PKCE
--      + access/refresh tokens), all secret fields AES-256-GCM encrypted at
--      rest, mirroring engagement_connection_tokens.
--
-- Additive + backwards-compatible: existing rows default to scope='tenant',
-- auth_type='token', connection_status='connected' — i.e. exactly today's
-- behavior (firm-wide bearer-token HTTP servers).
--
-- RLS: tenant-isolated, fail-closed, matching clio_mcp_servers. Policy helpers
-- current_tenant_id() / rls_bypass() are defined in
-- 20260501000000_init_identity_tenancy.

-- ── 1. clio_mcp_servers: scope / ownership / auth-type columns ──────────────
ALTER TABLE "clio_mcp_servers"
    ADD COLUMN "scope"             VARCHAR(10)  NOT NULL DEFAULT 'tenant',
    ADD COLUMN "owner_user_id"     UUID,
    ADD COLUMN "catalog_id"        VARCHAR(64),
    ADD COLUMN "auth_type"         VARCHAR(10)  NOT NULL DEFAULT 'token',
    ADD COLUMN "connection_status" VARCHAR(16)  NOT NULL DEFAULT 'connected';

ALTER TABLE "clio_mcp_servers"
    ADD CONSTRAINT "clio_mcp_servers_scope_check"
        CHECK ("scope" IN ('tenant', 'user')),
    ADD CONSTRAINT "clio_mcp_servers_auth_type_check"
        CHECK ("auth_type" IN ('none', 'token', 'oauth')),
    -- A user-scoped row must name its owner; a firm-wide row must not.
    ADD CONSTRAINT "clio_mcp_servers_scope_owner_check"
        CHECK (
            ("scope" = 'user' AND "owner_user_id" IS NOT NULL)
            OR ("scope" = 'tenant' AND "owner_user_id" IS NULL)
        );

-- Per-user name uniqueness: two users can each add a connector named "Notion".
-- Firm-wide rows (owner_user_id IS NULL) are deduped in application code
-- (Postgres treats NULLs as distinct, so they don't collide here).
DROP INDEX IF EXISTS "clio_mcp_servers_tenant_name_unique";
CREATE UNIQUE INDEX "clio_mcp_servers_tenant_owner_name_unique"
    ON "clio_mcp_servers" ("tenant_id", "owner_user_id", "name");
CREATE INDEX "clio_mcp_servers_tenant_owner_enabled_idx"
    ON "clio_mcp_servers" ("tenant_id", "owner_user_id", "enabled");

-- ── 2. clio_mcp_oauth_credentials (1:1 with an oauth server) ────────────────
CREATE TABLE "clio_mcp_oauth_credentials" (
    "id"        UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "server_id" UUID NOT NULL,

    "client_id"                 TEXT,
    "client_secret_ciphertext"  TEXT,
    "client_secret_iv"          TEXT,
    "client_secret_auth_tag"    TEXT,
    "registration_jsonb"        JSONB,

    "access_token_ciphertext"   TEXT,
    "access_token_iv"           TEXT,
    "access_token_auth_tag"     TEXT,
    "refresh_token_ciphertext"  TEXT,
    "refresh_token_iv"          TEXT,
    "refresh_token_auth_tag"    TEXT,
    "token_type"                TEXT,
    "scopes"                    JSONB NOT NULL DEFAULT '[]',
    "token_expires_at"          TIMESTAMPTZ(6),

    "code_verifier_ciphertext"  TEXT,
    "code_verifier_iv"          TEXT,
    "code_verifier_auth_tag"    TEXT,

    "state_nonce" TEXT,

    "key_version" TEXT,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"  TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clio_mcp_oauth_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "clio_mcp_oauth_credentials_server_unique" UNIQUE ("server_id"),
    CONSTRAINT "clio_mcp_oauth_credentials_tenant_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "clio_mcp_oauth_credentials_server_fkey" FOREIGN KEY ("server_id")
        REFERENCES "clio_mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "clio_mcp_oauth_credentials_tenant_idx"
    ON "clio_mcp_oauth_credentials" ("tenant_id");

ALTER TABLE "clio_mcp_oauth_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_mcp_oauth_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_mcp_oauth_credentials_isolation" ON "clio_mcp_oauth_credentials"
    USING (rls_bypass() OR tenant_id = current_tenant_id())
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
