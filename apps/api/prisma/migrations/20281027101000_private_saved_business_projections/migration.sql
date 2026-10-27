-- Forward migration PROPOSAL ONLY. Root reserves its final migration name.
-- Requires the exact accepted initial private projection migration first.
-- No existing migration, tenant policy, user row or application role is changed.
DO $business_prerequisites$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname = 'capiro_private_projection_owner'
      AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolinherit
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname = 'capiro_private_query_ro'
      AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolinherit
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
  ) THEN
    RAISE EXCEPTION 'Expected isolated private query roles';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'meri_private' AND c.relname = 'visible_clients'
      AND c.relkind = 'v' AND r.rolname = 'capiro_private_projection_owner'
      AND c.reloptions @> ARRAY['security_barrier=true']
      AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)
  ) THEN
    RAISE EXCEPTION 'Initial private client visibility projection required';
  END IF;
END
$business_prerequisites$;

GRANT SELECT (account_owner_version) ON public.clients TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, client_id, rank, user_id)
  ON public.client_ordered_owners TO capiro_private_projection_owner;
GRANT SELECT (id, tenant_id, client_id, user_id, role, created_at)
  ON public.client_team_members TO capiro_private_projection_owner;
GRANT SELECT (
  id, tenant_id, client_id, member_id, member_name, source_directory, party, state,
  chamber, committee, staff_kind, tier, source, added_by_user_id, added_at
) ON public.client_targets TO capiro_private_projection_owner;
-- users is global, deliberately without tenant RLS. Only these four identity
-- columns may be read by the isolated view owner, through assigned-client joins.
-- No signature, Clerk identity, credentials, unassigned directory, or reader grant.
GRANT SELECT (id, email, first_name, last_name)
  ON public.users TO capiro_private_projection_owner;

SET ROLE capiro_private_projection_owner;

CREATE VIEW meri_private.client_team_roster
WITH (security_barrier = true, security_invoker = false) AS
SELECT o.client_id, o.user_id, NULL::uuid AS membership_id,
  u.email::text AS email, u.first_name, u.last_name, m.role,
  o.rank = 1 AS is_primary_owner, NULL::timestamptz AS added_at,
  o.rank AS owner_rank,
  EXISTS (
    SELECT 1 FROM public.tenant_memberships tm
    WHERE tm.tenant_id = o.tenant_id AND tm.user_id = o.user_id AND tm.status::text = 'active'
  ) AS owner_available
FROM public.client_ordered_owners o
JOIN meri_private.visible_clients v ON v.tenant_id = o.tenant_id AND v.client_id = o.client_id
JOIN public.users u ON u.id = o.user_id
LEFT JOIN public.client_team_members m
  ON m.tenant_id = o.tenant_id AND m.client_id = o.client_id AND m.user_id = o.user_id
UNION ALL
SELECT m.client_id, m.user_id, m.id AS membership_id,
  u.email::text AS email, u.first_name, u.last_name, m.role,
  false AS is_primary_owner, m.created_at AS added_at,
  NULL::integer AS owner_rank, NULL::boolean AS owner_available
FROM public.client_team_members m
JOIN meri_private.visible_clients v ON v.tenant_id = m.tenant_id AND v.client_id = m.client_id
JOIN public.users u ON u.id = m.user_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.client_ordered_owners o
  WHERE o.tenant_id = m.tenant_id AND o.client_id = m.client_id AND o.user_id = m.user_id
);

CREATE VIEW meri_private.client_account_owners
WITH (security_barrier = true, security_invoker = false) AS
SELECT o.client_id, o.rank, o.user_id,
  (ARRAY['Primary','Secondary','Tertiary','Quaternary'])[o.rank] AS label,
  coalesce(tm.status::text = 'active' AND u.email::text <> '', false) AS available,
  CASE WHEN tm.status::text = 'active' AND u.email::text <> '' THEN u.id END AS person_id,
  CASE WHEN tm.status::text = 'active' AND u.email::text <> '' THEN u.email::text END AS email,
  CASE WHEN tm.status::text = 'active' AND u.email::text <> '' THEN u.first_name END AS first_name,
  CASE WHEN tm.status::text = 'active' AND u.email::text <> '' THEN u.last_name END AS last_name,
  c.account_owner_version AS assignment_version
FROM public.client_ordered_owners o
JOIN meri_private.visible_clients v ON v.tenant_id = o.tenant_id AND v.client_id = o.client_id
JOIN public.clients c ON c.tenant_id = o.tenant_id AND c.id = o.client_id
LEFT JOIN public.tenant_memberships tm ON tm.tenant_id = o.tenant_id AND tm.user_id = o.user_id
LEFT JOIN public.users u ON u.id = o.user_id;

CREATE VIEW meri_private.client_targets
WITH (security_barrier = true, security_invoker = false) AS
SELECT t.id, t.client_id, t.member_id, t.member_name, t.source_directory,
  t.party, t.state, t.chamber, t.committee, t.staff_kind AS stored_staff_kind,
  t.tier, t.source, t.added_by_user_id, t.added_at
FROM public.client_targets t
JOIN meri_private.visible_clients v ON v.tenant_id = t.tenant_id AND v.client_id = t.client_id;

RESET ROLE;
REVOKE ALL ON meri_private.client_team_roster, meri_private.client_account_owners,
  meri_private.client_targets FROM PUBLIC;
GRANT SELECT ON meri_private.client_team_roster, meri_private.client_account_owners,
  meri_private.client_targets TO capiro_private_query_ro;

COMMENT ON VIEW meri_private.client_team_roster IS
  'Saved client roster under visible_clients. Ranked owners merge once with their explicit role; assignment is not authorization.';
COMMENT ON VIEW meri_private.client_account_owners IS
  'Ordered assignments retain inactive history while person fields require an active member with email. Version is a read snapshot.';
COMMENT ON VIEW meri_private.client_targets IS
  'Saved targets only. Stored directory snapshots do not claim fresh staff classification or represented facilities.';

-- PROPOSAL ONLY: new forward migration, after the separately reviewed tenant-policy prerequisite.
-- Adds nine fixed saved-data views and exact SELECT grants; no new role attributes or table definitions.
DO $prerequisite$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('client_people','engagement_campaigns','engagement_campaign_recipients')
      AND c.relrowsecurity AND c.relforcerowsecurity) <> 3 THEN
    RAISE EXCEPTION 'Saved business tenant-policy prerequisite is missing';
  END IF;
END $prerequisite$;

GRANT SELECT (id, tenant_id, name, website, description, product_description, primary_contact_name, primary_contact_email, primary_contact_phone, status, sector_tag, profile_type, profile_status, uei, cage_code, canonical_entity_id, created_by_user_id, created_at, updated_at, submission_tracks, issue_codes, naics_codes, psc_codes, applicant_types, set_aside_certifications, lda_client_ids) ON public.clients TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, client_id, id, name, title, email, phone, role, last_contact, notes, hierarchy_level, reports_to_person_id, placement_source, placement_confidence, review_required, created_at, updated_at) ON public.client_people TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, client_id, id, full_name, email, phone, organization, title, source, directory_entry_id, acquisition_personnel_id, created_at, updated_at) ON public.engagement_contacts TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, client_id, id, title, description, owner_user_id, due_date, status, source_type, created_by_user_id, created_at, updated_at) ON public.engagement_tasks TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, client_id, id, district_key, pe_code, program_id, delta_id, action_type, issue_title, what_changed, why_it_matters, recommended_action, suggested_artifact_type, deadline, deadline_source, owner_user_id, priority, uncertainty, status, dismissal_reason, outcome, created_at, updated_at) ON public.action_recommendation TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, client_id, id, bill_id, note, source, created_by, created_at, updated_at) ON public.tracked_bill TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, client_id, id, created_by_user_id, name, type, status, subject, body, sent_at, created_at, updated_at) ON public.engagement_campaigns TO capiro_private_projection_owner;
GRANT SELECT (tenant_id, id, campaign_id, name, email, title, office, status, sent_at, created_at) ON public.engagement_campaign_recipients TO capiro_private_projection_owner;

CREATE VIEW meri_private.client_profiles
WITH (security_barrier = true, security_invoker = false) AS
SELECT c.id AS client_id, c.name, c.website, c.description, c.product_description, c.primary_contact_name, c.primary_contact_email::text AS primary_contact_email, c.primary_contact_phone, c.status, c.sector_tag, c.profile_type, c.profile_status, c.uei, c.cage_code, c.canonical_entity_id, c.created_by_user_id, c.created_at, c.updated_at
FROM public.clients c
JOIN meri_private.visible_clients v ON v.tenant_id=c.tenant_id AND v.client_id=c.id
;

CREATE VIEW meri_private.client_people
WITH (security_barrier = true, security_invoker = false) AS
SELECT p.client_id, p.id, p.name, p.title, p.email::text AS email, p.phone, p.role, p.last_contact, p.notes, p.hierarchy_level AS stored_hierarchy_level, p.reports_to_person_id, p.placement_source, p.placement_confidence AS stored_placement_confidence, p.review_required AS stored_review_required, p.created_at, p.updated_at
FROM public.client_people p
JOIN meri_private.visible_clients v ON v.tenant_id=p.tenant_id AND v.client_id=p.client_id
;

CREATE VIEW meri_private.client_contacts
WITH (security_barrier = true, security_invoker = false) AS
SELECT c.client_id, c.id, c.full_name, c.email::text AS email, c.phone, c.organization, c.title, c.source, c.directory_entry_id, c.acquisition_personnel_id, c.created_at, c.updated_at
FROM public.engagement_contacts c
JOIN meri_private.visible_clients v ON v.tenant_id=c.tenant_id AND v.client_id=c.client_id
;

CREATE VIEW meri_private.client_engagement_tasks
WITH (security_barrier = true, security_invoker = false) AS
SELECT t.client_id, t.id, t.title, t.description, t.owner_user_id, t.due_date, t.status::text AS status, t.source_type, t.created_by_user_id, t.created_at, t.updated_at
FROM public.engagement_tasks t
JOIN meri_private.visible_clients v ON v.tenant_id=t.tenant_id AND v.client_id=t.client_id
WHERE t.source_type IS DISTINCT FROM 'research_portfolio_action';

CREATE VIEW meri_private.client_action_items
WITH (security_barrier = true, security_invoker = false) AS
SELECT a.client_id, a.id, a.district_key, a.pe_code, a.program_id, a.delta_id, a.action_type, a.issue_title, a.what_changed, a.why_it_matters, a.recommended_action, a.suggested_artifact_type, a.deadline, a.deadline_source, a.owner_user_id, a.priority, a.uncertainty, a.status, a.dismissal_reason, a.outcome, a.created_at, a.updated_at
FROM public.action_recommendation a
JOIN meri_private.visible_clients v ON v.tenant_id=a.tenant_id AND v.client_id=a.client_id
;

CREATE VIEW meri_private.client_tracked_bills
WITH (security_barrier = true, security_invoker = false) AS
SELECT b.client_id, b.id, b.bill_id, b.note, b.source, b.created_by, b.created_at, b.updated_at
FROM public.tracked_bill b
JOIN meri_private.visible_clients v ON v.tenant_id=b.tenant_id AND v.client_id=b.client_id
;

CREATE VIEW meri_private.client_outreach_campaigns
WITH (security_barrier = true, security_invoker = false) AS
SELECT c.client_id, c.id, c.created_by_user_id, c.name, c.type, c.status, c.subject, c.body, c.sent_at, c.created_at, c.updated_at
FROM public.engagement_campaigns c
JOIN meri_private.visible_clients v ON v.tenant_id=c.tenant_id AND v.client_id=c.client_id
;

CREATE VIEW meri_private.client_profile_codes
WITH (security_barrier = true, security_invoker = false) AS
SELECT c.id AS client_id, a.family, e.position, e.value
FROM public.clients c
JOIN meri_private.visible_clients v ON v.tenant_id=c.tenant_id AND v.client_id=c.id
CROSS JOIN LATERAL (
  SELECT 'submission_tracks'::text AS family, c.submission_tracks AS entries
  UNION ALL SELECT 'issue_codes', c.issue_codes
  UNION ALL SELECT 'naics_codes', c.naics_codes
  UNION ALL SELECT 'psc_codes', c.psc_codes
  UNION ALL SELECT 'applicant_types', c.applicant_types
  UNION ALL SELECT 'set_aside_certifications', c.set_aside_certifications
  UNION ALL SELECT 'lda_client_ids', c.lda_client_ids::text[]
) a
CROSS JOIN LATERAL pg_catalog.unnest(a.entries) WITH ORDINALITY AS e(value, position);

CREATE VIEW meri_private.client_campaign_recipients
WITH (security_barrier = true, security_invoker = false) AS
SELECT c.client_id, r.id, r.campaign_id, r.name, r.email, r.title, r.office,
  r.status, r.sent_at, r.created_at
FROM public.engagement_campaign_recipients r
JOIN public.engagement_campaigns c ON c.id=r.campaign_id AND c.tenant_id=r.tenant_id
JOIN meri_private.visible_clients v ON v.tenant_id=c.tenant_id AND v.client_id=c.client_id;

ALTER VIEW meri_private.client_profiles OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_profiles FROM PUBLIC;
GRANT SELECT ON meri_private.client_profiles TO capiro_private_query_ro;

ALTER VIEW meri_private.client_profile_codes OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_profile_codes FROM PUBLIC;
GRANT SELECT ON meri_private.client_profile_codes TO capiro_private_query_ro;

ALTER VIEW meri_private.client_people OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_people FROM PUBLIC;
GRANT SELECT ON meri_private.client_people TO capiro_private_query_ro;

ALTER VIEW meri_private.client_contacts OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_contacts FROM PUBLIC;
GRANT SELECT ON meri_private.client_contacts TO capiro_private_query_ro;

ALTER VIEW meri_private.client_engagement_tasks OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_engagement_tasks FROM PUBLIC;
GRANT SELECT ON meri_private.client_engagement_tasks TO capiro_private_query_ro;

ALTER VIEW meri_private.client_action_items OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_action_items FROM PUBLIC;
GRANT SELECT ON meri_private.client_action_items TO capiro_private_query_ro;

ALTER VIEW meri_private.client_tracked_bills OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_tracked_bills FROM PUBLIC;
GRANT SELECT ON meri_private.client_tracked_bills TO capiro_private_query_ro;

ALTER VIEW meri_private.client_outreach_campaigns OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_outreach_campaigns FROM PUBLIC;
GRANT SELECT ON meri_private.client_outreach_campaigns TO capiro_private_query_ro;

ALTER VIEW meri_private.client_campaign_recipients OWNER TO capiro_private_projection_owner;
REVOKE ALL ON meri_private.client_campaign_recipients FROM PUBLIC;
GRANT SELECT ON meri_private.client_campaign_recipients TO capiro_private_query_ro;
