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
