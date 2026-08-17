-- Durable Meri vNext saved prompts and user workspaces.
--
-- These are user-owned within a tenant. Conversation membership remains on the
-- existing clio_conversations table so a saved prompt/workspace never grants
-- access to another user's chat history.

CREATE TABLE "meri_saved_prompts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "meri_saved_prompts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "meri_saved_prompts_tenant_id_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "meri_saved_prompts_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "meri_saved_prompts_title_not_blank" CHECK (length(btrim("title")) > 0),
    CONSTRAINT "meri_saved_prompts_body_not_blank" CHECK (length(btrim("body")) > 0)
);

CREATE INDEX "meri_saved_prompts_tenant_user_updated_idx"
    ON "meri_saved_prompts" ("tenant_id", "user_id", "updated_at" DESC);

ALTER TABLE "meri_saved_prompts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_saved_prompts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_saved_prompts_isolation" ON "meri_saved_prompts"
    USING (rls_bypass() OR "tenant_id" = current_tenant_id())
    WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());
CREATE TRIGGER "meri_saved_prompts_set_updated_at"
    BEFORE UPDATE ON "meri_saved_prompts"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "meri_workspaces" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "meri_workspaces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "meri_workspaces_tenant_id_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "meri_workspaces_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "meri_workspaces_client_id_fkey" FOREIGN KEY ("client_id")
        REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "meri_workspaces_name_not_blank" CHECK (length(btrim("name")) > 0)
);

CREATE INDEX "meri_workspaces_tenant_user_updated_idx"
    ON "meri_workspaces" ("tenant_id", "user_id", "updated_at" DESC);
CREATE INDEX "meri_workspaces_tenant_user_client_idx"
    ON "meri_workspaces" ("tenant_id", "user_id", "client_id");

ALTER TABLE "meri_workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_workspaces" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_workspaces_isolation" ON "meri_workspaces"
    USING (rls_bypass() OR "tenant_id" = current_tenant_id())
    WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());
CREATE TRIGGER "meri_workspaces_set_updated_at"
    BEFORE UPDATE ON "meri_workspaces"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "meri_vnext_preferences" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "window_chrome" VARCHAR(16) NOT NULL DEFAULT 'undocked',
    "rail_collapsed" BOOLEAN NOT NULL DEFAULT false,
    "open_section" VARCHAR(16),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "meri_vnext_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "meri_vnext_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id")
        REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "meri_vnext_preferences_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "meri_vnext_preferences_window_chrome_check"
        CHECK ("window_chrome" IN ('undocked', 'maximized', 'docked')),
    CONSTRAINT "meri_vnext_preferences_open_section_check"
        CHECK ("open_section" IS NULL OR "open_section" IN ('context', 'sources', 'actions')),
    CONSTRAINT "meri_vnext_preferences_tenant_user_unique" UNIQUE ("tenant_id", "user_id")
);

ALTER TABLE "meri_vnext_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_vnext_preferences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_vnext_preferences_isolation" ON "meri_vnext_preferences"
    USING (rls_bypass() OR "tenant_id" = current_tenant_id())
    WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());
CREATE TRIGGER "meri_vnext_preferences_set_updated_at"
    BEFORE UPDATE ON "meri_vnext_preferences"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE "clio_conversations" ADD COLUMN "workspace_id" UUID;
ALTER TABLE "clio_conversations"
    ADD CONSTRAINT "clio_conversations_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "meri_workspaces"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "clio_conversations_tenant_user_workspace_updated_idx"
    ON "clio_conversations" ("tenant_id", "user_id", "workspace_id", "updated_at" DESC);

-- Touch parent workspace recency after member conversations move or receive new turns.
CREATE OR REPLACE FUNCTION touch_meri_workspace_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    UPDATE "meri_workspaces" SET "updated_at" = now() WHERE "id" = NEW.workspace_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "zz_clio_conversations_touch_meri_workspace"
AFTER INSERT OR UPDATE OF "workspace_id", "updated_at" ON "clio_conversations"
FOR EACH ROW EXECUTE FUNCTION touch_meri_workspace_updated_at();
