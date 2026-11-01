-- SOURCE ONLY: corrected successor to the frozen ICU-based meeting proposal.
-- Requires 00-canonical-contact-helper-forward.sql; old proposal is preserved, never applied.
-- All ownership/association/citext predicates below remain unchanged.
-- Exact accepted source contract: 98b83c3dcec9e670ff1b41e8dd681ea039ecf283.
-- Separate from Research/Classic and from all immutable prior migration files.
-- Parent DB owner assigns final migration identity after actual-role qualification.
BEGIN;
SET LOCAL search_path = pg_catalog;
DO $prerequisite$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'meri_private' AND p.proname = 'ecmascript_contact_key_u17_v1'
      AND p.proargtypes = '25'::pg_catalog.oidvector AND p.prorettype = 25
      AND p.proowner = 'capiro_private_projection_owner'::regrole
      AND NOT p.prosecdef AND p.proisstrict AND p.provolatile = 'i'
      AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
      AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') = 'aaa77d67f19f71685cd6e71c11b90e61f00ab49249883d0070873150d3e20a91'
  ) THEN RAISE EXCEPTION 'Pinned canonical ECMAScript contact helper required'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meri_private' AND c.relkind = 'v'
        AND c.relowner = 'capiro_private_projection_owner'::regrole
        AND c.reloptions @> ARRAY['security_barrier=true']
        AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)) <> 15
  THEN RAISE EXCEPTION 'Exact old14 private projection predecessor required'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('meetings','engagement_connections','meeting_attendees')
        AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relforcerowsecurity
        AND c.relowner NOT IN ('capiro_private_projection_owner'::regrole,'capiro_private_query_ro'::regrole)) <> 3
  THEN RAISE EXCEPTION 'Meeting tenant source FORCE RLS prerequisite required'; END IF;
END
$prerequisite$;

GRANT SELECT (tenant_id, id, client_id, subject, starts_at, ends_at, time_zone,
  status, source, is_internal, is_virtual, provider, created_at, updated_at,
  created_by_user_id, connection_id, association_signals_jsonb, organizer_email)
  ON public.meetings TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, id, created_by_user_id)
  ON public.engagement_connections TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, meeting_id, email)
  ON public.meeting_attendees TO capiro_private_projection_owner;
-- clients.primary_contact_email and client_people.email already belong to the exact old14 grants.

SET LOCAL ROLE capiro_private_projection_owner;
CREATE VIEW meri_private.client_meetings
WITH (security_barrier = true, security_invoker = false) AS
SELECT v.client_id, m.id, m.subject, m.starts_at, m.ends_at, m.time_zone,
  m.status, m.source::text AS source, m.is_internal, m.is_virtual, m.provider,
  m.created_at, m.updated_at
FROM meri_private.visible_clients v
JOIN public.meetings m ON m.tenant_id = v.tenant_id
WHERE m.status <> 'deleted'
  AND (m.created_by_user_id = CASE
      WHEN pg_catalog.current_setting('app.current_user', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN pg_catalog.current_setting('app.current_user', true)::uuid END
    OR EXISTS (SELECT 1 FROM public.engagement_connections c
      WHERE c.tenant_id = m.tenant_id AND c.id = m.connection_id
        AND c.created_by_user_id = CASE
          WHEN pg_catalog.current_setting('app.current_user', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN pg_catalog.current_setting('app.current_user', true)::uuid END))
  AND (m.client_id = v.client_id OR (
    m.client_id IS NULL AND NOT m.is_internal
    AND (m.association_signals_jsonb -> 'manual' IS NULL
      OR m.association_signals_jsonb -> 'manual' IN ('null'::jsonb, 'false'::jsonb))
    AND EXISTS (
      SELECT 1 FROM (
        SELECT c.primary_contact_email::text AS email FROM public.clients c
        WHERE c.tenant_id = v.tenant_id AND c.id = v.client_id
        UNION ALL
        SELECT p.email::text FROM public.client_people p
        WHERE p.tenant_id = v.tenant_id AND p.client_id = v.client_id
      ) raw
      CROSS JOIN LATERAL (
        -- Exact pinned JS contact transform; no meeting-side normalization.
        -- Keep database-default collation for the unchanged actual citext comparison.
        SELECT meri_private.ecmascript_contact_key_u17_v1(raw.email)
          COLLATE pg_catalog."default" AS email
      ) contact
      WHERE contact.email <> ''
        AND (m.organizer_email OPERATOR(public.=) contact.email::public.citext
          OR EXISTS (SELECT 1 FROM public.meeting_attendees a
            WHERE a.tenant_id = m.tenant_id AND a.meeting_id = m.id
              AND a.email OPERATOR(public.=) contact.email::public.citext))
    )
  ));
RESET ROLE;
REVOKE ALL ON meri_private.client_meetings FROM PUBLIC;
GRANT SELECT ON meri_private.client_meetings TO capiro_private_query_ro;
COMMIT;
