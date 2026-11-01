-- Core-owned immutable revisions. An enable/disable operation always creates a new version.
CREATE TABLE meri_site_workflow_revisions (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id varchar(64) NOT NULL CHECK (site_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  workflow_id varchar(64) NOT NULL CHECK (workflow_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  version integer NOT NULL CHECK (version > 0),
  manifest jsonb NOT NULL,
  manifest_sha256 varchar(64) NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  enabled boolean NOT NULL,
  request_id uuid NOT NULL,
  request_sha256 varchar(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,site_id,workflow_id,version),
  UNIQUE (tenant_id,created_by_user_id,request_id),
  CONSTRAINT site_workflow_identity CHECK ((
    manifest->>'schema'='meri-site-workflow-manifest/0' AND manifest->>'siteId'=site_id
    AND manifest->>'workflowId'=workflow_id AND (manifest->>'version')::integer=version
    AND octet_length(manifest::text)<=65536) IS TRUE)
);
ALTER TABLE meri_site_workflow_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_site_workflow_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY site_workflow_isolation ON meri_site_workflow_revisions
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE ALL ON meri_site_workflow_revisions FROM capiro_app;
    GRANT SELECT,INSERT ON meri_site_workflow_revisions TO capiro_app;
  END IF;
END $$;

