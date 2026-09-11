-- Additive Phase 2 constraints. Captured configuration remains inactive.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'intel_legiwatch_report','intel_legiwatch_report_run','intel_legiwatch_promotion',
    'intel_legiwatch_report_contact','intel_legiwatch_report_list','intel_legiwatch_report_subscription',
    'intel_legiwatch_report_occurrence','intel_legiwatch_delivery','intel_legiwatch_delivery_recipient',
    'intel_legiwatch_record_rule','intel_legiwatch_rule_bill_baseline','intel_legiwatch_record_match'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I USING (rls_bypass() OR tenant_id=current_tenant_id()::text) WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id()::text)',t||'_tenant',t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO capiro_app',t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE intel_legiwatch_report ADD CONSTRAINT report_scope_nonempty CHECK (cardinality(folder_ids) BETWEEN 1 AND 100);
ALTER TABLE intel_legiwatch_report ADD CONSTRAINT report_name_nonempty CHECK (length(trim(name)) BETWEEN 1 AND 200);
ALTER TABLE intel_legiwatch_report_run ADD CONSTRAINT report_run_report_fk FOREIGN KEY (tenant_id,report_id) REFERENCES intel_legiwatch_report(tenant_id,id);
ALTER TABLE intel_legiwatch_report_run ADD CONSTRAINT report_run_audience CHECK (audience IN ('external','internal'));
ALTER TABLE intel_legiwatch_report_subscription ADD CONSTRAINT report_subscription_report_fk FOREIGN KEY (tenant_id,report_id) REFERENCES intel_legiwatch_report(tenant_id,id);
ALTER TABLE intel_legiwatch_report_subscription ADD CONSTRAINT report_subscription_mode CHECK (mode IN ('draft','send'));
ALTER TABLE intel_legiwatch_report_subscription ADD CONSTRAINT report_subscription_time CHECK (local_minutes BETWEEN 0 AND 1439);
ALTER TABLE intel_legiwatch_report_subscription ADD CONSTRAINT report_subscription_catchup CHECK (catch_up IN ('draft','send'));
ALTER TABLE intel_legiwatch_report_subscription ADD CONSTRAINT report_subscription_activation CHECK (NOT enabled OR (baseline_at IS NOT NULL AND activated_by IS NOT NULL AND next_due_at IS NOT NULL));
ALTER TABLE intel_legiwatch_report_occurrence ADD CONSTRAINT report_occurrence_subscription_fk FOREIGN KEY (tenant_id,subscription_id) REFERENCES intel_legiwatch_report_subscription(tenant_id,id);
ALTER TABLE intel_legiwatch_report_occurrence ADD CONSTRAINT report_occurrence_run_fk FOREIGN KEY (tenant_id,run_id) REFERENCES intel_legiwatch_report_run(tenant_id,id);
ALTER TABLE intel_legiwatch_report_occurrence ADD CONSTRAINT report_occurrence_window CHECK (window_start<=window_end);
ALTER TABLE intel_legiwatch_delivery ADD CONSTRAINT report_delivery_run_fk FOREIGN KEY (tenant_id,run_id) REFERENCES intel_legiwatch_report_run(tenant_id,id);
ALTER TABLE intel_legiwatch_delivery ADD CONSTRAINT report_delivery_subscription_fk FOREIGN KEY (tenant_id,subscription_id) REFERENCES intel_legiwatch_report_subscription(tenant_id,id);
ALTER TABLE intel_legiwatch_delivery ADD CONSTRAINT report_delivery_kind CHECK ((kind='bill_report' AND run_id IS NOT NULL) OR (kind='bill_record' AND run_id IS NULL));
ALTER TABLE intel_legiwatch_delivery_recipient ADD CONSTRAINT report_recipient_channel CHECK (channel IN ('email','in_app'));
ALTER TABLE intel_legiwatch_delivery_recipient ADD CONSTRAINT report_recipient_state CHECK (state IN ('queued','claimed','sending','provider_accepted','delivered','retryable','terminal','held','uncertain','canceled','suppressed'));
ALTER TABLE intel_legiwatch_record_rule ADD CONSTRAINT record_rule_cadence CHECK (cadence IN ('realtime','end_of_day'));
ALTER TABLE intel_legiwatch_record_rule ADD CONSTRAINT record_rule_activation CHECK (state<>'active' OR (activated_at IS NOT NULL AND cardinality(folder_ids)>0 AND jsonb_array_length(recipients)>0 AND jsonb_array_length(issues)=0));
ALTER TABLE intel_legiwatch_rule_bill_baseline ADD CONSTRAINT record_rule_baseline_fk FOREIGN KEY (tenant_id,rule_id) REFERENCES intel_legiwatch_record_rule(tenant_id,id);
ALTER TABLE intel_legiwatch_record_match ADD CONSTRAINT record_match_rule_fk FOREIGN KEY (tenant_id,rule_id) REFERENCES intel_legiwatch_record_rule(tenant_id,id);

CREATE FUNCTION legiwatch_report_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Report snapshots are immutable; generate a new run' USING ERRCODE='23514';
END $$;
CREATE TRIGGER report_snapshot_immutable BEFORE UPDATE OR DELETE ON intel_legiwatch_report_run FOR EACH ROW EXECUTE FUNCTION legiwatch_report_snapshot_immutable();

-- All reports in a tenant inherit folder read authorization; list membership,
-- however, has an independent captured private/public setting.
DROP POLICY intel_legiwatch_report_list_tenant ON intel_legiwatch_report_list;
CREATE POLICY report_list_read ON intel_legiwatch_report_list FOR SELECT USING (rls_bypass() OR (tenant_id=current_tenant_id()::text AND (NOT private OR owner_clerk_id=current_setting('app.folder_actor',true) OR current_setting('app.folder_admin',true)='on')));
CREATE POLICY report_list_insert ON intel_legiwatch_report_list FOR INSERT WITH CHECK (rls_bypass() OR (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting('app.folder_actor',true)));
CREATE POLICY report_list_update ON intel_legiwatch_report_list FOR UPDATE USING (rls_bypass() OR (tenant_id=current_tenant_id()::text AND (owner_clerk_id=current_setting('app.folder_actor',true) OR current_setting('app.folder_admin',true)='on'))) WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id()::text);
