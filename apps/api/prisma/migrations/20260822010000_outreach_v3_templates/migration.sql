-- Outreach V3 Phase 2: governed campaign templates.
--
-- Templates deliberately store reusable strategy/voice only. Published versions
-- are immutable, application is idempotent, and every applied session records
-- exact provenance. Runtime access is additionally constrained by the service;
-- RLS remains the fail-closed tenant/private-owner boundary.

CREATE TABLE outreach_v3_templates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  client_id uuid NULL,
  scope text NOT NULL CHECK (scope IN ('private', 'firm', 'client')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  current_draft_version_id uuid NULL,
  published_version_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  CONSTRAINT outreach_v3_templates_client_scope_ck CHECK (
    (scope = 'client' AND client_id IS NOT NULL) OR
    (scope <> 'client' AND client_id IS NULL)
  )
);

CREATE TABLE outreach_v3_template_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES outreach_v3_templates(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  lifecycle text NOT NULL CHECK (lifecycle IN ('draft', 'published')),
  template_spec_jsonb jsonb NOT NULL,
  content_hash text NOT NULL CHECK (char_length(content_hash) = 64),
  source_session_id uuid NULL REFERENCES outreach_sessions(id) ON DELETE SET NULL,
  source_state_version integer NULL CHECK (source_state_version IS NULL OR source_state_version > 0),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL,
  UNIQUE (template_id, version_number),
  CONSTRAINT outreach_v3_template_versions_publish_ck CHECK (
    (lifecycle = 'published' AND published_at IS NOT NULL) OR
    (lifecycle = 'draft' AND published_at IS NULL)
  )
);

ALTER TABLE outreach_v3_templates
  ADD CONSTRAINT outreach_v3_templates_draft_fk
  FOREIGN KEY (current_draft_version_id)
  REFERENCES outreach_v3_template_versions(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE outreach_v3_templates
  ADD CONSTRAINT outreach_v3_templates_published_fk
  FOREIGN KEY (published_version_id)
  REFERENCES outreach_v3_template_versions(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE outreach_v3_template_applications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES outreach_v3_templates(id) ON DELETE RESTRICT,
  template_version_id uuid NOT NULL REFERENCES outreach_v3_template_versions(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES outreach_sessions(id) ON DELETE CASCADE,
  applied_by_user_id uuid NOT NULL,
  request_key uuid NOT NULL,
  command_batch_jsonb jsonb NOT NULL,
  template_content_hash text NOT NULL CHECK (char_length(template_content_hash) = 64),
  resulting_state_version integer NOT NULL CHECK (resulting_state_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, applied_by_user_id, request_key),
  UNIQUE (session_id)
);

CREATE TABLE outreach_v3_session_template_provenance (
  session_id uuid PRIMARY KEY REFERENCES outreach_sessions(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES outreach_v3_templates(id) ON DELETE RESTRICT,
  template_version_id uuid NOT NULL REFERENCES outreach_v3_template_versions(id) ON DELETE RESTRICT,
  application_id uuid NOT NULL UNIQUE REFERENCES outreach_v3_template_applications(id) ON DELETE CASCADE,
  applied_by_user_id uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outreach_v3_templates_tenant_status_idx
  ON outreach_v3_templates (tenant_id, status, updated_at DESC);
CREATE INDEX outreach_v3_templates_client_idx
  ON outreach_v3_templates (tenant_id, client_id, updated_at DESC)
  WHERE client_id IS NOT NULL;
CREATE INDEX outreach_v3_template_versions_template_idx
  ON outreach_v3_template_versions (template_id, version_number DESC);
CREATE INDEX outreach_v3_template_applications_template_idx
  ON outreach_v3_template_applications (template_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_outreach_v3_published_template_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.lifecycle = 'published' THEN
    RAISE EXCEPTION 'Published outreach template versions are immutable.' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.lifecycle = 'published' THEN
    RAISE EXCEPTION 'Published outreach template versions are immutable.' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER outreach_v3_template_versions_immutable
BEFORE UPDATE OR DELETE ON outreach_v3_template_versions
FOR EACH ROW EXECUTE FUNCTION prevent_outreach_v3_published_template_mutation();

ALTER TABLE outreach_v3_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_template_applications FORCE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_session_template_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_v3_session_template_provenance FORCE ROW LEVEL SECURITY;

CREATE POLICY outreach_v3_templates_actor_policy ON outreach_v3_templates
  USING (
    tenant_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
    AND (
      scope <> 'private'
      OR owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
    AND owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

CREATE POLICY outreach_v3_template_versions_actor_policy ON outreach_v3_template_versions
  USING (
    tenant_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM outreach_v3_templates t
      WHERE t.id = template_id
        AND t.tenant_id = tenant_id
        AND (t.scope <> 'private' OR t.owner_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    )
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
    AND created_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

CREATE POLICY outreach_v3_template_applications_actor_policy ON outreach_v3_template_applications
  USING (
    tenant_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
    AND applied_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
    AND applied_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

CREATE POLICY outreach_v3_session_template_provenance_actor_policy ON outreach_v3_session_template_provenance
  USING (
    tenant_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
    AND applied_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_firm_id', true), '')::uuid
    AND applied_by_user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_v3_templates TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_v3_template_versions TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_v3_template_applications TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_v3_session_template_provenance TO capiro_app;
  END IF;
END;
$$;
