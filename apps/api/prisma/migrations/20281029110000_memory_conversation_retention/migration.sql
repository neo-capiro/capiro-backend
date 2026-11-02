BEGIN;

-- Explicit producer provenance only: citations do not make independently
-- created memory belong to a conversation. Corrections use the same origin
-- nested by the immutable-version owner; revisions preserve that provenance.
CREATE FUNCTION memory_candidate_conversation_origin(p_provenance jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE
    WHEN p_provenance->>'tool'='meri_memory_review' THEN coalesce(p_provenance->'origin','null'::jsonb)
    WHEN p_provenance#>>'{meri,tool}'='meri_memory_review' THEN coalesce(p_provenance#>'{meri,origin}','null'::jsonb)
    ELSE NULL END
$$;

CREATE FUNCTION memory_candidate_conversation_visible(p_tenant uuid,p_actor uuid,p_origin jsonb)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT (rls_bypass() OR p_tenant=current_tenant_id()) AND
    (p_origin IS NULL OR p_origin->>'kind'='surface' OR
      (p_origin->>'kind'='conversation' AND EXISTS(
        SELECT 1 FROM clio_conversations c JOIN clio_conversation_bootstrap_receipts b
          ON b.tenant_id=c.tenant_id AND b.conversation_id=c.id AND b.actor_user_id=c.user_id
          AND b.client_id IS NOT DISTINCT FROM c.client_id
          AND b.scope_kind=CASE WHEN c.client_id IS NULL THEN 'general' ELSE 'client' END
        WHERE c.tenant_id=p_tenant AND c.id::text=p_origin->>'conversationId'
          AND c.user_id=p_actor AND c.status IN ('active','archived'))))
$$;

-- Serialize INSERT/activation with Core Trash/Restore. Trash takes only the
-- conversation lock, so a candidate writer may hold its own row first without
-- creating a candidate/conversation lock inversion. Retention takes the shared
-- memory table exclusion before its conversation lock.
CREATE FUNCTION memory_candidate_guard_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE origin jsonb; prior jsonb;
BEGIN
  origin := memory_candidate_conversation_origin(NEW.provenance_jsonb);
  IF TG_OP='UPDATE' THEN
    prior := memory_candidate_conversation_origin(OLD.provenance_jsonb);
    IF origin IS DISTINCT FROM prior OR
      (prior IS NOT NULL AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by)) THEN
      RAISE EXCEPTION 'MEMORY_CONVERSATION_ORIGIN_IMMUTABLE';
    END IF;
    IF NEW.status NOT IN ('approved','auto_committed') OR NEW.status=OLD.status THEN RETURN NEW; END IF;
  END IF;
  IF origin IS NULL OR origin->>'kind'='surface' THEN RETURN NEW; END IF;
  IF origin->>'kind'='conversation' THEN
    PERFORM c.id FROM clio_conversations c
      WHERE c.tenant_id=NEW.tenant_id AND c.id::text=origin->>'conversationId' FOR SHARE;
  END IF;
  IF NOT coalesce(memory_candidate_conversation_visible(NEW.tenant_id,NEW.proposed_by,origin),false) THEN
    RAISE EXCEPTION 'MEMORY_CONVERSATION_UNAVAILABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_candidate_guard_conversation BEFORE INSERT OR UPDATE ON memory_candidate
  FOR EACH ROW EXECUTE FUNCTION memory_candidate_guard_conversation();

-- Pending/rejected copies and their review surfaces disappear together in
-- Trash. Restore within the canonical window makes them visible again.
-- Independently published memory retains its own ownership/retention policy.
CREATE POLICY memory_candidate_conversation_retention ON memory_candidate AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR status IN ('approved','auto_committed') OR
    memory_candidate_conversation_visible(tenant_id,proposed_by,
      memory_candidate_conversation_origin(provenance_jsonb)));
CREATE POLICY memory_review_conversation_retention ON review_request AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR surface<>'memory' OR subject_type<>'memory_candidate' OR EXISTS(
    SELECT 1 FROM memory_candidate c WHERE c.tenant_id=review_request.tenant_id AND c.id::text=review_request.subject_id));
CREATE POLICY memory_outbox_conversation_retention ON memory_review_notification_outbox AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR EXISTS(SELECT 1 FROM memory_candidate c
    WHERE c.tenant_id=memory_review_notification_outbox.tenant_id AND c.id=memory_review_notification_outbox.candidate_id));
CREATE POLICY memory_notification_conversation_retention ON memory_review_in_app_notification AS RESTRICTIVE FOR SELECT
  USING(rls_bypass() OR EXISTS(SELECT 1 FROM memory_candidate c
    WHERE c.tenant_id=memory_review_in_app_notification.tenant_id AND c.id=memory_review_in_app_notification.candidate_id));

REVOKE ALL ON FUNCTION memory_candidate_guard_conversation() FROM PUBLIC;
COMMIT;
