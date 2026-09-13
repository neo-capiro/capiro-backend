ALTER TABLE intel_legiwatch_delivery DROP CONSTRAINT report_delivery_kind;
ALTER TABLE intel_legiwatch_delivery ADD CONSTRAINT report_delivery_kind CHECK
 ((kind='bill_report' AND run_id IS NOT NULL) OR (kind IN ('bill_record','agenda','live_update','hearing_recap','record_brief','record_correction','bill_keyword') AND run_id IS NULL));
CREATE TABLE intel_legiwatch_keyword_notified(tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,suggestion_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,owner_clerk_id,suggestion_id));
ALTER TABLE intel_legiwatch_keyword_notified ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_legiwatch_keyword_notified FORCE ROW LEVEL SECURITY;
CREATE POLICY keyword_notified_owner ON intel_legiwatch_keyword_notified USING(tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting('app.folder_actor',true));
GRANT SELECT,INSERT ON intel_legiwatch_keyword_notified TO capiro_app;
REVOKE UPDATE,DELETE,TRUNCATE ON intel_legiwatch_keyword_notified FROM capiro_app;
