-- Durable, coalesced refresh work; evidence and authorization remain Core-owned.
CREATE TABLE legiwatch_impact_refresh (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  bill_id text NOT NULL CHECK (length(bill_id) BETWEEN 3 AND 160),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','idle','failed')),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  claimed_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
  error_code text CHECK (error_code IN ('actor_unavailable','access_denied','analysis_unavailable','evidence_changed','refresh_failed','attempts_exhausted')),
  observed_fingerprint text,
  request_version bigint NOT NULL DEFAULT 1,
  force_refresh boolean NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,client_id,bill_id),
  FOREIGN KEY (tenant_id,client_id) REFERENCES clients(tenant_id,id) ON DELETE CASCADE,
  CHECK ((state='running' AND claim_token IS NOT NULL AND claimed_until IS NOT NULL)
    OR (state<>'running' AND claim_token IS NULL AND claimed_until IS NULL))
);
CREATE INDEX legiwatch_impact_refresh_due ON legiwatch_impact_refresh(next_check_at,tenant_id,client_id,bill_id);
ALTER TABLE legiwatch_impact_refresh ENABLE ROW LEVEL SECURITY;
ALTER TABLE legiwatch_impact_refresh FORCE ROW LEVEL SECURITY;
CREATE POLICY legiwatch_impact_refresh_scope ON legiwatch_impact_refresh
USING (rls_bypass() OR (
  tenant_id=current_tenant_id()
  AND EXISTS (SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=legiwatch_impact_refresh.tenant_id AND m.user_id=current_user_id()
      AND m.status::text='active' AND t.status::text='active'
      AND m.role::text IN ('standard_user','user_admin','capiro_admin'))
  AND EXISTS (SELECT 1 FROM clients c WHERE c.tenant_id=legiwatch_impact_refresh.tenant_id
    AND c.id=legiwatch_impact_refresh.client_id AND c.status<>'archived'
    AND (NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access a
      WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=current_user_id())))
));

-- A persisted keyset cursor ensures a bounded scan eventually reaches every tracker.
CREATE TABLE legiwatch_impact_refresh_scan (
  id text PRIMARY KEY CHECK (id='tracked'),
  tenant_cursor text NOT NULL DEFAULT '',
  client_cursor text NOT NULL DEFAULT '',
  bill_cursor text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO legiwatch_impact_refresh_scan(id) VALUES('tracked');
ALTER TABLE legiwatch_impact_refresh_scan ENABLE ROW LEVEL SECURITY;
ALTER TABLE legiwatch_impact_refresh_scan FORCE ROW LEVEL SECURITY;
CREATE POLICY legiwatch_impact_refresh_scan_system ON legiwatch_impact_refresh_scan USING (rls_bypass());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON legiwatch_impact_refresh TO capiro_app;
    GRANT SELECT,UPDATE ON legiwatch_impact_refresh_scan TO capiro_app;
  END IF;
END $$;
