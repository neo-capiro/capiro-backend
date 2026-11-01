BEGIN;

-- Core and the native retention owner use the same database. Meri's external
-- ledger stays authoritative; the request supplies only its freshly verified
-- position. No additional retention ledger or copied suppression table.
CREATE OR REPLACE FUNCTION memory_conversation_serving_begin(p_witness jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor_role text := coalesce(nullif(current_setting('role',true),'none'),session_user);
BEGIN
  IF rls_bypass() OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=actor_role
      AND NOT rolsuper AND NOT rolbypassrls) OR EXISTS(
      SELECT 1 FROM pg_class WHERE oid IN ('memory_candidate'::regclass,'review_request'::regclass,
        'memory_review_notification_outbox'::regclass,'memory_review_in_app_notification'::regclass)
        AND (NOT relrowsecurity OR NOT relforcerowsecurity)) THEN
    RAISE EXCEPTION 'MEMORY_RETENTION_ROLE_UNAVAILABLE';
  END IF;
  IF p_witness IS DISTINCT FROM 'null'::jsonb AND
      (jsonb_typeof(p_witness) IS DISTINCT FROM 'object' OR
       NOT (p_witness ?& ARRAY['sequence','entrySha256']) OR
       p_witness-ARRAY['sequence','entrySha256'] <> '{}'::jsonb OR
       jsonb_typeof(p_witness->'sequence') IS DISTINCT FROM 'number' OR
       coalesce(p_witness->>'sequence','') !~ '^(0|[1-9][0-9]{0,15})$' OR
       (p_witness->>'sequence')::numeric > 9007199254740991 OR
       CASE WHEN p_witness->>'sequence'='0' THEN p_witness->'entrySha256' IS DISTINCT FROM 'null'::jsonb
            ELSE coalesce(p_witness->>'entrySha256','') !~ '^[a-f0-9]{64}$' END) THEN
    RAISE EXCEPTION 'MEMORY_RETENTION_WITNESS_INVALID';
  END IF;
  PERFORM set_config('app.memory_retention_witness',coalesce(p_witness::text,'null'),true);
  PERFORM set_config('app.memory_retention_used','off',true);
END $$;

CREATE OR REPLACE FUNCTION memory_conversation_serving_verify() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE witness jsonb; verified boolean;
BEGIN
  witness := nullif(current_setting('app.memory_retention_witness',true),'')::jsonb;
  IF witness IS NULL OR witness='null'::jsonb THEN RAISE EXCEPTION 'MEMORY_RETENTION_WITNESS_REQUIRED'; END IF;
  EXECUTE 'SELECT meri_core_authority.retention_serving_v1($1,NULL,NULL,$2,$3)'
    INTO verified USING current_tenant_id(),(witness->>'sequence')::bigint,witness->>'entrySha256';
  IF verified IS DISTINCT FROM true THEN RAISE EXCEPTION 'MEMORY_RETENTION_WATERMARK_UNVERIFIED'; END IF;
  RETURN (witness->>'sequence')::bigint;
EXCEPTION WHEN undefined_function OR undefined_table OR invalid_schema_name OR insufficient_privilege THEN
  RAISE EXCEPTION 'MEMORY_RETENTION_STORE_UNAVAILABLE';
END $$;

CREATE OR REPLACE FUNCTION memory_conversation_native_visible(p_tenant uuid,p_actor uuid,p_conversation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE witness jsonb; visible boolean;
BEGIN
  PERFORM set_config('app.memory_retention_used','on',true);
  witness := nullif(current_setting('app.memory_retention_witness',true),'')::jsonb;
  IF witness IS NULL OR witness='null'::jsonb THEN RAISE EXCEPTION 'MEMORY_RETENTION_WITNESS_REQUIRED'; END IF;
  -- Meri owns the existing transition/recovery exclusions and native projection.
  -- Core receives a predicate through its existing authority schema, not raw
  -- native table privileges. The function try-locks before reading its tables.
  EXECUTE 'SELECT meri_core_authority.retention_serving_v1($1,$2,$3,$4,$5)'
    INTO visible USING p_tenant,p_actor,p_conversation,(witness->>'sequence')::bigint,witness->>'entrySha256';
  RETURN coalesce(visible,false);
EXCEPTION WHEN undefined_function OR undefined_table OR invalid_schema_name OR insufficient_privilege THEN
  RAISE EXCEPTION 'MEMORY_RETENTION_STORE_UNAVAILABLE';
END $$;
CREATE OR REPLACE FUNCTION memory_candidate_conversation_visible(p_tenant uuid,p_actor uuid,p_origin jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE conversation uuid;
BEGIN
  IF NOT (rls_bypass() OR p_tenant=current_tenant_id()) THEN RETURN false; END IF;
  IF p_origin IS NULL OR p_origin->>'kind'='surface' THEN RETURN true; END IF;
  IF p_origin->>'kind' IS DISTINCT FROM 'conversation' OR
      coalesce(p_origin->>'conversationId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
  conversation := (p_origin->>'conversationId')::uuid;
  IF NOT EXISTS(SELECT 1 FROM clio_conversations c JOIN clio_conversation_bootstrap_receipts b
      ON b.tenant_id=c.tenant_id AND b.conversation_id=c.id AND b.actor_user_id=c.user_id
      AND b.client_id IS NOT DISTINCT FROM c.client_id
      AND b.scope_kind=CASE WHEN c.client_id IS NULL THEN 'general' ELSE 'client' END
      WHERE c.tenant_id=p_tenant AND c.id=conversation AND c.user_id=p_actor AND c.status IN ('active','archived')) THEN RETURN false; END IF;
  RETURN memory_conversation_native_visible(p_tenant,p_actor,conversation);
END $$;

-- Explicit CASE keeps approved independent memory and trusted cleanup out of
-- conversation proof evaluation, regardless of predicate planner ordering.
DROP POLICY memory_candidate_conversation_retention ON memory_candidate;
CREATE POLICY memory_candidate_conversation_retention ON memory_candidate AS RESTRICTIVE FOR SELECT
  USING(CASE WHEN rls_bypass() OR status IN ('approved','auto_committed') THEN true
    ELSE memory_candidate_conversation_visible(tenant_id,proposed_by,
      memory_candidate_conversation_origin(provenance_jsonb)) END);
DROP POLICY memory_review_conversation_retention ON review_request;
CREATE POLICY memory_review_conversation_retention ON review_request AS RESTRICTIVE FOR SELECT
  USING(CASE WHEN rls_bypass() OR surface<>'memory' OR subject_type<>'memory_candidate' THEN true
    ELSE EXISTS(SELECT 1 FROM memory_candidate c WHERE c.tenant_id=review_request.tenant_id
      AND c.id::text=review_request.subject_id) END);
DROP POLICY memory_outbox_conversation_retention ON memory_review_notification_outbox;
CREATE POLICY memory_outbox_conversation_retention ON memory_review_notification_outbox AS RESTRICTIVE FOR SELECT
  USING(CASE WHEN rls_bypass() THEN true ELSE EXISTS(SELECT 1 FROM memory_candidate c
    WHERE c.tenant_id=memory_review_notification_outbox.tenant_id AND c.id=memory_review_notification_outbox.candidate_id) END);
DROP POLICY memory_notification_conversation_retention ON memory_review_in_app_notification;
CREATE POLICY memory_notification_conversation_retention ON memory_review_in_app_notification AS RESTRICTIVE FOR SELECT
  USING(CASE WHEN rls_bypass() THEN true ELSE EXISTS(SELECT 1 FROM memory_candidate c
    WHERE c.tenant_id=memory_review_in_app_notification.tenant_id AND c.id=memory_review_in_app_notification.candidate_id) END);
ALTER TABLE memory_candidate FORCE ROW LEVEL SECURITY;
ALTER TABLE review_request FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_review_notification_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_review_in_app_notification FORCE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION memory_conversation_serving_begin(jsonb),memory_conversation_serving_verify(),
  memory_conversation_native_visible(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_conversation_serving_begin(jsonb),memory_conversation_serving_verify() TO capiro_app;
COMMIT;
