-- Client-specific interpretation is private; public bill revisions remain canonical.
CREATE TABLE legiwatch_client_bill_analysis (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  bill_id text NOT NULL CHECK (length(bill_id) BETWEEN 3 AND 160),
  analysis_jsonb jsonb,
  analyzed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  position text CHECK (position IN ('support','oppose','monitor')),
  priority text CHECK (priority IN ('low','med','high')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,client_id,bill_id),
  FOREIGN KEY (tenant_id,client_id) REFERENCES clients(tenant_id,id) ON DELETE CASCADE,
  CHECK (analysis_jsonb IS NULL OR jsonb_typeof(analysis_jsonb)='object')
);
ALTER TABLE legiwatch_client_bill_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE legiwatch_client_bill_analysis FORCE ROW LEVEL SECURITY;
CREATE POLICY legiwatch_client_impact_scope ON legiwatch_client_bill_analysis
USING (rls_bypass() OR (
  tenant_id=current_tenant_id()
  AND EXISTS (SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=legiwatch_client_bill_analysis.tenant_id AND m.user_id=current_user_id()
      AND m.status::text='active' AND t.status::text='active'
      AND m.role::text IN ('standard_user','user_admin','capiro_admin'))
  AND EXISTS (SELECT 1 FROM clients c WHERE c.tenant_id=legiwatch_client_bill_analysis.tenant_id
    AND c.id=legiwatch_client_bill_analysis.client_id AND c.status<>'archived'
    AND (NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access a
      WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=current_user_id())))
));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON legiwatch_client_bill_analysis TO capiro_app;
  END IF;
END $$;
