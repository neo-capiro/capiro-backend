-- PROPOSAL ONLY: canonical Core forward for the common public ledger. No application rows.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog,public;
LOCK TABLE public.intel_live_hearing_session, public.committee_hearing, public.users, public.tenant_memberships, public.intel_feature_flag, public.hearing_stream_candidate, public.intel_hearing_media_permission IN ACCESS SHARE MODE;
DO $guard$
DECLARE r record;
BEGIN
 IF current_database()<>'capiro' OR current_user<>'capiro_master' OR session_user<>'capiro_master' THEN RAISE EXCEPTION 'Expected bound migration owner and database'; END IF;
 IF current_setting('server_version_num')::integer<160000 THEN RAISE EXCEPTION 'PostgreSQL16 required'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('public_hearing_browser_recording_eligible','enable_public_hearing_browser_recording')) THEN RAISE EXCEPTION 'Browser function collision; no replace or replay'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN RAISE EXCEPTION 'Application role boundary drift'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES ('capiro_master'),('pg_read_all_data'),('pg_write_all_data')) t(name) WHERE pg_has_role('capiro_app',t.name,'USAGE') OR pg_has_role('capiro_app',t.name,'SET') OR EXISTS(SELECT 1 FROM pg_roles bridge WHERE pg_has_role('capiro_app',bridge.oid,'SET') AND pg_has_role(bridge.oid,t.name,'USAGE'))) THEN RAISE EXCEPTION 'Application privileged role path'; END IF;
 FOR r IN SELECT * FROM (VALUES ('committee_hearing',false,false),('hearing_stream_candidate',false,false),('intel_feature_flag',true,true),('intel_hearing_media_permission',true,true),('intel_live_hearing_session',true,true),('tenant_memberships',true,true),('users',false,false)) x(name,rls,force_rls) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('public.'||r.name) AND relkind='r' AND relowner=current_user::regrole AND relrowsecurity=r.rls AND relforcerowsecurity=r.force_rls) THEN RAISE EXCEPTION 'Dependency owner/RLS drift: %',r.name; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES ('intel_live_hearing_session','id','text',true),
('intel_live_hearing_session','tenant_id','text',true),
('intel_live_hearing_session','hearing_id','text',false),
('intel_live_hearing_session','created_by','text',true),
('intel_live_hearing_session','source_type','intel_live_hearing_source_type',true),
('intel_live_hearing_session','status','intel_live_hearing_status',true),
('intel_live_hearing_session','started_at','timestamp(3) without time zone',false),
('intel_live_hearing_session','recording_policy','intel_recording_policy',true),
('intel_live_hearing_session','public_capture_id','text',false),
('intel_live_hearing_session','consent_status','intel_consent_status',true),
('intel_live_hearing_session','source_url','text',false),
('committee_hearing','id','text',true),
('committee_hearing','canonical_hearing_id','text',false),
('committee_hearing','visibility','text',true),
('committee_hearing','geographic_jurisdiction','text',false),
('committee_hearing','event_status','text',true),
('users','id','uuid',true),
('users','clerk_user_id','text',true),
('tenant_memberships','user_id','uuid',true),
('tenant_memberships','tenant_id','uuid',true),
('tenant_memberships','status','membership_status',true),
('intel_feature_flag','tenant_id','text',true),
('intel_feature_flag','feature','text',true),
('intel_feature_flag','enabled','boolean',true),
('hearing_stream_candidate','hearing_id','text',true),
('hearing_stream_candidate','official_page_url','text',true),
('hearing_stream_candidate','capture_policy','text',true),
('hearing_stream_candidate','expires_at','timestamp(6) with time zone',false),
('intel_hearing_media_permission','id','text',true),
('intel_hearing_media_permission','tenant_id','text',true),
('intel_hearing_media_permission','hearing_id','text',false),
('intel_hearing_media_permission','source_url','text',true),
('intel_hearing_media_permission','mode','text',true),
('intel_hearing_media_permission','revoked_at','timestamp(3) without time zone',false),
('intel_hearing_media_permission','expires_at','timestamp(3) without time zone',true),
('intel_hearing_media_permission','operations','text[]',false),
('intel_hearing_media_permission','reviewed_at','timestamp(3) without time zone',true),
('intel_hearing_media_permission','evidence','text',true),
('intel_hearing_media_permission','reviewed_by','text',true),
('intel_hearing_media_permission','retention_days','integer',true)) x(tab,col,typ,nn) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||r.tab) AND attname=r.col AND NOT attisdropped AND format_type(atttypid,atttypmod)=r.typ AND attnotnull=r.nn) THEN RAISE EXCEPTION 'Dependency column drift: %.%',r.tab,r.col; END IF;
 END LOOP;
 IF to_regprocedure('public.current_tenant_id()') IS NULL OR to_regprocedure('public.rls_bypass()') IS NULL THEN RAISE EXCEPTION 'Tenant helper missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.intel_hearing_media_permission'::regclass AND tgname='hearing_permission_identity_immutable' AND tgenabled='O') THEN RAISE EXCEPTION 'Permission identity guard missing'; END IF;
 IF has_table_privilege('capiro_app','public.intel_hearing_media_permission','INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('capiro_app','public.intel_hearing_media_permission','INSERT') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.intel_hearing_media_permission'::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'id' AND has_column_privilege('capiro_app',a.attrelid,a.attnum,'UPDATE')) OR NOT has_column_privilege('capiro_app','public.intel_hearing_media_permission','id','UPDATE') THEN RAISE EXCEPTION 'Permission runtime boundary drift'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.intel_hearing_media_permission'::regclass AND a.attname='reviewed_at' AND pg_get_expr(d.adbin,d.adrelid)='CURRENT_TIMESTAMP') THEN RAISE EXCEPTION 'Permission review default drift'; END IF;
END $guard$;

-- BEGIN BYTE-IDENTICAL ACCEPTED INTEL SOURCE
-- Normal explicit browser retention uses the existing source-permission owner.
-- The application still cannot INSERT/expand permissions directly.
CREATE FUNCTION public.public_hearing_browser_recording_eligible(record_session text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.intel_live_hearing_session s
    JOIN public.committee_hearing h ON h.id=s.hearing_id
    JOIN public.users u ON u.clerk_user_id=current_setting('app.hearing_actor',true)
    JOIN public.tenant_memberships m ON m.user_id=u.id AND m.tenant_id::text=s.tenant_id
      AND m.status::text='active'
    JOIN public.intel_feature_flag f ON f.tenant_id=s.tenant_id
      AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
    WHERE s.id=record_session AND s.tenant_id=public.current_tenant_id()::text
      AND s.created_by=u.clerk_user_id AND s.source_type IN ('hearing','markup')
      AND s.status='scheduled' AND s.started_at IS NULL AND s.recording_policy<>'no_storage'
      AND s.public_capture_id IS NULL AND s.consent_status IN ('not_required','confirmed')
      AND h.canonical_hearing_id IS NULL AND h.visibility='public'
      AND h.geographic_jurisdiction IN ('US','FL')
      AND h.event_status NOT IN ('canceled','cancelled')
      -- Stable HTTPS publisher page, never a direct/signed media URL. Provider
      -- rights come from the existing canonical candidate policy, not a new list.
      AND s.source_url ~ '^https://[^/@:#[:space:]]+(/[^#[:space:]]*)?$'
      AND s.source_url !~* '\.(m3u8|mp[34]|m4a|aac|wav|webm|ts|mov|flv|mkv)([/?]|$)'
      AND s.source_url !~* '[?&](token|sig|signature|expires?|policy|key-pair-id|x-amz-[^=]+|auth|auth_token|access_token|jwt|hdnea|hdnts)='
      AND EXISTS (SELECT 1 FROM public.hearing_stream_candidate c
        WHERE c.hearing_id=h.id AND c.official_page_url=s.source_url
          AND c.capture_policy IN ('SERVER_CAPTURE_ALLOWED','BROWSER_CAPTURE_ONLY')
          AND (c.expires_at IS NULL OR c.expires_at>statement_timestamp()))
      AND NOT EXISTS (SELECT 1 FROM public.hearing_stream_candidate c
        WHERE c.hearing_id=h.id AND c.official_page_url=s.source_url
          AND (c.expires_at IS NULL OR c.expires_at>statement_timestamp())
          AND c.capture_policy IN ('LICENSE_REQUIRED','BLOCKED','REVIEW_REQUIRED'))
      -- Explicit withdrawal/expiry is never silently replaced by self-service.
      AND NOT EXISTS (SELECT 1 FROM public.intel_hearing_media_permission p
        WHERE p.tenant_id=s.tenant_id AND p.hearing_id=h.id AND p.source_url=s.source_url
          AND p.mode='browser'
          AND (p.revoked_at IS NOT NULL OR p.expires_at<=statement_timestamp()
            OR NOT COALESCE(p.operations @> ARRAY['capture','transcription','retention']::text[],false)))
  )
$$;

CREATE FUNCTION public.enable_public_hearing_browser_recording(record_session text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  target public.intel_live_hearing_session%ROWTYPE;
  permission_id text;
BEGIN
  SELECT * INTO target FROM public.intel_live_hearing_session s
    WHERE s.id=record_session AND s.tenant_id=public.current_tenant_id()::text
      AND s.created_by=current_setting('app.hearing_actor',true)
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLIC_BROWSER_RECORDING_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.tenant_memberships m
    JOIN public.users u ON u.id=m.user_id
    JOIN public.intel_feature_flag f ON f.tenant_id=m.tenant_id::text
      AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
    WHERE m.tenant_id::text=target.tenant_id AND m.status::text='active'
      AND u.clerk_user_id=target.created_by FOR SHARE OF m,f;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLIC_BROWSER_RECORDING_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target.tenant_id || ':' || target.hearing_id || ':' || target.source_url,0));
  PERFORM 1 FROM public.committee_hearing h WHERE h.id=target.hearing_id FOR SHARE;
  PERFORM 1 FROM public.hearing_stream_candidate c
    WHERE c.hearing_id=target.hearing_id AND c.official_page_url=target.source_url FOR SHARE;
  PERFORM 1 FROM public.intel_hearing_media_permission p
    WHERE p.tenant_id=target.tenant_id AND p.hearing_id=target.hearing_id
      AND p.source_url=target.source_url AND p.mode='browser' FOR SHARE;
  IF NOT public.public_hearing_browser_recording_eligible(record_session) THEN
    RAISE EXCEPTION 'PUBLIC_BROWSER_RECORDING_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  SELECT p.id INTO permission_id FROM public.intel_hearing_media_permission p
    WHERE p.tenant_id=target.tenant_id AND p.hearing_id=target.hearing_id
      AND p.source_url=target.source_url AND p.mode='browser'
      AND p.revoked_at IS NULL AND p.expires_at>statement_timestamp()
      AND p.operations @> ARRAY['capture','transcription','retention']::text[]
    ORDER BY p.reviewed_at DESC LIMIT 1;
  IF permission_id IS NOT NULL THEN RETURN permission_id; END IF;
  permission_id := pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.intel_hearing_media_permission
    (id,tenant_id,source_url,hearing_id,mode,operations,evidence,reviewed_by,expires_at,retention_days)
    VALUES(permission_id,target.tenant_id,target.source_url,target.hearing_id,'browser',
      ARRAY['capture','transcription','retention'],
      'Explicit creator enable; canonical public hearing and current approved browser source',
      -- The source window bounds capture admission/heartbeats, not playback
      -- of audio captured during that window. Existing grants are never extended.
      target.created_by,statement_timestamp()+interval '30 days',30);
  RETURN permission_id;
END
$$;

REVOKE ALL ON FUNCTION public.public_hearing_browser_recording_eligible(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enable_public_hearing_browser_recording(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_hearing_browser_recording_eligible(text) TO capiro_app;
GRANT EXECUTE ON FUNCTION public.enable_public_hearing_browser_recording(text) TO capiro_app;
-- END BYTE-IDENTICAL ACCEPTED INTEL SOURCE
DO $verify$
DECLARE p record;
BEGIN
 FOR p IN SELECT * FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('public_hearing_browser_recording_eligible','enable_public_hearing_browser_recording') LOOP
  IF p.proowner<>current_user::regrole OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[] OR pg_get_function_identity_arguments(p.oid)<>'record_session text'  OR p.proisstrict OR p.proleakproof OR p.proparallel<>'u' OR (p.proname='public_hearing_browser_recording_eligible' AND (p.provolatile<>'s' OR p.prorettype<>'boolean'::regtype OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql'))) OR (p.proname='enable_public_hearing_browser_recording' AND (p.provolatile<>'v' OR p.prorettype<>'text'::regtype OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql'))) THEN RAISE EXCEPTION 'Browser function ownership/signature/security drift'; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.grantee<>'capiro_app'::regrole OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) OR NOT has_function_privilege('capiro_app',p.oid,'EXECUTE') THEN RAISE EXCEPTION 'Browser function execution ACL drift'; END IF;
 END LOOP;
END $verify$;
COMMIT;
