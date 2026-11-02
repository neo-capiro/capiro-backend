-- Office custody's permanent disposal marker. The existing Meri retention owner
-- decides when to erase; this contains no policy, authorization or draft content.
-- Keep it after draft expiry: delayed Open must not recreate erased custody.
CREATE TABLE meri_office_disposed_subjects (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('conversation','artifact')),
  subject_id uuid NOT NULL,
  disposed_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,subject_kind,subject_id)
);
ALTER TABLE meri_office_disposed_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_office_disposed_subjects FORCE ROW LEVEL SECURITY;
CREATE POLICY office_disposal_read ON meri_office_disposed_subjects FOR SELECT
  USING (rls_bypass() OR tenant_id=current_tenant_id());
CREATE POLICY office_disposal_insert ON meri_office_disposed_subjects FOR INSERT
  WITH CHECK (rls_bypass());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE ALL ON meri_office_disposed_subjects FROM capiro_app;
    GRANT SELECT,INSERT ON meri_office_disposed_subjects TO capiro_app;
  END IF;
END $$;
