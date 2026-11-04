-- Extend the canonical facility owner; legacy provenance remains unknown.
ALTER TABLE client_facilities
  ADD COLUMN country varchar(2),
  ADD COLUMN site_role text,
  ADD COLUMN site_status text,
  ADD COLUMN site_verification_status text NOT NULL DEFAULT 'unverified',
  ADD COLUMN source_evidence_jsonb jsonb,
  ADD COLUMN source_observed_at timestamptz(6),
  ADD COLUMN geographic_resolution_jsonb jsonb,
  ADD COLUMN geographic_history_jsonb jsonb,
  ADD COLUMN verified_point_jsonb jsonb,
  ADD COLUMN economic_impact_jsonb jsonb;
ALTER TABLE client_facilities ADD CONSTRAINT client_facilities_site_verification_check
  CHECK (site_verification_status IN ('unverified', 'verified', 'proposed', 'closed'));
CREATE UNIQUE INDEX client_facilities_tenant_id_client_id_id_key ON client_facilities(tenant_id, client_id, id);
-- This uniqueness also supports capability-scoped tracking/relationship children.
CREATE UNIQUE INDEX IF NOT EXISTS client_capabilities_tenant_client_id_key ON client_capabilities(tenant_id, client_id, id);
CREATE TABLE client_facility_capabilities (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  facility_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT client_facility_capabilities_facility_fkey FOREIGN KEY(tenant_id, client_id, facility_id)
    REFERENCES client_facilities(tenant_id, client_id, id) ON DELETE CASCADE,
  CONSTRAINT client_facility_capabilities_capability_fkey FOREIGN KEY(tenant_id, client_id, capability_id)
    REFERENCES client_capabilities(tenant_id, client_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX client_facility_capabilities_facility_id_capability_id_key ON client_facility_capabilities(facility_id, capability_id);
CREATE INDEX client_facility_capabilities_tenant_id_client_id_idx ON client_facility_capabilities(tenant_id, client_id);
ALTER TABLE client_facility_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_facility_capabilities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_facility_capabilities
  USING (rls_bypass() OR (tenant_id = current_tenant_id() AND EXISTS (
    SELECT 1 FROM clients c WHERE c.id = client_facility_capabilities.client_id
      AND c.tenant_id = client_facility_capabilities.tenant_id
      AND (NOT c.memory_wall OR EXISTS (
        SELECT 1 FROM client_memory_access a
        WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id AND a.user_id = current_user_id()
      ))
  )))
  WITH CHECK (rls_bypass() OR (tenant_id = current_tenant_id() AND EXISTS (
    SELECT 1 FROM clients c WHERE c.id = client_facility_capabilities.client_id
      AND c.tenant_id = client_facility_capabilities.tenant_id
      AND (NOT c.memory_wall OR EXISTS (
        SELECT 1 FROM client_memory_access a
        WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id AND a.user_id = current_user_id()
      ))
  )));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_facility_capabilities TO capiro_app;
  END IF;
END $$;

