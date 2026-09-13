ALTER TABLE intel_legiwatch_delivery DROP CONSTRAINT report_delivery_kind;
ALTER TABLE intel_legiwatch_delivery ADD CONSTRAINT report_delivery_kind CHECK
  ((kind='bill_report' AND run_id IS NOT NULL) OR (kind IN ('bill_record','agenda','live_update','hearing_recap') AND run_id IS NULL));
CREATE TABLE intel_hearing_publication (
  id text PRIMARY KEY, tenant_id text NOT NULL, session_id text NOT NULL, owner_clerk_id text NOT NULL,
  series_id text NOT NULL, version integer NOT NULL CHECK(version>0), kind text NOT NULL CHECK(kind IN ('live_update','hearing_recap')),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')), supersedes_id text,
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'), payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, approved_by text,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,series_id,version),
  FOREIGN KEY(tenant_id,session_id) REFERENCES intel_live_hearing_session(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,supersedes_id) REFERENCES intel_hearing_publication(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((status='draft' AND approved_at IS NULL AND approved_by IS NULL) OR
    (status='approved' AND approved_at IS NOT NULL AND approved_by IS NOT NULL))
);
CREATE INDEX intel_hearing_publication_session_idx ON intel_hearing_publication(tenant_id,session_id,created_at);
ALTER TABLE intel_hearing_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY hearing_publication_scope ON intel_hearing_publication USING (
  current_setting('app.bypass_rls',true)='on' OR (tenant_id=current_setting('app.current_tenant',true)
    AND owner_clerk_id=current_setting('app.folder_actor',true) AND hearing_recording_session_access(tenant_id,session_id))
) WITH CHECK (
  current_setting('app.bypass_rls',true)='on' OR (tenant_id=current_setting('app.current_tenant',true)
    AND owner_clerk_id=current_setting('app.folder_actor',true) AND hearing_recording_session_access(tenant_id,session_id))
);
GRANT SELECT,INSERT,UPDATE ON intel_hearing_publication TO capiro_app;
CREATE FUNCTION hearing_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.status='approved' OR
    (to_jsonb(OLD)-ARRAY['status','approved_at','approved_by']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['status','approved_at','approved_by'])) THEN
    RAISE EXCEPTION 'Publication versions are immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM intel_live_hearing_session s WHERE s.tenant_id=NEW.tenant_id
    AND s.id=NEW.session_id AND s.recording_policy <> 'no_storage') THEN
    RAISE EXCEPTION 'Publication persistence is unavailable for this session';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hearing_publication_immutable BEFORE INSERT OR UPDATE ON intel_hearing_publication
  FOR EACH ROW EXECUTE FUNCTION hearing_publication_immutable();
