-- Empty named locations; attachment permissions are not inherited from folders.
CREATE TABLE client_file_folders (
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  name VARCHAR(120) NOT NULL CHECK (name = btrim(name) AND length(name) > 0),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT client_file_folders_pkey PRIMARY KEY (tenant_id, client_id, name),
  CONSTRAINT client_file_folders_client_fk FOREIGN KEY (tenant_id, client_id)
    REFERENCES clients(tenant_id, id) ON DELETE CASCADE ON UPDATE NO ACTION
);
ALTER TABLE client_file_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_file_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY client_file_folders_isolation ON client_file_folders
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT ON client_file_folders TO capiro_app;
  END IF;
END $$;
