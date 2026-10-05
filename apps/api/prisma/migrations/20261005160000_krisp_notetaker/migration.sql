CREATE TABLE krisp_notetaker_preferences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 server_id uuid NOT NULL REFERENCES clio_mcp_servers(id) ON DELETE CASCADE ON UPDATE CASCADE,
 enabled boolean NOT NULL DEFAULT false, folder_id text, enabled_at timestamptz NOT NULL,
 revision integer NOT NULL DEFAULT 1, last_checked_at timestamptz, last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, user_id)
);
CREATE TABLE krisp_meeting_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 document_id varchar(32) NOT NULL CHECK (document_id ~ '^[a-f0-9]{32}$'),
 title text NOT NULL, starts_at timestamptz NOT NULL,
 meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL ON UPDATE CASCADE,
 status varchar(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_match','processing','done','failed','skipped')),
 lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 error text, note_id uuid, debrief_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, user_id, document_id)
);
CREATE INDEX krisp_meeting_imports_tenant_id_user_id_status_idx ON krisp_meeting_imports(tenant_id,user_id,status);
ALTER TABLE krisp_notetaker_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE krisp_notetaker_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY krisp_notetaker_preferences_scope ON krisp_notetaker_preferences
 USING (rls_bypass() OR (tenant_id = current_tenant_id() AND user_id = nullif(current_setting('app.current_user', true), '')::uuid))
 WITH CHECK (rls_bypass() OR (tenant_id = current_tenant_id() AND user_id = nullif(current_setting('app.current_user', true), '')::uuid));
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
 GRANT SELECT, INSERT, UPDATE, DELETE ON krisp_notetaker_preferences TO capiro_app;
 END IF;
END $$;
ALTER TABLE krisp_meeting_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE krisp_meeting_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY krisp_meeting_imports_scope ON krisp_meeting_imports
 USING (rls_bypass() OR (tenant_id = current_tenant_id() AND user_id = nullif(current_setting('app.current_user', true), '')::uuid))
 WITH CHECK (rls_bypass() OR (tenant_id = current_tenant_id() AND user_id = nullif(current_setting('app.current_user', true), '')::uuid));
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
 GRANT SELECT, INSERT, UPDATE, DELETE ON krisp_meeting_imports TO capiro_app;
 END IF;
END $$;
-- Only the two explicitly authorized organizations receive the flag.
UPDATE tenants SET settings_jsonb = jsonb_set(
 settings_jsonb, '{clioFeatureFlags}',
 (CASE WHEN jsonb_typeof(settings_jsonb->'clioFeatureFlags') = 'object'
   THEN settings_jsonb->'clioFeatureFlags' ELSE '{}'::jsonb END)
   || '{"notetaker.krisp.enabled":true}'::jsonb
) WHERE slug IN ('capiro-internal','c2-strategies');
