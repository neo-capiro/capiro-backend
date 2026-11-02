BEGIN;
ALTER TABLE memory_settings_drafts DROP CONSTRAINT memory_settings_drafts_state_check;
ALTER TABLE memory_settings_drafts ADD CONSTRAINT memory_settings_drafts_state_check
  CHECK(state IN ('draft','discarded','expired','submitted'));
CREATE TABLE memory_settings_submissions (
  tenant_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  author_period_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  draft_id uuid NOT NULL,
  draft_revision integer NOT NULL CHECK(draft_revision>0),
  candidate_id uuid NOT NULL,
  type varchar(64) NOT NULL,
  slug varchar(128) NOT NULL,
  submitted_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,author_user_id,request_id),
  UNIQUE(tenant_id,draft_id),
  FOREIGN KEY(tenant_id,draft_id) REFERENCES memory_settings_drafts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,author_period_id) REFERENCES memory_retention_subjects(tenant_id,id) ON DELETE RESTRICT
);
-- candidate_id is deliberately content-free provenance, not a restrictive FK
-- that could stop an approved candidate retention purge.
ALTER TABLE memory_settings_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_settings_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_settings_submission_isolation ON memory_settings_submissions
 USING(rls_bypass() OR (tenant_id=current_tenant_id()
   AND author_user_id=nullif(current_setting('app.current_user',true),'')::uuid
   AND memory_retention_visible(tenant_id,author_period_id)))
 WITH CHECK(rls_bypass() OR (tenant_id=current_tenant_id()
   AND author_user_id=nullif(current_setting('app.current_user',true),'')::uuid
   AND memory_retention_visible(tenant_id,author_period_id)));
CREATE FUNCTION memory_settings_submission_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
DECLARE draft memory_settings_drafts%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'memory_submission_receipt_immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO draft FROM memory_settings_drafts WHERE tenant_id=NEW.tenant_id AND id=NEW.draft_id FOR SHARE;
  IF NOT FOUND OR draft.author_user_id<>NEW.author_user_id OR draft.state<>'submitted'
    OR draft.revision<>NEW.draft_revision+1 OR NOT EXISTS(SELECT 1 FROM memory_candidate c
      WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.candidate_id AND c.proposed_by=NEW.author_user_id
        AND c.status='pending' AND c.retention_subject_id=draft.owner_period_id) THEN
    RAISE EXCEPTION 'memory_submission_receipt_mismatch' USING ERRCODE='23514';
  END IF;
  NEW.author_period_id:=draft.author_period_id;NEW.type:=draft.type;NEW.slug:=draft.slug;
  NEW.submitted_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER memory_settings_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON memory_settings_submissions
 FOR EACH ROW EXECUTE FUNCTION memory_settings_submission_guard();
REVOKE ALL ON FUNCTION memory_settings_submission_guard() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
 GRANT SELECT,INSERT ON memory_settings_submissions TO capiro_app;
END IF; END $$;
COMMIT;
