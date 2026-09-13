ALTER POLICY record_scan_owner ON intel_hearing_record_scan_cursor USING (
  current_setting('app.bypass_rls',true) IN ('true','on') OR
  (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting('app.folder_actor',true))
);
