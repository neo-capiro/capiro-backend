-- Snapshot exactly what the recipient was alerted about. No second ingestion of the change ledger.
CREATE TABLE district_nexus_alert_payload (
  notification_log_id UUID PRIMARY KEY REFERENCES notification_log(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  state_code VARCHAR(2) NOT NULL,
  district_code VARCHAR(8),
  payload JSONB NOT NULL
);
CREATE INDEX district_nexus_alert_payload_tenant_client_idx ON district_nexus_alert_payload(tenant_id, client_id);

ALTER TABLE district_nexus_alert_payload ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_nexus_alert_payload FORCE ROW LEVEL SECURITY;
CREATE POLICY district_nexus_alert_payload_tenant_isolation ON district_nexus_alert_payload
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
