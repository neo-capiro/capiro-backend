CREATE TABLE intel_hearing_record_scan_cursor (
  tenant_id TEXT NOT NULL, owner_clerk_id TEXT NOT NULL,
  last_event_id TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,owner_clerk_id)
);
ALTER TABLE intel_hearing_record_scan_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_record_scan_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY record_scan_owner ON intel_hearing_record_scan_cursor USING (
  current_setting('app.bypass_rls',true)='true' OR
  (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting('app.folder_actor',true))
) WITH CHECK (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting('app.folder_actor',true));
GRANT SELECT,INSERT,UPDATE ON intel_hearing_record_scan_cursor TO capiro_app;
REVOKE DELETE,TRUNCATE ON intel_hearing_record_scan_cursor FROM capiro_app;
