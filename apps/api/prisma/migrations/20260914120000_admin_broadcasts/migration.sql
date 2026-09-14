-- Capiro-staff broadcasts to a tenant's users, with per-recipient
-- acknowledgement. Recipients are snapshotted at send time so the roster is
-- exact; archiving withdraws a broadcast from anyone who has not acknowledged.
CREATE TYPE "admin_broadcast_audience" AS ENUM ('all_users', 'selected_users');

CREATE TABLE admin_broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  audience "admin_broadcast_audience" NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_broadcasts_tenant_created_idx ON admin_broadcasts (tenant_id, created_at);
ALTER TABLE admin_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_broadcasts_isolation ON admin_broadcasts
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

CREATE TABLE admin_broadcast_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL REFERENCES admin_broadcasts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_broadcast_recipients_broadcast_user_unique UNIQUE (broadcast_id, user_id)
);
CREATE INDEX admin_broadcast_recipients_pending_idx
  ON admin_broadcast_recipients (tenant_id, user_id, acknowledged_at);
ALTER TABLE admin_broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_broadcast_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_broadcast_recipients_isolation ON admin_broadcast_recipients
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON admin_broadcasts, admin_broadcast_recipients TO capiro_app;
  END IF;
END $$;
