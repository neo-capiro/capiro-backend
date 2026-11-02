-- Private editor bytes are separate from immutable published artifact versions.
CREATE TABLE meri_office_drafts (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES clio_conversations(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  base_version_id uuid NOT NULL,
  base_sha256 varchar(64) NOT NULL CHECK (base_sha256 ~ '^[0-9a-f]{64}$'),
  format varchar(4) NOT NULL CHECK (format IN ('docx','xlsx','pptx')),
  filename varchar(195) NOT NULL,
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  bytes bytea,
  sha256 varchar(64),
  state varchar(20) NOT NULL DEFAULT 'draft' CHECK (state IN
    ('draft','publish-pending','publish-unknown','publish-refused','conflict','published','discarded')),
  publish_intent varchar(128),
  published_version_id uuid,
  lock_token varchar(1024),
  lock_expires_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz(6) NOT NULL,
  PRIMARY KEY (tenant_id,actor_user_id,draft_id),
  CHECK ((state='discarded' AND bytes IS NULL AND sha256 IS NULL) OR
    (state<>'discarded' AND sequence=0 AND bytes IS NULL AND sha256 IS NULL) OR
    (state<>'discarded' AND sequence>0 AND bytes IS NOT NULL AND octet_length(bytes) BETWEEN 1 AND 20971520
     AND sha256 IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$')),
  CHECK ((lock_token IS NULL) = (lock_expires_at IS NULL)),
  CHECK ((state='published') = (published_version_id IS NOT NULL)),
  CHECK (state IN ('draft','publish-refused','conflict','discarded') OR publish_intent IS NOT NULL)
);
CREATE INDEX meri_office_draft_artifact_idx ON meri_office_drafts(tenant_id,artifact_id);
CREATE INDEX meri_office_draft_expiry_idx ON meri_office_drafts(expires_at);
ALTER TABLE meri_office_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_office_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY office_draft_isolation ON meri_office_drafts
  USING (rls_bypass() OR (tenant_id=current_tenant_id() AND
    actor_user_id=nullif(current_setting('app.current_user',true),'')::uuid))
  WITH CHECK (rls_bypass() OR (tenant_id=current_tenant_id() AND
    actor_user_id=nullif(current_setting('app.current_user',true),'')::uuid));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE ALL ON meri_office_drafts FROM capiro_app;
    GRANT SELECT,INSERT,DELETE ON meri_office_drafts TO capiro_app;
    GRANT UPDATE (sequence,bytes,sha256,state,publish_intent,published_version_id,
      lock_token,lock_expires_at,updated_at,expires_at) ON meri_office_drafts TO capiro_app;
  END IF;
END $$;
