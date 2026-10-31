-- PROPOSAL: forward-only; local qualification only. No live application authorization.
-- New isolated owner and four restricted projections; historical grants unchanged.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog;
-- Hold base definitions stable from their validation through view creation.
LOCK TABLE public.committee_hearing, public.committee_hearing_bill, public.legislative_agenda_item, public.state_bill_calendar_event IN ACCESS SHARE MODE;
DO $pre$
DECLARE r record; n integer;
BEGIN
 IF current_setting('server_version_num')::integer < 160000 THEN RAISE EXCEPTION 'Requires PostgreSQL16 role semantics'; END IF;
 IF current_database() <> 'capiro' THEN RAISE EXCEPTION 'Unexpected database'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_public_query_owner') THEN RAISE EXCEPTION 'Projection owner collision; no reconciliation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_analytics_ro' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN RAISE EXCEPTION 'Dedicated reader missing or unsafe'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member='capiro_analytics_ro'::regrole) THEN RAISE EXCEPTION 'Reader membership drift'; END IF;
 IF has_schema_privilege('capiro_analytics_ro','public','CREATE') THEN RAISE EXCEPTION 'Reader can create public objects'; END IF;
 IF EXISTS(SELECT 1 FROM pg_database WHERE datdba='capiro_analytics_ro'::regrole) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner='capiro_analytics_ro'::regrole) OR EXISTS(SELECT 1 FROM pg_class WHERE relowner='capiro_analytics_ro'::regrole) THEN RAISE EXCEPTION 'Reader ownership drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' AND (has_table_privilege('capiro_analytics_ro',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('capiro_analytics_ro',c.oid,'INSERT,UPDATE,REFERENCES'))) THEN RAISE EXCEPTION 'Reader effective write drift'; END IF;
 FOR r IN SELECT unnest(ARRAY['public.meri_public_committee_hearings','public.meri_public_committee_hearing_bills','public.meri_public_legislative_agenda_items','public.meri_public_state_bill_calendar_events']) name LOOP
  IF to_regclass(r.name) IS NOT NULL THEN RAISE EXCEPTION 'Projection collision: %',r.name; END IF;
 END LOOP;
 FOR r IN SELECT unnest(ARRAY['public.committee_hearing','public.committee_hearing_bill','public.legislative_agenda_item','public.state_bill_calendar_event']) name LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(r.name) AND relkind='r' AND relowner=current_user::regrole AND NOT relrowsecurity) THEN RAISE EXCEPTION 'Base shape/owner/RLS requires review: %',r.name; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='id' WHERE i.indrelid=to_regclass(r.name) AND i.indisprimary AND i.indisvalid AND i.indnkeyatts=1 AND i.indkey[0]=a.attnum) THEN RAISE EXCEPTION 'Base primary identity drift: %',r.name; END IF;
  IF has_table_privilege('capiro_analytics_ro',to_regclass(r.name),'SELECT') OR has_any_column_privilege('capiro_analytics_ro',to_regclass(r.name),'SELECT') THEN RAISE EXCEPTION 'Raw reader access exists: %; separate disposition required',r.name; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES ('public.committee_hearing','id','text',false),
('public.committee_hearing','geographic_jurisdiction','text',true),
('public.committee_hearing','legislative_session','text',true),
('public.committee_hearing','congress','integer',true),
('public.committee_hearing','chamber','text',false),
('public.committee_hearing','committee_name','text',false),
('public.committee_hearing','committee_system_code','text',true),
('public.committee_hearing','state_committee_id','text',true),
('public.committee_hearing','title','text',false),
('public.committee_hearing','type','text',true),
('public.committee_hearing','date','date',false),
('public.committee_hearing','starts_at','timestamp(6) with time zone',true),
('public.committee_hearing','scheduled_end','timestamp(6) with time zone',true),
('public.committee_hearing','timezone','text',false),
('public.committee_hearing','time_precision','text',true),
('public.committee_hearing','location','text',true),
('public.committee_hearing','event_status','text',false),
('public.committee_hearing','url','text',true),
('public.committee_hearing','source_revision','integer',false),
('public.committee_hearing','last_official_update_at','timestamp(6) with time zone',true),
('public.committee_hearing','calendar_revision','integer',false),
('public.committee_hearing','calendar_checked_at','timestamp(6) with time zone',true),
('public.committee_hearing','calendar_check_state','text',false),
('public.committee_hearing','synced_at','timestamp(6) with time zone',false),
('public.committee_hearing_bill','id','text',false),
('public.committee_hearing_bill','hearing_id','text',false),
('public.committee_hearing_bill','bill_id','text',false),
('public.committee_hearing_bill','congress','integer',false),
('public.committee_hearing_bill','synced_at','timestamp(6) with time zone',false),
('public.legislative_agenda_item','id','uuid',false),
('public.legislative_agenda_item','hearing_id','text',false),
('public.legislative_agenda_item','item_key','text',false),
('public.legislative_agenda_item','position','integer',false),
('public.legislative_agenda_item','kind','text',false),
('public.legislative_agenda_item','title','text',false),
('public.legislative_agenda_item','bill_scope','text',true),
('public.legislative_agenda_item','state_bill_key','text',true),
('public.legislative_agenda_item','federal_bill_id','text',true),
('public.legislative_agenda_item','source_url','text',false),
('public.legislative_agenda_item','active','boolean',false),
('public.legislative_agenda_item','revision','integer',false),
('public.legislative_agenda_item','first_seen_at','timestamp(6) with time zone',false),
('public.legislative_agenda_item','last_seen_at','timestamp(6) with time zone',false),
('public.state_bill_calendar_event','id','uuid',false),
('public.state_bill_calendar_event','bill_key','text',false),
('public.state_bill_calendar_event','event_key','text',false),
('public.state_bill_calendar_event','event_type','text',false),
('public.state_bill_calendar_event','date','date',false),
('public.state_bill_calendar_event','time','text',true),
('public.state_bill_calendar_event','location','text',true),
('public.state_bill_calendar_event','present','boolean',false),
('public.state_bill_calendar_event','first_seen_at','timestamp(6) with time zone',false),
('public.state_bill_calendar_event','last_synced_at','timestamp(6) with time zone',false),
('public.committee_hearing','canonical_hearing_id','text',true),
('public.committee_hearing','visibility','text',false)) AS required(relation_name,column_name,column_type,nullable) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass(r.relation_name) AND attname=r.column_name AND NOT attisdropped AND format_type(atttypid,atttypmod)=r.column_type AND attnotnull=NOT r.nullable) THEN RAISE EXCEPTION 'Required source column drift: %.%',r.relation_name,r.column_name; END IF;
 END LOOP;
END
$pre$;
CREATE ROLE capiro_public_query_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- Temporary SET membership/schema CREATE only for ownership transfer, removed below.
GRANT capiro_public_query_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT USAGE, CREATE ON SCHEMA public TO capiro_public_query_owner;
GRANT SELECT ("id", "geographic_jurisdiction", "legislative_session", "congress", "chamber", "committee_name", "committee_system_code", "state_committee_id", "title", "type", "date", "starts_at", "scheduled_end", "timezone", "time_precision", "location", "event_status", "url", "source_revision", "last_official_update_at", "calendar_revision", "calendar_checked_at", "calendar_check_state", "synced_at", "canonical_hearing_id", "visibility") ON public.committee_hearing TO capiro_public_query_owner;
GRANT SELECT ("id", "hearing_id", "bill_id", "congress", "synced_at") ON public.committee_hearing_bill TO capiro_public_query_owner;
GRANT SELECT ("id", "hearing_id", "item_key", "position", "kind", "title", "bill_scope", "state_bill_key", "federal_bill_id", "source_url", "active", "revision", "first_seen_at", "last_seen_at") ON public.legislative_agenda_item TO capiro_public_query_owner;
GRANT SELECT ("id", "bill_key", "event_key", "event_type", "date", "time", "location", "present", "first_seen_at", "last_synced_at") ON public.state_bill_calendar_event TO capiro_public_query_owner;
CREATE VIEW public.meri_public_committee_hearings WITH (security_barrier=true, security_invoker=false) AS
SELECT b."id", b."geographic_jurisdiction", b."legislative_session", b."congress", b."chamber", b."committee_name", b."committee_system_code", b."state_committee_id", b."title", b."type", b."date", b."starts_at", b."scheduled_end", b."timezone", b."time_precision", b."location", b."event_status", b."url", b."source_revision", b."last_official_update_at", b."calendar_revision", b."calendar_checked_at", b."calendar_check_state", b."synced_at"
FROM public.committee_hearing b
WHERE b.canonical_hearing_id IS NULL AND b.visibility = 'public';
ALTER VIEW public.meri_public_committee_hearings OWNER TO capiro_public_query_owner;
CREATE VIEW public.meri_public_committee_hearing_bills WITH (security_barrier=true, security_invoker=false) AS
SELECT b."id", b."hearing_id", b."bill_id", b."congress", b."synced_at"
FROM public.committee_hearing_bill b
WHERE EXISTS (SELECT 1 FROM public.committee_hearing h WHERE h.id = b.hearing_id AND h.canonical_hearing_id IS NULL AND h.visibility = 'public');
ALTER VIEW public.meri_public_committee_hearing_bills OWNER TO capiro_public_query_owner;
CREATE VIEW public.meri_public_legislative_agenda_items WITH (security_barrier=true, security_invoker=false) AS
SELECT b."id", b."hearing_id", b."item_key", b."position", b."kind", b."title", b."bill_scope", b."state_bill_key", b."federal_bill_id", b."source_url", b."active", b."revision", b."first_seen_at", b."last_seen_at"
FROM public.legislative_agenda_item b
WHERE EXISTS (SELECT 1 FROM public.committee_hearing h WHERE h.id = b.hearing_id AND h.canonical_hearing_id IS NULL AND h.visibility = 'public');
ALTER VIEW public.meri_public_legislative_agenda_items OWNER TO capiro_public_query_owner;
CREATE VIEW public.meri_public_state_bill_calendar_events WITH (security_barrier=true, security_invoker=false) AS
SELECT b."id", b."bill_key", b."event_key", b."event_type", b."date", b."time", b."location", b."present", b."first_seen_at", b."last_synced_at"
FROM public.state_bill_calendar_event b;
ALTER VIEW public.meri_public_state_bill_calendar_events OWNER TO capiro_public_query_owner;
-- Act as the new owner explicitly: the migration role does not INHERIT it.
SET LOCAL ROLE capiro_public_query_owner;
-- Strip creator default grants on NEW views only; preserve every pre-existing ACL.
DO $acl$
DECLARE v text; g record;
BEGIN
 FOREACH v IN ARRAY ARRAY['public.meri_public_committee_hearings','public.meri_public_committee_hearing_bills','public.meri_public_legislative_agenda_items','public.meri_public_state_bill_calendar_events'] LOOP
  FOR g IN SELECT DISTINCT x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x WHERE c.oid=to_regclass(v) AND x.grantee<>'capiro_public_query_owner'::regrole LOOP
   EXECUTE format('REVOKE ALL ON TABLE %s FROM %s',v,CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
  END LOOP;
  EXECUTE format('GRANT SELECT ON TABLE %s TO capiro_analytics_ro',v);
 END LOOP;
END
$acl$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM capiro_public_query_owner;
REVOKE capiro_public_query_owner FROM CURRENT_USER;
DO $post$
DECLARE r record;
BEGIN
 -- PostgreSQL16 retains the creator's bootstrap-granted ADMIN-only membership.
 -- Only that migration-owner administrative custody is permitted; no SET/INHERIT.
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE member='capiro_public_query_owner'::regrole OR (roleid='capiro_public_query_owner'::regrole AND (member<>current_user::regrole OR NOT admin_option OR inherit_option OR set_option))) THEN RAISE EXCEPTION 'Projection owner membership not isolated'; END IF;
 IF has_schema_privilege('capiro_public_query_owner','public','CREATE') THEN RAISE EXCEPTION 'Projection owner retains CREATE through PUBLIC'; END IF;
 FOR r IN SELECT unnest(ARRAY['public.meri_public_committee_hearings','public.meri_public_committee_hearing_bills','public.meri_public_legislative_agenda_items','public.meri_public_state_bill_calendar_events']) name LOOP
  IF NOT has_table_privilege('capiro_analytics_ro',to_regclass(r.name),'SELECT') OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=to_regclass(r.name) AND a.grantee<>c.relowner AND (a.grantee<>'capiro_analytics_ro'::regrole OR a.privilege_type<>'SELECT' OR a.is_grantable)) THEN RAISE EXCEPTION 'Projection ACL drift: %',r.name; END IF;
 END LOOP;
 FOR r IN SELECT c.oid,c.oid::regclass::text name FROM pg_class c WHERE c.oid=ANY(ARRAY['public.committee_hearing'::regclass,'public.committee_hearing_bill'::regclass,'public.legislative_agenda_item'::regclass,'public.state_bill_calendar_event'::regclass]) LOOP
  IF has_table_privilege('capiro_public_query_owner',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('capiro_public_query_owner',r.oid,'INSERT,UPDATE,REFERENCES') THEN RAISE EXCEPTION 'Owner base table authority too broad: %',r.name; END IF;
  IF has_any_column_privilege('capiro_analytics_ro',r.oid,'SELECT') THEN RAISE EXCEPTION 'Reader raw access drift'; END IF;
 END LOOP;
 FOR r IN SELECT a.attrelid,a.attname FROM pg_attribute a WHERE a.attnum>0 AND NOT a.attisdropped AND a.attrelid=ANY(ARRAY['public.committee_hearing'::regclass,'public.committee_hearing_bill'::regclass,'public.legislative_agenda_item'::regclass,'public.state_bill_calendar_event'::regclass]) AND NOT EXISTS(SELECT 1 FROM (VALUES ('public.committee_hearing'::regclass,'id'),('public.committee_hearing'::regclass,'geographic_jurisdiction'),('public.committee_hearing'::regclass,'legislative_session'),('public.committee_hearing'::regclass,'congress'),('public.committee_hearing'::regclass,'chamber'),('public.committee_hearing'::regclass,'committee_name'),('public.committee_hearing'::regclass,'committee_system_code'),('public.committee_hearing'::regclass,'state_committee_id'),('public.committee_hearing'::regclass,'title'),('public.committee_hearing'::regclass,'type'),('public.committee_hearing'::regclass,'date'),('public.committee_hearing'::regclass,'starts_at'),('public.committee_hearing'::regclass,'scheduled_end'),('public.committee_hearing'::regclass,'timezone'),('public.committee_hearing'::regclass,'time_precision'),('public.committee_hearing'::regclass,'location'),('public.committee_hearing'::regclass,'event_status'),('public.committee_hearing'::regclass,'url'),('public.committee_hearing'::regclass,'source_revision'),('public.committee_hearing'::regclass,'last_official_update_at'),('public.committee_hearing'::regclass,'calendar_revision'),('public.committee_hearing'::regclass,'calendar_checked_at'),('public.committee_hearing'::regclass,'calendar_check_state'),('public.committee_hearing'::regclass,'synced_at'),('public.committee_hearing_bill'::regclass,'id'),('public.committee_hearing_bill'::regclass,'hearing_id'),('public.committee_hearing_bill'::regclass,'bill_id'),('public.committee_hearing_bill'::regclass,'congress'),('public.committee_hearing_bill'::regclass,'synced_at'),('public.legislative_agenda_item'::regclass,'id'),('public.legislative_agenda_item'::regclass,'hearing_id'),('public.legislative_agenda_item'::regclass,'item_key'),('public.legislative_agenda_item'::regclass,'position'),('public.legislative_agenda_item'::regclass,'kind'),('public.legislative_agenda_item'::regclass,'title'),('public.legislative_agenda_item'::regclass,'bill_scope'),('public.legislative_agenda_item'::regclass,'state_bill_key'),('public.legislative_agenda_item'::regclass,'federal_bill_id'),('public.legislative_agenda_item'::regclass,'source_url'),('public.legislative_agenda_item'::regclass,'active'),('public.legislative_agenda_item'::regclass,'revision'),('public.legislative_agenda_item'::regclass,'first_seen_at'),('public.legislative_agenda_item'::regclass,'last_seen_at'),('public.state_bill_calendar_event'::regclass,'id'),('public.state_bill_calendar_event'::regclass,'bill_key'),('public.state_bill_calendar_event'::regclass,'event_key'),('public.state_bill_calendar_event'::regclass,'event_type'),('public.state_bill_calendar_event'::regclass,'date'),('public.state_bill_calendar_event'::regclass,'time'),('public.state_bill_calendar_event'::regclass,'location'),('public.state_bill_calendar_event'::regclass,'present'),('public.state_bill_calendar_event'::regclass,'first_seen_at'),('public.state_bill_calendar_event'::regclass,'last_synced_at'),('public.committee_hearing'::regclass,'canonical_hearing_id'),('public.committee_hearing'::regclass,'visibility')) allowed(rel,col) WHERE allowed.rel=a.attrelid AND allowed.col=a.attname) LOOP
  IF has_column_privilege('capiro_public_query_owner',r.attrelid,r.attname,'SELECT') THEN RAISE EXCEPTION 'Owner excluded-column authority'; END IF;
 END LOOP;
END
$post$;
COMMIT;

