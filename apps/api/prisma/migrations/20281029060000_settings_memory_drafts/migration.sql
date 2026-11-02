-- Private staging only. No draft is a recall source or an approval candidate.
-- Retain content-free identities after erasure so delayed writes cannot revive it.
BEGIN;
CREATE TABLE memory_settings_drafts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  author_period_id uuid NOT NULL,
  owner_period_id uuid NOT NULL,
  type varchar(64) NOT NULL,
  slug varchar(128) NOT NULL,
  scope varchar(12) NOT NULL CHECK(scope IN ('user','client','firm')),
  client_id uuid,
  base_item_id uuid,
  base_version varchar(64),
  revision integer NOT NULL CHECK(revision>0),
  state varchar(16) NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','discarded','expired')),
  sections jsonb,
  legal_hold boolean NOT NULL DEFAULT false,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz(6) NOT NULL,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,author_period_id) REFERENCES memory_retention_subjects(tenant_id,id),
  FOREIGN KEY(tenant_id,owner_period_id) REFERENCES memory_retention_subjects(tenant_id,id),
  CHECK ((scope='client')=(client_id IS NOT NULL)),
  CHECK ((base_item_id IS NULL)=(base_version IS NULL)),
  CHECK(base_version IS NULL OR base_version ~ '^[a-f0-9]{64}$'),
  CHECK(expires_at=created_at+interval '720 hours'),
  CHECK((state='draft' AND sections IS NOT NULL AND jsonb_typeof(sections)='array')
    OR (state<>'draft' AND sections IS NULL))
);
CREATE INDEX memory_settings_drafts_owner ON memory_settings_drafts(tenant_id,author_user_id,type,slug);
CREATE INDEX memory_settings_drafts_expiry ON memory_settings_drafts(expires_at) WHERE state='draft';

CREATE TABLE memory_settings_draft_receipts (
  tenant_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  author_period_id uuid NOT NULL,
  request_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  type varchar(64) NOT NULL,
  slug varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK(revision>0),
  state varchar(16) NOT NULL CHECK(state IN ('draft','discarded')),
  recorded_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,author_user_id,request_id),
  FOREIGN KEY(tenant_id,draft_id) REFERENCES memory_settings_drafts(tenant_id,id),
  FOREIGN KEY(tenant_id,author_period_id) REFERENCES memory_retention_subjects(tenant_id,id)
);

CREATE FUNCTION memory_settings_draft_live(p_tenant uuid,p_author uuid,p_author_period uuid,p_owner_period uuid,p_client uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p_tenant=current_tenant_id()
   AND p_author=nullif(current_setting('app.current_user',true),'')::uuid
   AND memory_retention_visible(p_tenant,p_author_period)
   AND memory_retention_visible(p_tenant,p_owner_period)
   AND (p_client IS NULL OR EXISTS(SELECT 1 FROM clients c WHERE c.tenant_id=p_tenant AND c.id=p_client
     AND c.status='active' AND (NOT c.memory_wall OR EXISTS(SELECT 1 FROM client_memory_access a
       WHERE a.tenant_id=p_tenant AND a.client_id=p_client AND a.user_id=p_author))))
$$;
ALTER TABLE memory_settings_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_settings_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_settings_drafts_isolation ON memory_settings_drafts
 USING(rls_bypass() OR (memory_settings_draft_live(tenant_id,author_user_id,author_period_id,owner_period_id,client_id)
   AND (state<>'draft' OR expires_at>clock_timestamp())))
 WITH CHECK(rls_bypass() OR memory_settings_draft_live(tenant_id,author_user_id,author_period_id,owner_period_id,client_id));
ALTER TABLE memory_settings_draft_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_settings_draft_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_settings_draft_receipts_isolation ON memory_settings_draft_receipts
 USING(rls_bypass() OR (tenant_id=current_tenant_id()
   AND author_user_id=nullif(current_setting('app.current_user',true),'')::uuid
   AND memory_retention_visible(tenant_id,author_period_id)))
 WITH CHECK(rls_bypass() OR (tenant_id=current_tenant_id()
   AND author_user_id=nullif(current_setting('app.current_user',true),'')::uuid
   AND memory_retention_visible(tenant_id,author_period_id)));

CREATE FUNCTION memory_settings_draft_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
DECLARE author_period uuid; owner_period uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'memory_draft_identity_retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['sections','revision','state','updated_at','legal_hold']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['sections','revision','state','updated_at','legal_hold']) THEN
      RAISE EXCEPTION 'memory_draft_binding_immutable' USING ERRCODE='23514';
    END IF;
    -- A privileged hold change cannot extend expiry or change payload.
    IF (to_jsonb(NEW)-ARRAY['legal_hold','updated_at'])=(to_jsonb(OLD)-ARRAY['legal_hold','updated_at']) THEN RETURN NEW; END IF;
    IF OLD.legal_hold OR NEW.legal_hold IS DISTINCT FROM OLD.legal_hold THEN
      RAISE EXCEPTION 'memory_draft_held' USING ERRCODE='23514';
    END IF;
    IF OLD.state<>'draft' OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'memory_draft_revision_conflict' USING ERRCODE='23514';
    END IF;
    IF NEW.state='expired' AND rls_bypass() AND OLD.expires_at<=clock_timestamp() THEN
      NEW.sections:=NULL; NEW.updated_at:=clock_timestamp(); RETURN NEW;
    END IF;
    IF OLD.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'memory_draft_expired' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.revision<>1 OR NEW.state<>'draft' OR NEW.legal_hold THEN
      RAISE EXCEPTION 'memory_draft_initial_state' USING ERRCODE='23514';
    END IF;
    NEW.created_at:=clock_timestamp(); NEW.expires_at:=NEW.created_at+interval '720 hours';
  END IF;
  author_period:=memory_retention_current_period(NEW.tenant_id,'personal',NEW.author_user_id);
  owner_period:=memory_retention_current_period(NEW.tenant_id,
    CASE NEW.scope WHEN 'user' THEN 'personal' WHEN 'client' THEN 'client' ELSE 'firm' END,
    CASE NEW.scope WHEN 'user' THEN NEW.author_user_id WHEN 'client' THEN NEW.client_id ELSE NEW.tenant_id END);
  IF TG_OP='UPDATE' AND (OLD.author_period_id<>author_period OR OLD.owner_period_id<>owner_period) THEN
    RAISE EXCEPTION 'memory_draft_owner_closed' USING ERRCODE='23514';
  END IF;
  NEW.author_period_id:=author_period; NEW.owner_period_id:=owner_period; NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER memory_settings_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON memory_settings_drafts
 FOR EACH ROW EXECUTE FUNCTION memory_settings_draft_guard();

CREATE FUNCTION memory_settings_draft_receipt_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
DECLARE draft memory_settings_drafts%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'memory_draft_receipt_immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO draft FROM memory_settings_drafts WHERE tenant_id=NEW.tenant_id AND id=NEW.draft_id FOR SHARE;
  IF NOT FOUND OR draft.author_user_id<>NEW.author_user_id OR draft.revision<>NEW.revision OR draft.state<>NEW.state THEN
    RAISE EXCEPTION 'memory_draft_receipt_mismatch' USING ERRCODE='23514';
  END IF;
  NEW.author_period_id:=draft.author_period_id; NEW.type:=draft.type; NEW.slug:=draft.slug;
  NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER memory_settings_draft_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON memory_settings_draft_receipts
 FOR EACH ROW EXECUTE FUNCTION memory_settings_draft_receipt_guard();
REVOKE ALL ON FUNCTION memory_settings_draft_guard(), memory_settings_draft_receipt_guard() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
 GRANT SELECT,INSERT ON memory_settings_drafts, memory_settings_draft_receipts TO capiro_app;
 GRANT UPDATE(sections,revision,state,updated_at) ON memory_settings_drafts TO capiro_app;
END IF; END $$;
COMMIT;
