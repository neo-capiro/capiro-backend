-- Private Capiro assessments reference API-owned public source revisions.
CREATE TABLE intel_hearing_record_run (
  id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,event_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),UNIQUE(tenant_id,owner_clerk_id,event_id,input_hash)
);
CREATE TABLE intel_hearing_record_assessment (
  id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,run_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,claim_hash TEXT NOT NULL,outcome TEXT NOT NULL,payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(run_id,claim_id),
  FOREIGN KEY(tenant_id,run_id) REFERENCES intel_hearing_record_run(tenant_id,id) ON DELETE RESTRICT,
  CHECK(outcome IN ('supported','partially_supported','contradicted','not_addressed','pending_records','needs_review','capiro_analysis'))
);
CREATE TABLE intel_hearing_record_review (
  id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,run_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,claim_hash TEXT NOT NULL,outcome TEXT NOT NULL,payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,run_id) REFERENCES intel_hearing_record_run(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,assessment_id) REFERENCES intel_hearing_record_assessment(tenant_id,id) ON DELETE RESTRICT,
  CHECK(outcome IN ('supported','partially_supported','contradicted','not_addressed','pending_records','needs_review','capiro_analysis'))
);
CREATE TABLE intel_hearing_record_brief (
  id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,event_id TEXT NOT NULL,
  run_id TEXT NOT NULL,series_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),supersedes_id TEXT,
  client_id TEXT,content_hash TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),UNIQUE(tenant_id,owner_clerk_id,series_id,version),
  FOREIGN KEY(tenant_id,run_id) REFERENCES intel_hearing_record_run(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,supersedes_id) REFERENCES intel_hearing_record_brief(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE intel_hearing_record_brief_review (
  id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,brief_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,source_hash TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,brief_id,content_hash,source_hash),
  FOREIGN KEY(tenant_id,brief_id) REFERENCES intel_hearing_record_brief(tenant_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION hearing_record_private_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'HEARING_RECORD_VERSION_IMMUTABLE'; END $$;
DO $$ DECLARE name TEXT; BEGIN
  FOREACH name IN ARRAY ARRAY['intel_hearing_record_run','intel_hearing_record_assessment','intel_hearing_record_review','intel_hearing_record_brief','intel_hearing_record_brief_review'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY record_owner ON %I USING (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true)) WITH CHECK (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting(''app.folder_actor'',true))',name);
    EXECUTE format('GRANT SELECT,INSERT ON %I TO capiro_app',name);
    EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM capiro_app',name);
    EXECUTE format('CREATE TRIGGER record_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION hearing_record_private_immutable()',name);
  END LOOP;
END $$;
