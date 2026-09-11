ALTER TABLE intel_legiwatch_report_run ADD COLUMN generation_key TEXT;
CREATE UNIQUE INDEX intel_legiwatch_report_run_tenant_id_generation_key_key
  ON intel_legiwatch_report_run(tenant_id, generation_key);
ALTER TABLE intel_legiwatch_report_subscription ADD COLUMN catch_up_draft_pending BOOLEAN NOT NULL DEFAULT false;
