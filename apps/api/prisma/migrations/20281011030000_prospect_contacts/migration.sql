-- SOURCE-ONLY / UNAPPLIED. Root allocation: 20281011030000, after prospect stages.
-- Exact proposal from preserved PR2371; never run against shared databases.
-- Requires existing Phase 4 (tenant_id,id) unique key on business_development_prospects.
CREATE TABLE business_development_prospect_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL,
  request_id uuid NOT NULL,
  create_hash char(64) NOT NULL CHECK (create_hash ~ '^[a-f0-9]{64}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  title text CHECK (length(title) <= 300),
  email text CHECK (length(email) <= 320),
  phone text CHECK (length(phone) <= 120),
  notes text CHECK (length(notes) <= 4000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  removed_at timestamptz,
  created_by_user_id uuid NOT NULL,
  updated_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prospect_contacts_prospect_fkey FOREIGN KEY (tenant_id,prospect_id)
    REFERENCES business_development_prospects(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT prospect_contacts_request_key UNIQUE (tenant_id,prospect_id,request_id)
);
CREATE INDEX prospect_contacts_active_idx ON business_development_prospect_contacts(tenant_id,prospect_id,id)
  WHERE removed_at IS NULL;
ALTER TABLE business_development_prospect_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_development_prospect_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY prospect_contacts_isolation ON business_development_prospect_contacts
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON business_development_prospect_contacts TO capiro_app;
