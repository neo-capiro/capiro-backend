ALTER TABLE intel_legiwatch_folder ADD CONSTRAINT folder_access_valid CHECK (other_user_access IN ('read_only','read_change'));
ALTER TABLE intel_legiwatch_folder ADD CONSTRAINT folder_name_nonempty CHECK (length(trim(name)) > 0);
ALTER TABLE intel_legiwatch_folder_bill ADD CONSTRAINT folder_importance_valid CHECK (importance IN ('normal','low','medium','high'));
ALTER TABLE intel_legiwatch_folder_bill ADD CONSTRAINT folder_position_valid CHECK (position IN ('none','support','oppose','monitor','neutral'));
ALTER TABLE intel_legiwatch_folder_bill ADD CONSTRAINT folder_date_precision_valid CHECK (added_date_precision IN ('instant','date','local_minute_unknown_zone','unknown'));
ALTER TABLE intel_legiwatch_staged_configuration ADD CONSTRAINT folder_configuration_inactive CHECK (state IN ('staged','needs_review','excluded'));

CREATE FUNCTION legiwatch_folder_can_write(t text, f text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT EXISTS (SELECT 1 FROM intel_legiwatch_folder
    WHERE tenant_id = t AND id = f AND NOT archived AND owner_clerk_id IS NOT NULL
    AND (owner_clerk_id = current_setting('app.folder_actor',true) OR other_user_access = 'read_change'))
$$;

ALTER TABLE intel_legiwatch_folder ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_legiwatch_folder FORCE ROW LEVEL SECURITY;
CREATE POLICY folder_read ON intel_legiwatch_folder FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id()::text);
CREATE POLICY folder_insert ON intel_legiwatch_folder FOR INSERT WITH CHECK (rls_bypass() OR
  (tenant_id = current_tenant_id()::text AND (owner_clerk_id = current_setting('app.folder_actor',true) OR current_setting('app.folder_admin',true) = 'on')));
CREATE POLICY folder_update ON intel_legiwatch_folder FOR UPDATE USING (rls_bypass() OR
  (tenant_id = current_tenant_id()::text AND owner_clerk_id IS NOT NULL AND
  (owner_clerk_id = current_setting('app.folder_actor',true) OR other_user_access = 'read_change')))
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);
-- No delete policy: folders are archived, never silently cascade-untracked.

ALTER TABLE intel_legiwatch_folder_bill ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_legiwatch_folder_bill FORCE ROW LEVEL SECURITY;
CREATE POLICY folder_bill_read ON intel_legiwatch_folder_bill FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id()::text);
CREATE POLICY folder_bill_insert ON intel_legiwatch_folder_bill FOR INSERT WITH CHECK (rls_bypass() OR (tenant_id = current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id)));
CREATE POLICY folder_bill_update ON intel_legiwatch_folder_bill FOR UPDATE USING (rls_bypass() OR (tenant_id = current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id))) WITH CHECK (rls_bypass() OR (tenant_id = current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id)));
CREATE POLICY folder_bill_delete ON intel_legiwatch_folder_bill FOR DELETE USING (rls_bypass() OR (tenant_id = current_tenant_id()::text AND legiwatch_folder_can_write(tenant_id,folder_id)));

ALTER TABLE intel_legiwatch_folder_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_legiwatch_folder_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY folder_revision_read ON intel_legiwatch_folder_revision FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id()::text);
CREATE POLICY folder_revision_insert ON intel_legiwatch_folder_revision FOR INSERT WITH CHECK (rls_bypass() OR
  (tenant_id = current_tenant_id()::text AND EXISTS (SELECT 1 FROM intel_legiwatch_folder_bill a
   WHERE a.tenant_id = intel_legiwatch_folder_revision.tenant_id AND a.id = assignment_id AND legiwatch_folder_can_write(a.tenant_id,a.folder_id))));

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['intel_legiwatch_import_run','intel_legiwatch_import_item','intel_legiwatch_source_mapping','intel_legiwatch_staged_configuration'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (rls_bypass() OR (tenant_id = current_tenant_id()::text AND current_setting(''app.folder_admin'',true) = ''on''))',t||'_read',t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (rls_bypass() OR (tenant_id = current_tenant_id()::text AND current_setting(''app.folder_admin'',true) = ''on'')) WITH CHECK (rls_bypass() OR (tenant_id = current_tenant_id()::text AND current_setting(''app.folder_admin'',true) = ''on''))',t||'_admin',t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    FOREACH t IN ARRAY ARRAY['intel_legiwatch_folder','intel_legiwatch_folder_bill','intel_legiwatch_folder_revision','intel_legiwatch_import_run','intel_legiwatch_import_item','intel_legiwatch_source_mapping','intel_legiwatch_staged_configuration'] LOOP
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO capiro_app',t);
    END LOOP;
  END IF;
END $$;

-- Cross-service references are soft in Prisma but must resolve in this tenant.
CREATE FUNCTION legiwatch_folder_validate_references() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clients WHERE id::text=NEW.client_id AND tenant_id::text=NEW.tenant_id) THEN
    RAISE EXCEPTION 'Folder client is outside tenant' USING ERRCODE='23503';
  END IF;
  IF NEW.owner_clerk_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
    WHERE tm.tenant_id::text=NEW.tenant_id AND u.clerk_user_id=NEW.owner_clerk_id AND tm.status::text='active') THEN
    RAISE EXCEPTION 'Folder owner is not an active tenant member' USING ERRCODE='23503';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.owner_clerk_id IS DISTINCT FROM OLD.owner_clerk_id OR NEW.other_user_access IS DISTINCT FROM OLD.other_user_access OR NEW.client_id IS DISTINCT FROM OLD.client_id)
     AND rls_bypass() IS NOT TRUE AND OLD.owner_clerk_id IS DISTINCT FROM current_setting('app.folder_actor',true) THEN
    RAISE EXCEPTION 'Only folder owner can change access' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER folder_validate_references BEFORE INSERT OR UPDATE ON intel_legiwatch_folder
FOR EACH ROW EXECUTE FUNCTION legiwatch_folder_validate_references();
