-- New Core-owned forward; source proposal only. Never replay the audio forwards.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=pg_catalog,public;
LOCK TABLE public.intel_live_hearing_session, public.committee_hearing,
  public.users, public.tenant_memberships, public.intel_feature_flag,
  public.hearing_stream_candidate, public.intel_hearing_media_permission IN ACCESS SHARE MODE;
DO $guard$
DECLARE dependency regprocedure;
BEGIN
  IF current_database()<>'capiro' OR current_user<>'capiro_master' OR session_user<>'capiro_master' THEN
    RAISE EXCEPTION 'Expected bound migration owner and database';
  END IF;
  IF current_setting('server_version_num')::integer<160000 THEN RAISE EXCEPTION 'PostgreSQL16 required'; END IF;
  IF to_regprocedure('public.enable_public_hearing_browser_video_recording(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Video function collision; no replace or replay';
  END IF;
  dependency := to_regprocedure('public.public_hearing_browser_recording_eligible(text)');
  IF dependency IS NULL OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=dependency
    AND proowner=current_user::regrole AND prosecdef AND prorettype='boolean'::regtype
    AND proconfig=ARRAY['search_path=pg_catalog, public']::text[]) THEN
    RAISE EXCEPTION 'Reviewed public browser eligibility dependency missing or changed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app'
    AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN
    RAISE EXCEPTION 'Application role boundary drift';
  END IF;
  IF EXISTS(SELECT 1 FROM (VALUES ('capiro_master'),('pg_read_all_data'),('pg_write_all_data')) t(name)
    WHERE pg_has_role('capiro_app',t.name,'USAGE') OR pg_has_role('capiro_app',t.name,'SET') OR
      EXISTS(SELECT 1 FROM pg_roles bridge WHERE pg_has_role('capiro_app',bridge.oid,'SET') AND pg_has_role(bridge.oid,t.name,'USAGE'))) THEN
    RAISE EXCEPTION 'Application privileged role path';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.intel_hearing_media_permission'::regclass
    AND relowner=current_user::regrole AND relrowsecurity AND relforcerowsecurity) OR
    has_table_privilege('capiro_app','public.intel_hearing_media_permission','INSERT,UPDATE,DELETE,TRUNCATE') OR
    has_any_column_privilege('capiro_app','public.intel_hearing_media_permission','INSERT') OR
    EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.intel_hearing_media_permission'::regclass
      AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'id' AND has_column_privilege('capiro_app',a.attrelid,a.attnum,'UPDATE')) THEN
    RAISE EXCEPTION 'Permission runtime boundary drift';
  END IF;
END $guard$;

-- Called only by explicit enable-video with video+audio acknowledgment. Creates
-- a separate grant; never expands, replaces, extends or relabels an audio grant.
CREATE FUNCTION public.enable_public_hearing_browser_video_recording(record_session text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE target public.intel_live_hearing_session%ROWTYPE; permission_id text;
BEGIN
  SELECT * INTO target FROM public.intel_live_hearing_session s
    WHERE s.id=record_session AND s.tenant_id=public.current_tenant_id()::text
      AND s.created_by=current_setting('app.hearing_actor',true) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLIC_BROWSER_VIDEO_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.tenant_memberships m JOIN public.users u ON u.id=m.user_id
    JOIN public.intel_feature_flag f ON f.tenant_id=m.tenant_id::text
      AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
    WHERE m.tenant_id::text=target.tenant_id AND m.status::text='active'
      AND u.clerk_user_id=target.created_by FOR SHARE OF m,f;
  IF NOT FOUND THEN RAISE EXCEPTION 'PUBLIC_BROWSER_VIDEO_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target.tenant_id || ':' || target.hearing_id || ':' || target.source_url,0));
  PERFORM 1 FROM public.committee_hearing h WHERE h.id=target.hearing_id FOR SHARE;
  PERFORM 1 FROM public.hearing_stream_candidate c
    WHERE c.hearing_id=target.hearing_id AND c.official_page_url=target.source_url FOR SHARE;
  PERFORM 1 FROM public.intel_hearing_media_permission p
    WHERE p.tenant_id=target.tenant_id AND p.hearing_id=target.hearing_id
      AND p.source_url=target.source_url AND p.mode='browser' FOR SHARE;
  -- Reuses the canonical public US/FL source, creator, membership, feature,
  -- consent, before-first-capture, candidate restriction and withdrawal checks.
  IF NOT public.public_hearing_browser_recording_eligible(record_session) OR EXISTS(
    SELECT 1 FROM public.intel_hearing_media_permission p WHERE p.tenant_id=target.tenant_id
      AND p.hearing_id=target.hearing_id AND p.source_url=target.source_url AND p.mode='browser'
      AND p.evidence LIKE 'Explicit creator video+audio enable;%'
      AND NOT COALESCE(p.operations @> ARRAY['video_retention']::text[],false)
  ) THEN RAISE EXCEPTION 'PUBLIC_BROWSER_VIDEO_UNAVAILABLE' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO permission_id FROM public.intel_hearing_media_permission p
    WHERE p.tenant_id=target.tenant_id AND p.hearing_id=target.hearing_id
      AND p.source_url=target.source_url AND p.mode='browser' AND p.revoked_at IS NULL
      AND p.expires_at>statement_timestamp()
      AND p.operations @> ARRAY['capture','transcription','retention','video_retention']::text[]
    ORDER BY p.reviewed_at DESC LIMIT 1;
  IF permission_id IS NOT NULL THEN RETURN permission_id; END IF;
  permission_id := pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.intel_hearing_media_permission
    (id,tenant_id,source_url,hearing_id,mode,operations,evidence,reviewed_by,expires_at,retention_days)
  VALUES(permission_id,target.tenant_id,target.source_url,target.hearing_id,'browser',
    ARRAY['capture','transcription','retention','video_retention'],
    'Explicit creator video+audio enable; canonical public source; video and audio retention acknowledged',
    target.created_by,statement_timestamp()+interval '30 days',30);
  RETURN permission_id;
END $$;
REVOKE ALL ON FUNCTION public.enable_public_hearing_browser_video_recording(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enable_public_hearing_browser_video_recording(text) TO capiro_app;
DO $verify$
DECLARE p record;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid='public.enable_public_hearing_browser_video_recording(text)'::regprocedure;
  IF p.proowner<>current_user::regrole OR NOT p.prosecdef OR
    p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']::text[] OR
    p.prorettype<>'text'::regtype OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.proleakproof OR p.proisstrict THEN
    RAISE EXCEPTION 'Video function ownership/signature/security drift';
  END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND (a.grantee<>'capiro_app'::regrole OR a.privilege_type<>'EXECUTE' OR a.is_grantable)) OR
    NOT has_function_privilege('capiro_app',p.oid,'EXECUTE') THEN
    RAISE EXCEPTION 'Video function execution ACL drift';
  END IF;
END $verify$;
COMMIT;
