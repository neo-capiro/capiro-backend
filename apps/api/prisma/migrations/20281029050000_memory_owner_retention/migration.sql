-- Memory ownership is independent of the author and of a conversation citation.
-- Closed periods are permanent. Rejoining/reopening creates a new period; it
-- never changes the ownership binding of existing content. No payload is kept
-- in this table. Full-backup reconciliation still belongs to external retention.
BEGIN;
LOCK TABLE tenants, tenant_memberships, clients, memory_candidate, memory_items,
  clio_memory IN EXCLUSIVE MODE;

CREATE TABLE memory_retention_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_kind varchar(16) NOT NULL CHECK (owner_kind IN ('personal','client','firm')),
  owner_id uuid NOT NULL,
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version=1),
  opened_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz(6),
  purge_after timestamptz(6),
  closed_reason varchar(32),
  UNIQUE(tenant_id,id),
  CHECK (((closed_at IS NULL AND purge_after IS NULL AND closed_reason IS NULL)
    OR (closed_at IS NOT NULL AND closed_reason IS NOT NULL AND
      ((owner_kind='personal' AND purge_after=closed_at+interval '720 hours')
       OR (owner_kind='client' AND purge_after=closed_at+interval '2160 hours')
       OR (owner_kind='firm' AND purge_after IS NULL)))) IS TRUE)
);
CREATE UNIQUE INDEX memory_retention_one_open_owner ON memory_retention_subjects(tenant_id,owner_kind,owner_id)
  WHERE closed_at IS NULL;
CREATE INDEX memory_retention_due ON memory_retention_subjects(purge_after) WHERE purge_after IS NOT NULL;
ALTER TABLE memory_retention_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_retention_subjects FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_retention_subject_isolation ON memory_retention_subjects
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());

-- Physical cleanup keeps only the identity needed to refuse a late replay.
-- The period is the policy owner; this is the content-free deletion outcome.
CREATE TABLE memory_retention_tombstones (
  tenant_id uuid NOT NULL,
  store varchar(24) NOT NULL CHECK (store IN ('memory_items','memory_candidate','clio_memory')),
  row_id uuid NOT NULL,
  retention_subject_id uuid,
  purged_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,store,row_id),
  FOREIGN KEY(tenant_id,retention_subject_id) REFERENCES memory_retention_subjects(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE memory_retention_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_retention_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_retention_tombstone_isolation ON memory_retention_tombstones
  USING(rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK(rls_bypass() OR tenant_id=current_tenant_id());

ALTER TABLE memory_items ADD COLUMN retention_subject_id uuid;
ALTER TABLE memory_candidate ADD COLUMN retention_subject_id uuid;
ALTER TABLE clio_memory ADD COLUMN retention_subject_id uuid;
ALTER TABLE memory_items ADD CONSTRAINT memory_items_retention_subject_fk
  FOREIGN KEY(tenant_id,retention_subject_id) REFERENCES memory_retention_subjects(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_retention_subject_fk
  FOREIGN KEY(tenant_id,retention_subject_id) REFERENCES memory_retention_subjects(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE clio_memory ADD CONSTRAINT clio_memory_retention_subject_fk
  FOREIGN KEY(tenant_id,retention_subject_id) REFERENCES memory_retention_subjects(tenant_id,id) ON DELETE RESTRICT;
CREATE INDEX memory_items_retention_subject ON memory_items(tenant_id,retention_subject_id);
CREATE INDEX memory_candidate_retention_subject ON memory_candidate(tenant_id,retention_subject_id);
CREATE INDEX clio_memory_retention_subject ON clio_memory(tenant_id,retention_subject_id);

CREATE FUNCTION memory_retention_identity(p_table text, p_row jsonb)
RETURNS TABLE(owner_kind text, owner_id uuid) LANGUAGE plpgsql IMMUTABLE
SET search_path=public,pg_temp AS $$
BEGIN
  IF p_table='memory_items' THEN
    IF p_row->>'visibility'='user' AND p_row->>'owner_user_id' IS NOT NULL THEN
      RETURN QUERY SELECT 'personal'::text,(p_row->>'owner_user_id')::uuid;
    ELSIF p_row->>'visibility'='tenant' AND p_row->>'owner_user_id' IS NULL THEN
      RETURN QUERY SELECT CASE WHEN p_row->>'client_id' IS NULL THEN 'firm' ELSE 'client' END,
        coalesce(p_row->>'client_id',p_row->>'tenant_id')::uuid;
    END IF;
  ELSIF p_table='memory_candidate' THEN
    IF p_row->>'scope'='personal' AND p_row->>'proposed_by' IS NOT NULL THEN
      RETURN QUERY SELECT 'personal'::text,(p_row->>'proposed_by')::uuid;
    ELSIF p_row->>'scope'='client' AND p_row->>'client_id' IS NOT NULL THEN
      RETURN QUERY SELECT 'client'::text,(p_row->>'client_id')::uuid;
    ELSIF p_row->>'scope'='firm' AND p_row->>'client_id' IS NULL THEN
      RETURN QUERY SELECT 'firm'::text,(p_row->>'tenant_id')::uuid;
    END IF;
  ELSIF p_table='clio_memory' THEN
    IF p_row->>'scope'='user_private' AND p_row->>'owner_user_id' IS NOT NULL THEN
      RETURN QUERY SELECT 'personal'::text,(p_row->>'owner_user_id')::uuid;
    ELSIF p_row->>'owner_user_id' IS NULL AND p_row->>'scope'='client' AND p_row->>'client_id' IS NOT NULL THEN
      RETURN QUERY SELECT 'client'::text,(p_row->>'client_id')::uuid;
    ELSIF p_row->>'owner_user_id' IS NULL AND p_row->>'scope'='firm' AND p_row->>'client_id' IS NULL THEN
      RETURN QUERY SELECT 'firm'::text,(p_row->>'tenant_id')::uuid;
    END IF;
  END IF;
END $$;

-- Scope locks serialize a memory write with a removal/closure. A user who loses
-- a client wall grant loses access through existing Core wall authorization;
-- the client's shared retention period is deliberately not closed by that event.
CREATE FUNCTION memory_retention_current_period(p_tenant uuid,p_kind text,p_owner uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result uuid;
BEGIN
  PERFORM id FROM tenants WHERE id=p_tenant AND status::text='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'memory_owner_unavailable' USING ERRCODE='23514'; END IF;
  IF p_kind='personal' THEN
    PERFORM id FROM tenant_memberships WHERE tenant_id=p_tenant AND user_id=p_owner AND status::text='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'memory_owner_unavailable' USING ERRCODE='23514'; END IF;
  ELSIF p_kind='client' THEN
    PERFORM id FROM clients WHERE tenant_id=p_tenant AND id=p_owner AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'memory_owner_unavailable' USING ERRCODE='23514'; END IF;
  ELSIF p_kind<>'firm' OR p_owner<>p_tenant THEN
    RAISE EXCEPTION 'memory_ownership_invalid' USING ERRCODE='23514';
  END IF;
  SELECT id INTO result FROM memory_retention_subjects
    WHERE tenant_id=p_tenant AND owner_kind=p_kind AND owner_id=p_owner AND closed_at IS NULL;
  IF result IS NULL THEN
    INSERT INTO memory_retention_subjects(tenant_id,owner_kind,owner_id) VALUES(p_tenant,p_kind,p_owner)
      ON CONFLICT(tenant_id,owner_kind,owner_id) WHERE closed_at IS NULL DO NOTHING RETURNING id INTO result;
    IF result IS NULL THEN SELECT id INTO result FROM memory_retention_subjects
      WHERE tenant_id=p_tenant AND owner_kind=p_kind AND owner_id=p_owner AND closed_at IS NULL; END IF;
  END IF;
  RETURN result;
END $$;

-- Legacy attribution uses only explicit owner/scope columns. Inactive, missing
-- or contradictory owners remain NULL (restricted); no removal date is guessed
-- from updated_at or from citations. Attribution is not an approval of content.
DO $$ DECLARE table_name text; row_value record; period uuid;
BEGIN
  PERFORM set_config('app.bypass_rls','on',true);
  FOREACH table_name IN ARRAY ARRAY['clio_memory','memory_items','memory_candidate'] LOOP
    FOR row_value IN EXECUTE format('SELECT r.id,r.tenant_id,i.owner_kind,i.owner_id FROM %I r
      CROSS JOIN LATERAL memory_retention_identity(%L,to_jsonb(r)) i',table_name,table_name) LOOP
      BEGIN
        period:=memory_retention_current_period(row_value.tenant_id,row_value.owner_kind,row_value.owner_id);
        EXECUTE format('UPDATE %I SET retention_subject_id=$1 WHERE tenant_id=$2 AND id=$3',table_name)
          USING period,row_value.tenant_id,row_value.id;
      EXCEPTION WHEN check_violation THEN NULL; END;
    END LOOP;
  END LOOP;
END $$;

-- A typed projection/version reference must agree with the explicitly attributed
-- owner. A contradictory legacy source is restricted, never relabelled as firm.
UPDATE memory_items item SET retention_subject_id=NULL
WHERE item.slug LIKE 'clio:%' AND NOT EXISTS(SELECT 1 FROM clio_memory source
  WHERE source.tenant_id=item.tenant_id AND item.slug='clio:'||source.id::text
    AND source.retention_subject_id=item.retention_subject_id);
UPDATE memory_candidate candidate SET retention_subject_id=NULL
WHERE candidate.payload_jsonb->'versionProposal'->>'sourceItemId' IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM memory_items source WHERE source.tenant_id=candidate.tenant_id
    AND source.id::text=candidate.payload_jsonb->'versionProposal'->>'sourceItemId'
    AND source.retention_subject_id=candidate.retention_subject_id);

CREATE FUNCTION memory_retention_bind_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE identity record; prior_identity record; period uuid; source_period uuid; body jsonb;
BEGIN
  body:=to_jsonb(NEW);
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM memory_retention_tombstones
    WHERE tenant_id=NEW.tenant_id AND store=TG_TABLE_NAME AND row_id=NEW.id) THEN
    RAISE EXCEPTION 'memory_content_purged' USING ERRCODE='23514';
  END IF;
  SELECT * INTO prior_identity FROM memory_retention_identity(TG_TABLE_NAME,body);
  IF TG_OP='UPDATE' THEN
    IF NEW.id<>OLD.id THEN
      RAISE EXCEPTION 'memory_identity_immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.retention_subject_id IS DISTINCT FROM OLD.retention_subject_id THEN
      RAISE EXCEPTION 'memory_ownership_rebinding_refused' USING ERRCODE='23514';
    END IF;
    -- A hold can be applied or released by the existing trusted governance owner
    -- after suppression, without reopening content or changing its deadline.
    IF body ? 'legal_hold' AND body-ARRAY['legal_hold','updated_at'] = to_jsonb(OLD)-ARRAY['legal_hold','updated_at']
      THEN RETURN NEW; END IF;
    -- FK SET NULL cleanup is content-free and must remain possible on restricted
    -- and expired candidates. Every content/workflow/ownership field stays fixed.
    IF TG_TABLE_NAME='memory_candidate' AND
       body-ARRAY['committed_memory_item_id','duplicate_memory_item_id','contradicts_memory_item_id','duplicate_of_id'] =
       to_jsonb(OLD)-ARRAY['committed_memory_item_id','duplicate_memory_item_id','contradicts_memory_item_id','duplicate_of_id'] AND
       (body->>'committed_memory_item_id' IS NULL OR body->>'committed_memory_item_id'=to_jsonb(OLD)->>'committed_memory_item_id') AND
       (body->>'duplicate_memory_item_id' IS NULL OR body->>'duplicate_memory_item_id'=to_jsonb(OLD)->>'duplicate_memory_item_id') AND
       (body->>'contradicts_memory_item_id' IS NULL OR body->>'contradicts_memory_item_id'=to_jsonb(OLD)->>'contradicts_memory_item_id') AND
       (body->>'duplicate_of_id' IS NULL OR body->>'duplicate_of_id'=to_jsonb(OLD)->>'duplicate_of_id') THEN RETURN NEW; END IF;
    IF OLD.retention_subject_id IS NULL THEN
      RAISE EXCEPTION 'memory_ownership_restricted' USING ERRCODE='23514';
    END IF;
    SELECT * INTO prior_identity FROM memory_retention_identity(TG_TABLE_NAME,to_jsonb(OLD));
  END IF;
  SELECT * INTO identity FROM memory_retention_identity(TG_TABLE_NAME,body);
  IF identity.owner_kind IS NULL OR identity.owner_id IS NULL OR
    (TG_OP='UPDATE' AND (identity.owner_kind IS DISTINCT FROM prior_identity.owner_kind OR
      identity.owner_id IS DISTINCT FROM prior_identity.owner_id OR NEW.tenant_id<>OLD.tenant_id)) THEN
    RAISE EXCEPTION 'memory_ownership_invalid' USING ERRCODE='23514';
  END IF;
  period:=memory_retention_current_period(NEW.tenant_id,identity.owner_kind,identity.owner_id);
  IF TG_TABLE_NAME='memory_items' AND body->>'slug' LIKE 'clio:%' THEN
    SELECT retention_subject_id INTO source_period FROM clio_memory
      WHERE tenant_id=NEW.tenant_id AND 'clio:'||id::text=body->>'slug';
    IF source_period IS DISTINCT FROM period THEN
      RAISE EXCEPTION 'memory_source_ownership_refused' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME='memory_candidate' AND body->'payload_jsonb'->'versionProposal'->>'sourceItemId' IS NOT NULL THEN
    SELECT retention_subject_id INTO source_period FROM memory_items
      WHERE tenant_id=NEW.tenant_id AND id::text=body->'payload_jsonb'->'versionProposal'->>'sourceItemId';
    IF source_period IS DISTINCT FROM period THEN
      RAISE EXCEPTION 'memory_source_ownership_refused' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.retention_subject_id IS NOT NULL AND NEW.retention_subject_id<>period THEN
    RAISE EXCEPTION 'memory_ownership_closed' USING ERRCODE='23514';
  END IF;
  NEW.retention_subject_id:=period;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_items_bind_retention BEFORE INSERT OR UPDATE ON memory_items
  FOR EACH ROW EXECUTE FUNCTION memory_retention_bind_row();
CREATE TRIGGER memory_candidate_bind_retention BEFORE INSERT OR UPDATE ON memory_candidate
  FOR EACH ROW EXECUTE FUNCTION memory_retention_bind_row();
CREATE TRIGGER clio_memory_bind_retention BEFORE INSERT OR UPDATE ON clio_memory
  FOR EACH ROW EXECUTE FUNCTION memory_retention_bind_row();

CREATE FUNCTION memory_retention_record_deletion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
BEGIN
  IF to_jsonb(OLD)->>'legal_hold'='true' OR (TG_TABLE_NAME='clio_memory' AND (
    EXISTS(SELECT 1 FROM memory_items WHERE tenant_id=OLD.tenant_id AND slug='clio:'||OLD.id::text AND legal_hold=true)
    OR EXISTS(SELECT 1 FROM memory_candidate WHERE tenant_id=OLD.tenant_id AND committed_memory_id=OLD.id AND legal_hold=true))) THEN
    RAISE EXCEPTION 'memory_legal_hold' USING ERRCODE='23514';
  END IF;
  INSERT INTO memory_retention_tombstones(tenant_id,store,row_id,retention_subject_id)
    VALUES(OLD.tenant_id,TG_TABLE_NAME,OLD.id,OLD.retention_subject_id) ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER memory_items_retention_deletion BEFORE DELETE ON memory_items
  FOR EACH ROW EXECUTE FUNCTION memory_retention_record_deletion();
CREATE TRIGGER memory_candidate_retention_deletion BEFORE DELETE ON memory_candidate
  FOR EACH ROW EXECUTE FUNCTION memory_retention_record_deletion();
CREATE TRIGGER clio_memory_retention_deletion BEFORE DELETE ON clio_memory
  FOR EACH ROW EXECUTE FUNCTION memory_retention_record_deletion();

CREATE FUNCTION memory_retention_close_owner() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE ended timestamptz:=clock_timestamp(); kind text; owner uuid; tenant uuid; reason text;
BEGIN
  IF TG_TABLE_NAME='tenant_memberships' THEN
    IF TG_OP='UPDATE' AND (NEW.status::text<>'removed' OR OLD.status::text='removed') THEN RETURN NEW; END IF;
    kind:='personal'; owner:=OLD.user_id; tenant:=OLD.tenant_id; reason:='offboarding';
  ELSIF TG_TABLE_NAME='clients' THEN
    IF TG_OP='UPDATE' AND (NEW.status<>'archived' OR OLD.status='archived') THEN RETURN NEW; END IF;
    kind:='client'; owner:=OLD.id; tenant:=OLD.tenant_id; reason:='client_closure';
  ELSE
    RAISE EXCEPTION 'memory_owner_transition_invalid' USING ERRCODE='23514';
  END IF;
  UPDATE memory_retention_subjects SET closed_at=ended,
    purge_after=ended+CASE WHEN kind='personal' THEN interval '720 hours' ELSE interval '2160 hours' END,
    closed_reason=reason
    WHERE tenant_id=tenant AND owner_kind=kind AND owner_id=owner AND closed_at IS NULL;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_close_memory_retention AFTER UPDATE OF status OR DELETE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION memory_retention_close_owner();
CREATE TRIGGER client_close_memory_retention AFTER UPDATE OF status OR DELETE ON clients
  FOR EACH ROW EXECUTE FUNCTION memory_retention_close_owner();

CREATE FUNCTION memory_retention_immutable_period() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR
    (to_jsonb(NEW)-ARRAY['closed_at','purge_after','closed_reason']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['closed_at','purge_after','closed_reason']) THEN
    RAISE EXCEPTION 'memory_retention_period_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_retention_period_immutable BEFORE UPDATE OR DELETE ON memory_retention_subjects
  FOR EACH ROW EXECUTE FUNCTION memory_retention_immutable_period();
CREATE FUNCTION memory_retention_immutable_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'memory_content_tombstone_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER memory_retention_tombstone_immutable BEFORE UPDATE OR DELETE ON memory_retention_tombstones
  FOR EACH ROW EXECUTE FUNCTION memory_retention_immutable_tombstone();

-- VOLATILE sees the period inserted by the row's BEFORE trigger in the same
-- INSERT command. A STABLE snapshot would reject the first valid owner write.
CREATE FUNCTION memory_retention_visible(p_tenant uuid,p_subject uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM memory_retention_subjects s JOIN tenants t ON t.id=s.tenant_id
    WHERE (rls_bypass() OR p_tenant=current_tenant_id())
      AND s.tenant_id=p_tenant AND s.id=p_subject AND s.closed_at IS NULL AND t.status::text='active'
      AND (s.owner_kind='firm'
        OR (s.owner_kind='personal' AND EXISTS(SELECT 1 FROM tenant_memberships member
          WHERE member.tenant_id=s.tenant_id AND member.user_id=s.owner_id AND member.status::text='active'))
        OR (s.owner_kind='client' AND EXISTS(SELECT 1 FROM clients client
          WHERE client.tenant_id=s.tenant_id AND client.id=s.owner_id AND client.status='active'))))
$$;
-- The inner read must see suppressed destinations even when the function owner
-- is subject to FORCE RLS. A static `SET app.bypass_rls='on'` clause is validated
-- when the function is created and is refused for the non-superuser migration
-- role, so the bypass is applied inside the body and the caller's prior value is
-- restored on success and on error (the save/restore mechanism already used by
-- 20261120210200_phase8_defense_program_admin_boundary). Without the restore the
-- transaction-local setting would leak into the rest of the caller's transaction.
-- Only the tenant-bound outer function can invoke it as the owning role.
CREATE FUNCTION memory_retention_edge_sources(p_tenant uuid,p_source uuid,p_type text,p_slug text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior text:=current_setting('app.bypass_rls',true); allowed boolean;
BEGIN
  PERFORM set_config('app.bypass_rls','on',true);
  allowed:=(SELECT EXISTS(SELECT 1 FROM memory_items m WHERE m.tenant_id=p_tenant AND m.id=p_source
      AND memory_retention_visible(m.tenant_id,m.retention_subject_id))
    AND NOT EXISTS(SELECT 1 FROM memory_items target WHERE target.tenant_id=p_tenant AND target.type=p_type AND target.slug=p_slug
      AND NOT memory_retention_visible(target.tenant_id,target.retention_subject_id)));
  PERFORM set_config('app.bypass_rls',COALESCE(prior,''),true);
  RETURN allowed;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.bypass_rls',COALESCE(prior,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION memory_retention_edge_sources(uuid,uuid,text,text) FROM PUBLIC;
CREATE FUNCTION memory_retention_edge_visible(p_tenant uuid,p_source uuid,p_type text,p_slug text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- rls_bypass() reads current_setting(...,true)='on' and is NULL when the GUC
  -- was never set, so an explicit "IS NOT TRUE" is required: `NOT NULL` is
  -- NULL, which would skip this RETURN and let a caller-supplied other tenant
  -- reach the privileged SECURITY DEFINER read.
  IF rls_bypass() IS NOT TRUE AND p_tenant IS DISTINCT FROM current_tenant_id() THEN RETURN false; END IF;
  RETURN memory_retention_edge_sources(p_tenant,p_source,p_type,p_slug);
END $$;
CREATE POLICY memory_items_owner_retention ON memory_items AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR memory_retention_visible(tenant_id,retention_subject_id));
CREATE POLICY memory_candidate_owner_retention ON memory_candidate AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR memory_retention_visible(tenant_id,retention_subject_id));
CREATE POLICY clio_memory_owner_retention ON clio_memory AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR memory_retention_visible(tenant_id,retention_subject_id));
CREATE POLICY memory_embedding_owner_retention ON context_embeddings AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR source_type<>'memory_item' OR EXISTS(
    SELECT 1 FROM memory_items m WHERE m.tenant_id=context_embeddings.tenant_id
      AND m.id::text=context_embeddings.source_id
      AND memory_retention_visible(m.tenant_id,m.retention_subject_id)));
CREATE POLICY memory_edge_owner_retention ON memory_edges AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR memory_retention_edge_visible(tenant_id,src_item_id,dst_type,dst_slug));

REVOKE ALL ON FUNCTION memory_retention_current_period(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_retention_bind_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_retention_close_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_retention_record_deletion() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE ALL ON memory_retention_subjects FROM capiro_app;
    GRANT SELECT ON memory_retention_subjects TO capiro_app;
    -- Row locking requires UPDATE privilege. The immutable trigger rejects all
    -- direct id updates; closing fields remain writable only by the trigger owner.
    GRANT UPDATE(id) ON memory_retention_subjects TO capiro_app;
    REVOKE ALL ON memory_retention_tombstones FROM capiro_app;
    GRANT SELECT ON memory_retention_tombstones TO capiro_app;
    GRANT EXECUTE ON FUNCTION memory_retention_visible(uuid,uuid) TO capiro_app;
  END IF;
END $$;
COMMIT;
