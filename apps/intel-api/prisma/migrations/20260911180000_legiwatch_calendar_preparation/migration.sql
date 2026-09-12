ALTER TABLE intel_legiwatch_record_rule ADD COLUMN family text NOT NULL DEFAULT 'bill_record';
ALTER TABLE intel_legiwatch_record_rule ADD CONSTRAINT intel_legiwatch_rule_family_chk CHECK (family IN ('bill_record','agenda'));
ALTER TABLE intel_legiwatch_delivery DROP CONSTRAINT report_delivery_kind;
ALTER TABLE intel_legiwatch_delivery ADD CONSTRAINT report_delivery_kind CHECK
  ((kind='bill_report' AND run_id IS NOT NULL) OR (kind IN ('bill_record','agenda') AND run_id IS NULL));
CREATE TABLE intel_legiwatch_preparation_snapshot (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  owner_clerk_id text NOT NULL,
  hearing_id text NOT NULL,
  calendar_revision integer NOT NULL CHECK (calendar_revision >= 0),
  folder_ids text[] NOT NULL,
  payload jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id,id)
);
CREATE INDEX intel_legiwatch_prep_owner_idx ON intel_legiwatch_preparation_snapshot(tenant_id,hearing_id,owner_clerk_id);
ALTER TABLE intel_legiwatch_preparation_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_legiwatch_preparation_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY prep_actor ON intel_legiwatch_preparation_snapshot FOR ALL
  USING (tenant_id = current_tenant_id()::text AND owner_clerk_id = current_setting('app.folder_actor',true))
  WITH CHECK (tenant_id = current_tenant_id()::text AND owner_clerk_id = current_setting('app.folder_actor',true));
CREATE TRIGGER preparation_snapshot_immutable BEFORE UPDATE OR DELETE ON intel_legiwatch_preparation_snapshot
  FOR EACH ROW EXECUTE FUNCTION legiwatch_report_snapshot_immutable();
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT, INSERT ON intel_legiwatch_preparation_snapshot TO capiro_app;
  END IF;
END $$;
