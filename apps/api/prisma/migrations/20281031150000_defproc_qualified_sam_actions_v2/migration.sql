-- PREPARATION ONLY. No migration number or live execution authority.
-- Contract 6017b9236c0c1aa2a4b7cc49dcbd38f3d8a5ed39.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
DO $$
DECLARE role_name text; obj text;
BEGIN
 IF current_user<>'capiro_master' THEN RAISE EXCEPTION 'DEFPROC_V2_REVIEWED_MIGRATION_OWNER_REQUIRED'; END IF;
 IF to_regnamespace('defproc_v2_private') IS NOT NULL OR EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('defproc_action_asof_v2','defproc_action_coverage_asof_v2','defproc_award_asof_v2','defproc_family_asof_v2','defproc_money_flow_asof_v2'))
 THEN RAISE EXCEPTION 'DEFPROC_V2_ALREADY_PRESENT'; END IF;
 FOREACH role_name IN ARRAY ARRAY['capiro_app','capiro_defense_job','capiro_defense_job_login','capiro_defense_serve'] LOOP
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=role_name) AND (
   EXISTS(SELECT FROM pg_roles WHERE rolname=role_name AND rolsuper)
   OR pg_has_role(role_name,current_user,'USAGE') OR pg_has_role(role_name,'pg_read_all_data','USAGE') OR pg_has_role(role_name,'pg_write_all_data','USAGE'))
  THEN RAISE EXCEPTION 'DEFPROC_V2_OWNER_OR_BROAD_ROLE_CONFLICT'; END IF;
 END LOOP;
 FOREACH obj IN ARRAY ARRAY['acquisition_record_revision','acquisition_award_transaction_revision','federal_award'] LOOP
  IF NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=obj AND c.relkind='r' AND NOT c.relrowsecurity)
  THEN RAISE EXCEPTION 'DEFPROC_V2_BASE_SCHEMA_REVIEW_REQUIRED'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_views WHERE schemaname='public' AND viewname IN
 ('v_defproc_award','v_defproc_family','v_defproc_money_flow','v_defproc_reconcile','v_defproc_sam_lookup','v_defproc_vendor_name_bridge',
 'v_defproc_vendor_identity','v_defproc_vendor_alias','v_defproc_vendor_alias_coverage','v_defproc_vendor_candidates','v_defproc_vendor_identity_coverage',
 'v_defproc_vendor_sam_rollup','v_defproc_vendor_identity_v3','v_defproc_vendor_identity_v3_coverage'))<>14
 THEN RAISE EXCEPTION 'DEFPROC_V2_315_BASELINE_REQUIRED'; END IF;
END $$;
CREATE SCHEMA defproc_v2_private;
REVOKE ALL ON SCHEMA defproc_v2_private FROM PUBLIC;

CREATE FUNCTION defproc_v2_private.trim_js(v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT btrim(v,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
CREATE FUNCTION defproc_v2_private.source_text(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE t text; n numeric;
BEGIN
 IF jsonb_typeof(v)='string' THEN t:=v#>>'{}';
 ELSIF jsonb_typeof(v)='number' THEN
  n:=(v#>>'{}')::numeric;
  IF n<>trunc(n) OR abs(n)>9007199254740991 THEN RETURN NULL; END IF;
  t:=trunc(n)::text;
 ELSE RETURN NULL; END IF;
 t:=defproc_v2_private.trim_js(t);
 IF t='' OR t ~ ('['||chr(1)||'-'||chr(31)||chr(127)||']') THEN RETURN NULL; END IF;
 RETURN t;
END $$;
CREATE FUNCTION defproc_v2_private.component(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN t ~ '^[A-Z0-9][A-Z0-9-]*$' AND t<>'-NONE-' THEN t END
 FROM (SELECT defproc_v2_private.source_text(v) t) x
$$;
CREATE FUNCTION defproc_v2_private.agency(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN t ~ '^[A-Z0-9]{4}$' THEN t END
 FROM (SELECT defproc_v2_private.component(v) t) x
$$;
CREATE FUNCTION defproc_v2_private.uri_component(v text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE b bytea:=convert_to(v,'UTF8'); result text:=''; i integer; c integer;
BEGIN
 FOR i IN 0..octet_length(b)-1 LOOP
  c:=get_byte(b,i);
  IF c BETWEEN 65 AND 90 OR c BETWEEN 97 AND 122 OR c BETWEEN 48 AND 57 OR c IN (45,95,46,33,126,42,39,40,41)
  THEN result:=result||chr(c); ELSE result:=result||'%'||upper(lpad(to_hex(c),2,'0')); END IF;
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION defproc_v2_private.unuri(v text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE b bytea:=''::bytea; i integer:=1; part text;
BEGIN
 WHILE i<=length(v) LOOP
  part:=substr(v,i,1);
  IF part='%' THEN
   IF substr(v,i+1,2) !~ '^[0-9A-Fa-f]{2}$' THEN RETURN NULL; END IF;
   b:=b||decode(substr(v,i+1,2),'hex');i:=i+3;
  ELSE b:=b||convert_to(part,'UTF8');i:=i+1; END IF;
 END LOOP;
 RETURN convert_from(b,'UTF8');
EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character THEN RETURN NULL;
END $$;
CREATE FUNCTION defproc_v2_private.award_parts(v text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE a text[]:=string_to_array(v,'_');
BEGIN
 IF cardinality(a)<>6 OR a[1]<>'CONT' OR a[2]<>'AWD'
  OR defproc_v2_private.component(to_jsonb(a[3])) IS NULL
  OR defproc_v2_private.agency(to_jsonb(a[4])) IS NULL THEN RETURN NULL; END IF;
 a[3]:=defproc_v2_private.component(to_jsonb(a[3])); a[4]:=defproc_v2_private.agency(to_jsonb(a[4]));
 IF a[5]='-NONE-' AND a[6]='-NONE-' THEN RETURN ARRAY[a[3],a[4],NULL,NULL]; END IF;
 IF defproc_v2_private.component(to_jsonb(a[5])) IS NULL OR defproc_v2_private.agency(to_jsonb(a[6])) IS NULL THEN RETURN NULL; END IF;
 RETURN ARRAY[a[3],a[4],defproc_v2_private.component(to_jsonb(a[5])),defproc_v2_private.agency(to_jsonb(a[6]))];
END $$;
CREATE FUNCTION defproc_v2_private.award_key(v text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT 'usaspending|award|'||defproc_v2_private.uri_component(defproc_v2_private.trim_js(v))
$$;
CREATE FUNCTION defproc_v2_private.valid_award_key(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(v LIKE 'usaspending|award|CONT_AWD_%'
  AND defproc_v2_private.award_parts(defproc_v2_private.unuri(substr(v,19))) IS NOT NULL
  AND v=defproc_v2_private.award_key(defproc_v2_private.unuri(substr(v,19))),false)
$$;
CREATE FUNCTION defproc_v2_private.utc(v timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT CASE WHEN isfinite(v) AND extract(year FROM v AT TIME ZONE 'UTC') BETWEEN 1 AND 9999
 THEN to_char(v AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END
$$;
CREATE FUNCTION defproc_v2_private.instant(v text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE a text[]; local_stamp timestamp; z text; h integer; m integer; delta integer; result timestamptz;
BEGIN
 a:=regexp_match(v,'^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})$');
 IF a IS NULL OR a[1]='0000' OR a[4]::integer>23 OR a[5]::integer>59 OR a[6]::integer>59 THEN RETURN NULL; END IF;
 local_stamp:=make_timestamp(a[1]::integer,a[2]::integer,a[3]::integer,a[4]::integer,a[5]::integer,a[6]::integer);
 z:=a[8]; h:=CASE WHEN z='Z' THEN 0 ELSE substr(z,2,2)::integer END;
 m:=CASE WHEN z='Z' THEN 0 ELSE substr(z,5,2)::integer END;
 IF h>14 OR m>59 OR (h=14 AND m<>0) OR z='-00:00' THEN RETURN NULL; END IF;
 delta:=(h*60+m)*CASE WHEN left(z,1)='-' THEN -1 ELSE 1 END;
 result:=(local_stamp AT TIME ZONE 'UTC')-delta*interval '1 minute'
  +rpad(coalesce(a[7],''),6,'0')::integer*interval '1 microsecond';
 IF defproc_v2_private.utc(result) IS NULL THEN RETURN NULL; END IF;
 RETURN result;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE FUNCTION defproc_v2_private.money(v jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE t text;
BEGIN
 IF jsonb_typeof(v)='object' AND v ? '$samDecimalLexeme' AND (v-'$samDecimalLexeme')='{}'::jsonb THEN v:=v->'$samDecimalLexeme'; END IF;
 IF jsonb_typeof(v)<>'string' OR v IS NULL THEN RETURN NULL; END IF;
 t:=defproc_v2_private.trim_js(v#>>'{}');
 IF t !~ '^-?[0-9]{1,18}(\.[0-9]{1,2})?$' THEN RETURN NULL; END IF;
 RETURN t::numeric(20,2);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
CREATE FUNCTION defproc_v2_private.day(v text) RETURNS date
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE d date;
BEGIN
 IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T]00:00:00(\.0{1,6})?)?$' THEN RETURN NULL; END IF;
 d:=make_date(substr(v,1,4)::integer,substr(v,6,2)::integer,substr(v,9,2)::integer);
 RETURN d;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN NULL;
END $$;
CREATE FUNCTION defproc_v2_private.row_object(r public.acquisition_award_transaction_revision) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',r.id::text,'transactionIdentityKey',r.transaction_identity_key,
 'awardIdentityKey',r.award_identity_key,'parentAwardIdentityKey',r.parent_award_identity_key,
 'sourceSystem',r.source_system,'sourceTransactionId',r.source_transaction_id,'piid',r.piid,
 'modificationNumber',r.modification_number,'actionDate',to_char(r.action_date,'YYYY-MM-DD'),
 'signedObligationDelta',r.signed_obligation_delta::text,'signedOutlayDelta',r.signed_outlay_delta::text,
 'recordedAt',defproc_v2_private.utc(r.recorded_at),'sourceObservedAt',defproc_v2_private.utc(r.source_observed_at),
 'supersedesId',r.supersedes_id::text,'correctsIdentityKey',r.corrects_identity_key,'sourceUrl',r.source_url,'raw',r.raw_jsonb)
$$;

CREATE TABLE defproc_v2_private.target_binding (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 target_id text NOT NULL CHECK(target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 database_name name NOT NULL CHECK(database_name=current_database()),
 resource_identity text NOT NULL CHECK(length(resource_identity)>0),
 evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$')
);
-- Deliberately empty. Independent target custody must bind this before any approval.
CREATE TABLE public.defproc_producer_qualification_v2 (
 contract_id text NOT NULL CHECK(contract_id='sam-contract-action/v2'),
 producer_commit char(40) NOT NULL CHECK(producer_commit ~ '^[0-9a-f]{40}$'),
 image_digest text NOT NULL CHECK(image_digest ~ '^sha256:[0-9a-f]{64}$'),
 run_id text NOT NULL CHECK(run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 target_id text NOT NULL CHECK(target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 completed_at timestamptz(6) NOT NULL, approved_at timestamptz(6) NOT NULL,
 revoked_at timestamptz(6), award_identity_keys text[] NOT NULL,
 member_count bigint NOT NULL CHECK(member_count BETWEEN 1 AND 9007199254740991),
 manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 scope_description text NOT NULL CHECK(length(btrim(scope_description))>0),
 PRIMARY KEY(contract_id,producer_commit,image_digest,run_id,target_id),
 CHECK(completed_at<=approved_at),
 CHECK((defproc_v2_private.utc(completed_at) IS NOT NULL AND defproc_v2_private.utc(approved_at) IS NOT NULL
  AND (revoked_at IS NULL OR defproc_v2_private.utc(revoked_at) IS NOT NULL)) IS TRUE)
);
CREATE TABLE public.defproc_producer_qualification_member_v2 (
 contract_id text NOT NULL, producer_commit char(40) NOT NULL, image_digest text NOT NULL,
 run_id text NOT NULL, target_id text NOT NULL, revision_id uuid NOT NULL,
 source_payload_hash char(64) NOT NULL CHECK(source_payload_hash ~ '^[0-9a-f]{64}$'),
 row_content_hash char(64) NOT NULL CHECK(row_content_hash ~ '^[0-9a-f]{64}$'),
 reviewed_row jsonb NOT NULL CHECK(jsonb_typeof(reviewed_row)='object'),
 PRIMARY KEY(contract_id,producer_commit,image_digest,run_id,target_id,revision_id),
 FOREIGN KEY(contract_id,producer_commit,image_digest,run_id,target_id)
 REFERENCES public.defproc_producer_qualification_v2 ON UPDATE RESTRICT ON DELETE RESTRICT,
 FOREIGN KEY(revision_id) REFERENCES public.acquisition_award_transaction_revision(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE FUNCTION defproc_v2_private.immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'DEFPROC_V2_IMMUTABLE'; END $$;
CREATE TRIGGER target_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON defproc_v2_private.target_binding
 FOR EACH STATEMENT EXECUTE FUNCTION defproc_v2_private.immutable();
CREATE TRIGGER member_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.defproc_producer_qualification_member_v2
 FOR EACH STATEMENT EXECUTE FUNCTION defproc_v2_private.immutable();
CREATE TRIGGER header_no_delete BEFORE DELETE OR TRUNCATE ON public.defproc_producer_qualification_v2
 FOR EACH STATEMENT EXECUTE FUNCTION defproc_v2_private.immutable();
CREATE FUNCTION defproc_v2_private.header_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE total integer; distinct_count integer; key text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') OR
   (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) OR
   (OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'DEFPROC_V2_HEADER_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'DEFPROC_V2_INITIAL_REVOCATION'; END IF;
 IF NOT EXISTS(SELECT FROM defproc_v2_private.target_binding WHERE target_id=NEW.target_id AND database_name=current_database())
 THEN RAISE EXCEPTION 'DEFPROC_V2_TARGET_UNBOUND'; END IF;
 SELECT count(*),count(DISTINCT k) INTO total,distinct_count FROM unnest(NEW.award_identity_keys) k;
 IF total=0 OR total<>distinct_count THEN RAISE EXCEPTION 'DEFPROC_V2_AWARD_SCOPE'; END IF;
 FOREACH key IN ARRAY NEW.award_identity_keys LOOP
  IF NOT defproc_v2_private.valid_award_key(key) THEN RAISE EXCEPTION 'DEFPROC_V2_AWARD_SCOPE'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER header_guard BEFORE INSERT OR UPDATE ON public.defproc_producer_qualification_v2
 FOR EACH ROW EXECUTE FUNCTION defproc_v2_private.header_guard();
CREATE FUNCTION defproc_v2_private.member_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r public.acquisition_award_transaction_revision; q public.defproc_producer_qualification_v2; p jsonb;
BEGIN
 SELECT * INTO STRICT q FROM public.defproc_producer_qualification_v2 WHERE
 (contract_id,producer_commit,image_digest,run_id,target_id)=(NEW.contract_id,NEW.producer_commit,NEW.image_digest,NEW.run_id,NEW.target_id) FOR UPDATE;
 SELECT * INTO STRICT r FROM public.acquisition_award_transaction_revision WHERE id=NEW.revision_id;
 p:=r.raw_jsonb->'acquisitionProvenance';
 IF q.revoked_at IS NOT NULL OR r.recorded_at>q.completed_at
  OR defproc_v2_private.row_object(r) IS DISTINCT FROM NEW.reviewed_row
  OR r.award_identity_key<>ALL(q.award_identity_keys)
  OR (p->>'contract',p->>'producerCommit',p->>'imageDigest',p->>'runId',p->>'targetId') IS DISTINCT FROM
   (NEW.contract_id,NEW.producer_commit::text,NEW.image_digest,NEW.run_id,NEW.target_id)
  OR p->>'sourcePayloadHash' IS DISTINCT FROM NEW.source_payload_hash::text
 THEN RAISE EXCEPTION 'DEFPROC_V2_MEMBER_CONTENT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_guard BEFORE INSERT ON public.defproc_producer_qualification_member_v2
 FOR EACH ROW EXECUTE FUNCTION defproc_v2_private.member_guard();
CREATE FUNCTION defproc_v2_private.population_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE q public.defproc_producer_qualification_v2; n bigint; digest text;
BEGIN
 SELECT * INTO STRICT q FROM public.defproc_producer_qualification_v2 WHERE
 (contract_id,producer_commit,image_digest,run_id,target_id)=(NEW.contract_id,NEW.producer_commit,NEW.image_digest,NEW.run_id,NEW.target_id) FOR UPDATE;
 SELECT count(*),encode(sha256(convert_to('['||coalesce(string_agg(
  '["'||revision_id::text||'","'||source_payload_hash::text||'","'||row_content_hash::text||'"]',',' ORDER BY revision_id::text COLLATE "C"),'')||']','UTF8')),'hex')
 INTO n,digest FROM public.defproc_producer_qualification_member_v2 WHERE
 (contract_id,producer_commit,image_digest,run_id,target_id)=(q.contract_id,q.producer_commit,q.image_digest,q.run_id,q.target_id);
 IF n<>q.member_count OR digest<>q.manifest_sha256::text THEN RAISE EXCEPTION 'DEFPROC_V2_INCOMPLETE_MANIFEST'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER header_complete AFTER INSERT ON public.defproc_producer_qualification_v2
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION defproc_v2_private.population_complete();
CREATE CONSTRAINT TRIGGER member_complete AFTER INSERT ON public.defproc_producer_qualification_member_v2
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION defproc_v2_private.population_complete();

-- Owner-only atomic seal. Independent review supplies canonical strings; SQL
-- verifies byte hashes plus exact object equality, never hashes jsonb::text.
CREATE FUNCTION defproc_v2_private.seal_population(header jsonb, members jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE q public.defproc_producer_qualification_v2; m jsonb; obj jsonb; payload jsonb;
BEGIN
 IF jsonb_typeof(members) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'DEFPROC_V2_MEMBERS_REQUIRED'; END IF;
 IF jsonb_typeof(header->'completed_at') IS DISTINCT FROM 'string' OR jsonb_typeof(header->'approved_at') IS DISTINCT FROM 'string'
  OR defproc_v2_private.instant(header->>'completed_at') IS NULL OR defproc_v2_private.instant(header->>'approved_at') IS NULL
 THEN RAISE EXCEPTION 'DEFPROC_V2_EXACT_HEADER_TIMESTAMPS'; END IF;
 q:=jsonb_populate_record(NULL::public.defproc_producer_qualification_v2,header);
 INSERT INTO public.defproc_producer_qualification_v2 SELECT q.*;
 FOR m IN SELECT value FROM jsonb_array_elements(members) LOOP
  IF jsonb_typeof(m->'reviewedCanonical') IS DISTINCT FROM 'string'
   OR jsonb_typeof(m->'payloadCanonical') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'DEFPROC_V2_CANONICAL_BYTES_REQUIRED'; END IF;
  obj:=(m->>'reviewedCanonical')::jsonb; payload:=(m->>'payloadCanonical')::jsonb;
  IF encode(sha256(convert_to(m->>'reviewedCanonical','UTF8')),'hex') IS DISTINCT FROM m->>'rowContentHash'
   OR encode(sha256(convert_to(m->>'payloadCanonical','UTF8')),'hex') IS DISTINCT FROM m->>'sourcePayloadHash'
   OR obj#>'{raw,sourcePayload}' IS DISTINCT FROM payload THEN RAISE EXCEPTION 'DEFPROC_V2_CANONICAL_HASH'; END IF;
  INSERT INTO public.defproc_producer_qualification_member_v2 VALUES
   (q.contract_id,q.producer_commit,q.image_digest,q.run_id,q.target_id,(m->>'revisionId')::uuid,m->>'sourcePayloadHash',m->>'rowContentHash',obj);
 END LOOP;
 -- Deferred triggers validate whole manifest at commit; same transaction sees
 -- only a fully supplied population after this function returns.
END $$;

-- Continues the same forward transaction opened by 01-foundation.sql.
CREATE FUNCTION defproc_v2_private.payload_map(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE typ text; piid text; ag text; par text; pag text; mod text; trans text;
 signed text; amount numeric; action date; rev timestamptz; aw text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 typ:=defproc_v2_private.source_text(p#>'{coreData,awardOrIDVType,code}');
 IF upper(defproc_v2_private.source_text(p#>'{coreData,awardOrIDV}')) IS DISTINCT FROM 'AWARD'
  OR typ IS NULL OR typ NOT IN ('A','B','C','D') THEN RETURN NULL; END IF;
 IF p->'oldContractId' IS NOT NULL AND p->'oldContractId'<>'null'::jsonb AND p->'oldContractId'<>'[]'::jsonb THEN RETURN NULL; END IF;
 piid:=defproc_v2_private.component(p#>'{contractId,piid}'); ag:=defproc_v2_private.agency(p#>'{contractId,subtier,code}');
 par:=defproc_v2_private.component(p#>'{contractId,referencedIDVPiid}'); pag:=defproc_v2_private.agency(p#>'{contractId,referencedIDVSubtier,code}');
 IF piid IS NULL OR ag IS NULL THEN RETURN NULL; END IF;
 IF (typ IN ('A','C') OR coalesce(p#>'{contractId,referencedIDVPiid}','null'::jsonb)<>'null'::jsonb
  OR coalesce(p#>'{contractId,referencedIDVSubtier,code}','null'::jsonb)<>'null'::jsonb) AND (par IS NULL OR pag IS NULL) THEN RETURN NULL; END IF;
 mod:=defproc_v2_private.source_text(p#>'{contractId,modificationNumber}'); trans:=defproc_v2_private.source_text(p#>'{contractId,transactionNumber}');
 IF mod IS NULL OR trans IS NULL THEN RETURN NULL; END IF;
 amount:=defproc_v2_private.money(p#>'{awardDetails,dollars,actionObligation}');
 IF amount IS NULL THEN RETURN NULL; END IF;
 signed:=defproc_v2_private.source_text(p#>'{awardDetails,dates,dateSigned}'); action:=defproc_v2_private.day(signed);
 IF coalesce(p#>'{awardDetails,dates,dateSigned}','null'::jsonb)<>'null'::jsonb AND action IS NULL THEN RETURN NULL; END IF;
 IF jsonb_typeof(p#>'{awardDetails,transactionData,lastModifiedDate}') IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
 rev:=defproc_v2_private.instant(p#>>'{awardDetails,transactionData,lastModifiedDate}');
 IF rev IS NULL THEN RETURN NULL; END IF;
 aw:='CONT_AWD_'||piid||'_'||ag||'_'||coalesce(par,'-NONE-')||'_'||coalesce(pag,'-NONE-');
 RETURN jsonb_build_object('piid',piid,'agency',ag,'parentPiid',par,'parentAgency',pag,'awardUniqueId',aw,'awardIdentityKey',defproc_v2_private.award_key(aw),
 'modificationNumber',mod,'transactionNumber',trans,'actionDate',to_char(action,'YYYY-MM-DD'),
 'obligation',amount::numeric(20,2)::text,'sourceRevisionOrder',defproc_v2_private.utc(rev),
 'sourceTransactionId','['||to_json('sam-contract-action/v2'::text)::text||','||to_json(defproc_v2_private.award_key(aw))::text||','||to_json(mod)::text||','||to_json(trans)::text||']');
END $$;
CREATE FUNCTION defproc_v2_private.active_populations(known_at timestamptz)
RETURNS SETOF public.defproc_producer_qualification_v2
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT q.* FROM public.defproc_producer_qualification_v2 q
 JOIN defproc_v2_private.target_binding b ON b.target_id=q.target_id AND b.database_name=current_database()
 JOIN LATERAL (
  SELECT count(*) n,encode(sha256(convert_to('['||coalesce(string_agg(
   '["'||m.revision_id::text||'","'||m.source_payload_hash::text||'","'||m.row_content_hash::text||'"]',',' ORDER BY m.revision_id::text COLLATE "C"),'')||']','UTF8')),'hex') digest
  FROM public.defproc_producer_qualification_member_v2 m WHERE
  (m.contract_id,m.producer_commit,m.image_digest,m.run_id,m.target_id)=(q.contract_id,q.producer_commit,q.image_digest,q.run_id,q.target_id)
 ) x ON x.n=q.member_count AND x.digest=q.manifest_sha256::text
 WHERE q.approved_at<=known_at AND q.revoked_at IS NULL
$$;
CREATE FUNCTION defproc_v2_private.initial_actions(known_at timestamptz,source_through text)
RETURNS TABLE(physical public.acquisition_award_transaction_revision,category text,source_revision_order text,award_unique_id text,transaction_number text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE x record; p jsonb; mapped jsonb; q public.defproc_producer_qualification_v2;
 member public.defproc_producer_qualification_member_v2; n bigint; candidate_key text; candidate_award text; prior public.acquisition_award_transaction_revision;
BEGIN
 IF defproc_v2_private.utc(known_at) IS NULL THEN RAISE EXCEPTION 'DEFPROC_V2_KNOWLEDGE_TIME'; END IF;
 IF source_through IS NOT NULL AND defproc_v2_private.utc(defproc_v2_private.instant(source_through)) IS DISTINCT FROM source_through
 THEN RAISE EXCEPTION 'DEFPROC_V2_SOURCE_CUTOFF'; END IF;
 FOR x IN
  WITH active AS MATERIALIZED (SELECT * FROM defproc_v2_private.active_populations(known_at))
  SELECT t AS r,h AS approval,m AS member FROM public.acquisition_award_transaction_revision t
  LEFT JOIN active h ON (h.contract_id,h.producer_commit::text,h.image_digest,h.run_id,h.target_id)=
   (t.raw_jsonb#>>'{acquisitionProvenance,contract}',t.raw_jsonb#>>'{acquisitionProvenance,producerCommit}',
    t.raw_jsonb#>>'{acquisitionProvenance,imageDigest}',t.raw_jsonb#>>'{acquisitionProvenance,runId}',t.raw_jsonb#>>'{acquisitionProvenance,targetId}')
  LEFT JOIN public.defproc_producer_qualification_member_v2 m ON
   (m.contract_id,m.producer_commit,m.image_digest,m.run_id,m.target_id,m.revision_id)=
   (h.contract_id,h.producer_commit,h.image_digest,h.run_id,h.target_id,t.id)
  WHERE t.recorded_at<=known_at
 LOOP
  physical:=x.r; q:=x.approval; member:=x.member; category:='invalid_provenance';
  source_revision_order:=NULL; award_unique_id:=NULL; transaction_number:=NULL;
  p:=physical.raw_jsonb->'acquisitionProvenance';
  IF jsonb_typeof(physical.raw_jsonb) IS DISTINCT FROM 'object' OR jsonb_typeof(p) IS DISTINCT FROM 'object'
  THEN category:='legacy'; RETURN NEXT; CONTINUE; END IF;
  IF (p->>'contract'='sam-contract-action/v2' AND p->>'producerCommit' ~ '^[a-f0-9]{40}$'
   AND p->>'imageDigest' ~ '^sha256:[a-f0-9]{64}$' AND p->>'runId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND p->>'targetId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND jsonb_typeof(physical.raw_jsonb->'sourcePayload')='object'
   AND jsonb_typeof(p->'contract')='string' AND jsonb_typeof(p->'producerCommit')='string'
   AND jsonb_typeof(p->'imageDigest')='string' AND jsonb_typeof(p->'runId')='string' AND jsonb_typeof(p->'targetId')='string') IS NOT TRUE
  THEN RETURN NEXT; CONTINUE; END IF;
  IF q.contract_id IS NULL OR member.revision_id IS NULL OR physical.recorded_at>q.completed_at
   OR member.source_payload_hash::text IS DISTINCT FROM p->>'sourcePayloadHash'
  THEN category:='unqualified_run'; RETURN NEXT; CONTINUE; END IF;
  IF member.reviewed_row IS DISTINCT FROM defproc_v2_private.row_object(physical) THEN RETURN NEXT; CONTINUE; END IF;
  mapped:=defproc_v2_private.payload_map(physical.raw_jsonb->'sourcePayload');
  IF mapped IS NULL THEN RETURN NEXT; CONTINUE; END IF;
  -- Same full-ID candidates as the writer; knowledge cutoff prevents future catalog evidence.
  SELECT count(*),min(z.identity_key),min(z.award_unique_id) INTO n,candidate_key,candidate_award FROM (
   SELECT DISTINCT a.award_unique_id,r.identity_key FROM public.federal_award a
   JOIN public.acquisition_record_revision r ON r.source_record_id=a.award_unique_id
    AND r.source_system='usaspending' AND r.record_kind='award' AND r.recorded_at<=known_at
   WHERE a.piid=mapped->>'piid' AND defproc_v2_private.award_parts(a.award_unique_id)=
    ARRAY[mapped->>'piid',mapped->>'agency',mapped->>'parentPiid',mapped->>'parentAgency']
  ) z;
  IF n=0 THEN category:='no_award_match'; RETURN NEXT; CONTINUE; END IF;
  IF n<>1 THEN category:='multiple_award_matches'; RETURN NEXT; CONTINUE; END IF;
  IF candidate_key IS DISTINCT FROM defproc_v2_private.award_key(candidate_award) THEN RETURN NEXT; CONTINUE; END IF;
  mapped:=mapped||jsonb_build_object('awardUniqueId',candidate_award,'awardIdentityKey',candidate_key,'sourceTransactionId',
   '['||to_json('sam-contract-action/v2'::text)::text||','||to_json(candidate_key)::text||','||to_json(mapped->>'modificationNumber')::text||','||to_json(mapped->>'transactionNumber')::text||']');
  IF NOT (candidate_key=ANY(q.award_identity_keys)) THEN category:='unqualified_run'; RETURN NEXT; CONTINUE; END IF;
  IF physical.source_system IS DISTINCT FROM 'sam_gov' OR physical.parent_award_identity_key IS NOT NULL
   OR physical.award_identity_key IS DISTINCT FROM candidate_key
   OR physical.source_transaction_id IS DISTINCT FROM mapped->>'sourceTransactionId'
   OR physical.transaction_identity_key IS DISTINCT FROM 'sam_gov|modification|'||defproc_v2_private.uri_component(physical.source_transaction_id)
   OR physical.piid IS DISTINCT FROM mapped->>'piid' OR physical.modification_number IS DISTINCT FROM mapped->>'modificationNumber'
   OR to_char(physical.action_date,'YYYY-MM-DD') IS DISTINCT FROM mapped->>'actionDate'
   OR physical.signed_obligation_delta IS DISTINCT FROM (mapped->>'obligation')::numeric
   OR physical.signed_outlay_delta IS NOT NULL OR p->>'awardUniqueId' IS DISTINCT FROM mapped->>'awardUniqueId'
   OR p->>'sourceRevisionOrder' IS DISTINCT FROM mapped->>'sourceRevisionOrder'
   OR defproc_v2_private.utc(physical.source_observed_at) IS NULL
  THEN RETURN NEXT; CONTINUE; END IF;
  source_revision_order:=mapped->>'sourceRevisionOrder'; award_unique_id:=mapped->>'awardUniqueId'; transaction_number:=mapped->>'transactionNumber';
  IF physical.corrects_identity_key IS NOT NULL THEN category:='invalid_chain'; RETURN NEXT; CONTINUE; END IF;
  IF physical.supersedes_id IS NOT NULL THEN
   SELECT * INTO prior FROM public.acquisition_award_transaction_revision WHERE id=physical.supersedes_id;
   IF NOT FOUND OR prior.award_identity_key<>physical.award_identity_key OR prior.transaction_identity_key<>physical.transaction_identity_key
    OR prior.recorded_at>=physical.recorded_at THEN category:='invalid_chain'; RETURN NEXT; CONTINUE; END IF;
  END IF;
  IF source_through IS NOT NULL AND source_revision_order COLLATE "C">source_through COLLATE "C"
  THEN category:='source_after_cutoff'; ELSE category:='eligible'; END IF;
  RETURN NEXT;
 END LOOP;
END $$;
CREATE FUNCTION defproc_v2_private.classified(known_at timestamptz,source_through text)
RETURNS TABLE(physical public.acquisition_award_transaction_revision,category text,source_revision_order text,award_unique_id text,transaction_number text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH initial AS MATERIALIZED(SELECT * FROM defproc_v2_private.initial_actions(known_at,source_through)),
 clocks AS(SELECT (physical).transaction_identity_key k,max(source_revision_order COLLATE "C") latest FROM initial WHERE category='eligible' GROUP BY 1),
 heads AS(SELECT c.k,count(DISTINCT (i.physical).raw_jsonb->'sourcePayload') variants,
  (array_agg((i.physical).id ORDER BY (i.physical).recorded_at,(i.physical).id))[1] selected_id
  FROM initial i JOIN clocks c ON c.k=(i.physical).transaction_identity_key AND c.latest=i.source_revision_order
  WHERE i.category='eligible' GROUP BY c.k)
 SELECT i.physical,CASE WHEN i.category<>'eligible' THEN i.category
  WHEN h.variants<>1 THEN 'source_revision_fork' WHEN (i.physical).id=h.selected_id THEN 'selected'
  WHEN i.source_revision_order=c.latest THEN 'repeated_observation' ELSE 'prior_source_revision' END,
  i.source_revision_order,i.award_unique_id,i.transaction_number
 FROM initial i LEFT JOIN clocks c ON c.k=(i.physical).transaction_identity_key LEFT JOIN heads h ON h.k=c.k
$$;

CREATE FUNCTION public.defproc_action_asof_v2(known_at timestamptz,source_through text DEFAULT NULL)
RETURNS TABLE(transaction_identity_key text,award_identity_key text,award_unique_id text,selected_revision_id uuid,
 parent_award_identity_key text,source_system text,source_transaction_id text,piid text,modification_number text,transaction_number text,
 action_date date,obligation_usd numeric(20,2),outlay_usd numeric(20,2),source_revision_order text,source_observed_at timestamptz,recorded_at timestamptz,
 corrects_identity_key text,supersedes_id uuid,source_url text,contract_id text,producer_commit text,image_digest text,run_id text,target_id text,
 source_payload_hash text,qualification_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT (c.physical).transaction_identity_key,(c.physical).award_identity_key,c.award_unique_id,(c.physical).id,
 (c.physical).parent_award_identity_key,(c.physical).source_system::text,(c.physical).source_transaction_id,(c.physical).piid,
 (c.physical).modification_number,c.transaction_number,(c.physical).action_date,(c.physical).signed_obligation_delta,
 (c.physical).signed_outlay_delta,c.source_revision_order,(c.physical).source_observed_at,(c.physical).recorded_at,
 (c.physical).corrects_identity_key,(c.physical).supersedes_id,(c.physical).source_url,
 (c.physical).raw_jsonb#>>'{acquisitionProvenance,contract}',(c.physical).raw_jsonb#>>'{acquisitionProvenance,producerCommit}',
 (c.physical).raw_jsonb#>>'{acquisitionProvenance,imageDigest}',(c.physical).raw_jsonb#>>'{acquisitionProvenance,runId}',
 (c.physical).raw_jsonb#>>'{acquisitionProvenance,targetId}',(c.physical).raw_jsonb#>>'{acquisitionProvenance,sourcePayloadHash}',
 'qualified_observed_actions'::text FROM defproc_v2_private.classified(known_at,source_through) c WHERE c.category='selected'
$$;
CREATE VIEW public.v_defproc_action_v2 WITH (security_barrier=true) AS
 SELECT transaction_identity_key,award_identity_key,award_unique_id,selected_revision_id,parent_award_identity_key,source_system,
 source_transaction_id,piid,modification_number,transaction_number,action_date,obligation_usd::numeric(20,2) obligation_usd,outlay_usd::numeric(20,2) outlay_usd,
 source_revision_order,source_observed_at::timestamptz(6) source_observed_at,recorded_at::timestamptz(6) recorded_at,corrects_identity_key,supersedes_id,
 source_url,contract_id,producer_commit,image_digest,run_id,target_id,source_payload_hash,qualification_state
 FROM public.defproc_action_asof_v2(statement_timestamp(),NULL);

CREATE FUNCTION defproc_v2_private.diagnostics_asof(known_at timestamptz,source_through text DEFAULT NULL)
RETURNS TABLE(revision_id uuid,transaction_identity_key text,award_identity_key text,parent_award_identity_key text,category text,
 obligation_usd numeric(20,2),outlay_usd numeric(20,2),source_revision_order text,award_unique_id text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT (physical).id,(physical).transaction_identity_key,(physical).award_identity_key,(physical).parent_award_identity_key,
 category,(physical).signed_obligation_delta,(physical).signed_outlay_delta,source_revision_order,award_unique_id
 FROM defproc_v2_private.classified(known_at,source_through)
$$;
CREATE FUNCTION public.defproc_action_coverage_asof_v2(known_at timestamptz,source_through text DEFAULT NULL)
RETURNS TABLE(award_identity_key text,parent_award_identity_key text,selected_actions bigint,legacy_rows bigint,unresolved_rows bigint,
 prior_revision_rows bigint,repeated_observation_rows bigint,source_after_cutoff_rows bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT award_identity_key,parent_award_identity_key,count(*) FILTER(WHERE category='selected'),count(*) FILTER(WHERE category='legacy'),
 count(*) FILTER(WHERE category IN ('source_revision_fork','unqualified_run','invalid_provenance','no_award_match','multiple_award_matches','invalid_chain')),
 count(*) FILTER(WHERE category='prior_source_revision'),count(*) FILTER(WHERE category='repeated_observation'),count(*) FILTER(WHERE category='source_after_cutoff')
 FROM defproc_v2_private.diagnostics_asof(known_at,source_through) GROUP BY award_identity_key,parent_award_identity_key
$$;
CREATE VIEW public.v_defproc_action_coverage_v2 WITH (security_barrier=true) AS
 SELECT * FROM public.defproc_action_coverage_asof_v2(statement_timestamp(),NULL);

CREATE FUNCTION defproc_v2_private.award_classified(known_at timestamptz)
RETURNS TABLE(physical public.acquisition_record_revision,category text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH initial AS MATERIALIZED(SELECT r,CASE WHEN r.source_system='usaspending' AND r.record_kind='award'
  AND defproc_v2_private.award_parts(r.source_record_id) IS NOT NULL
  AND r.identity_key=defproc_v2_private.award_key(r.source_record_id)
  AND jsonb_typeof(r.raw_jsonb->'generated_internal_id')='string' AND jsonb_typeof(r.raw_jsonb->'Award ID')='string'
  AND r.raw_jsonb->>'generated_internal_id'=r.source_record_id
  AND r.raw_jsonb->>'Award ID'=(defproc_v2_private.award_parts(r.source_record_id))[1]
  THEN 'eligible' ELSE 'invalid_award_provenance' END category
  FROM public.acquisition_record_revision r WHERE r.recorded_at<=known_at),
 clocks AS(SELECT (r).identity_key k,max((r).recorded_at) latest FROM initial WHERE category='eligible' GROUP BY 1),
 heads AS(SELECT c.k,count(DISTINCT (i.r).raw_jsonb) variants,(array_agg((i.r).id ORDER BY (i.r).id))[1] selected_id
  FROM initial i JOIN clocks c ON c.k=(i.r).identity_key AND c.latest=(i.r).recorded_at WHERE i.category='eligible' GROUP BY c.k)
 SELECT i.r,CASE WHEN i.category<>'eligible' THEN i.category WHEN h.variants<>1 THEN 'award_observation_fork'
  WHEN (i.r).id=h.selected_id THEN 'selected' ELSE 'prior_award_observation' END
 FROM initial i LEFT JOIN heads h ON h.k=(i.r).identity_key
$$;
CREATE FUNCTION public.defproc_award_asof_v2(known_at timestamptz)
RETURNS TABLE(award_identity_key text,award_unique_id text,award_revision_id uuid,piid text,awarding_agency text,
 awarding_sub_tier text,contractor_name text,recipient_uei text,attribute_recorded_at timestamptz,attribute_semantics text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT (physical).identity_key,(physical).source_record_id,(physical).id,(defproc_v2_private.award_parts((physical).source_record_id))[1],
 defproc_v2_private.source_text((physical).raw_jsonb->'Awarding Agency'),defproc_v2_private.source_text((physical).raw_jsonb->'Awarding Sub Agency'),
 defproc_v2_private.source_text((physical).raw_jsonb->'Recipient Name'),defproc_v2_private.source_text((physical).raw_jsonb->'Recipient UEI'),
 (physical).recorded_at,'latest_known_catalog_observation'::text FROM defproc_v2_private.award_classified(known_at) WHERE category='selected'
$$;
CREATE VIEW public.v_defproc_award_v2 WITH (security_barrier=true) AS
 SELECT award_identity_key,award_unique_id,award_revision_id,piid,awarding_agency,awarding_sub_tier,contractor_name,recipient_uei,
 attribute_recorded_at::timestamptz(6) attribute_recorded_at,attribute_semantics FROM public.defproc_award_asof_v2(statement_timestamp());

CREATE FUNCTION defproc_v2_private.attributed_actions(known_at timestamptz,source_through text)
RETURNS TABLE(award_identity_key text,action_date date,obligation_usd numeric,outlay_usd numeric,
 awarding_agency text,awarding_sub_tier text,contractor_name text,recipient_uei text,attribute_state text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH awards AS MATERIALIZED(SELECT * FROM public.defproc_award_asof_v2(known_at)),
 forks AS(SELECT DISTINCT (physical).identity_key k FROM defproc_v2_private.award_classified(known_at) WHERE category='award_observation_fork')
 SELECT a.award_identity_key,a.action_date,a.obligation_usd,a.outlay_usd,w.awarding_agency,w.awarding_sub_tier,w.contractor_name,w.recipient_uei,
 CASE WHEN w.award_identity_key IS NOT NULL THEN 'latest_known_catalog_observation' WHEN f.k IS NOT NULL THEN 'award_observation_fork' ELSE 'missing_catalog_attributes' END
 FROM public.defproc_action_asof_v2(known_at,source_through) a
 LEFT JOIN awards w ON w.award_identity_key=a.award_identity_key LEFT JOIN forks f ON f.k=a.award_identity_key
$$;
CREATE FUNCTION public.defproc_family_asof_v2(known_at timestamptz,source_through text DEFAULT NULL)
RETURNS TABLE(award_identity_key text,awarding_agency text,awarding_sub_tier text,contractor_name text,recipient_uei text,
 attribute_state text,actions bigint,obligation_usd numeric,outlay_usd numeric,obligation_known bigint,outlay_known bigint,first_action date,last_action date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT award_identity_key,awarding_agency,awarding_sub_tier,contractor_name,recipient_uei,attribute_state,
 count(*),sum(obligation_usd),sum(outlay_usd),count(obligation_usd),count(outlay_usd),min(action_date),max(action_date)
 FROM defproc_v2_private.attributed_actions(known_at,source_through) GROUP BY 1,2,3,4,5,6
$$;
CREATE VIEW public.v_defproc_family_v2 WITH (security_barrier=true) AS SELECT * FROM public.defproc_family_asof_v2(statement_timestamp(),NULL);
CREATE FUNCTION public.defproc_money_flow_asof_v2(known_at timestamptz,source_through text DEFAULT NULL)
RETURNS TABLE(fiscal_year integer,awarding_agency text,awarding_sub_tier text,contractor_name text,recipient_uei text,
 attribute_state text,actions bigint,obligation_usd numeric,outlay_usd numeric,obligation_known bigint,outlay_known bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN action_date IS NULL THEN NULL ELSE extract(year FROM action_date)::integer+CASE WHEN extract(month FROM action_date)>=10 THEN 1 ELSE 0 END END,
 awarding_agency,awarding_sub_tier,contractor_name,recipient_uei,attribute_state,
 count(*),sum(obligation_usd),sum(outlay_usd),count(obligation_usd),count(outlay_usd)
 FROM defproc_v2_private.attributed_actions(known_at,source_through) GROUP BY 1,2,3,4,5,6
$$;
CREATE VIEW public.v_defproc_money_flow_v2 WITH (security_barrier=true) AS SELECT * FROM public.defproc_money_flow_asof_v2(statement_timestamp(),NULL);
CREATE FUNCTION defproc_v2_private.reconcile_asof(known_at timestamptz,source_through text DEFAULT NULL)
RETURNS TABLE(category text,rows bigint,obligation_usd numeric,outlay_usd numeric,obligation_known bigint,outlay_known bigint)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH d AS MATERIALIZED(SELECT * FROM defproc_v2_private.diagnostics_asof(known_at,source_through))
 SELECT 'raw',count(*),sum(obligation_usd),sum(outlay_usd),count(obligation_usd),count(outlay_usd) FROM d
 UNION ALL SELECT category,count(*),sum(obligation_usd),sum(outlay_usd),count(obligation_usd),count(outlay_usd) FROM d GROUP BY category
 UNION ALL SELECT 'family_selected',coalesce(sum(actions),0)::bigint,sum(obligation_usd),sum(outlay_usd),coalesce(sum(obligation_known),0)::bigint,coalesce(sum(outlay_known),0)::bigint
 FROM public.defproc_family_asof_v2(known_at,source_through)
 UNION ALL SELECT 'flow_selected',coalesce(sum(actions),0)::bigint,sum(obligation_usd),sum(outlay_usd),coalesce(sum(obligation_known),0)::bigint,coalesce(sum(outlay_known),0)::bigint
 FROM public.defproc_money_flow_asof_v2(known_at,source_through)
$$;

-- New-object-only ACL reset: remove ALL default grantees, not only known roles.
-- No alteration of global/default privileges, old views or base-ledger grants.
DO $$
DECLARE x record; a record; grantee text; obj text;
BEGIN
 FOR x IN SELECT c.oid,c.relowner,c.relacl,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='defproc_v2_private' AND c.relkind IN ('r','v') OR n.nspname='public' AND c.relname IN
   ('defproc_producer_qualification_v2','defproc_producer_qualification_member_v2','v_defproc_action_v2','v_defproc_action_coverage_v2','v_defproc_award_v2','v_defproc_family_v2','v_defproc_money_flow_v2')
 LOOP
  obj:=format('%I.%I',x.nspname,x.relname);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',obj);
  FOR a IN SELECT DISTINCT e.grantee FROM aclexplode(coalesce(x.relacl,acldefault('r',x.relowner))) e WHERE e.grantee<>0 AND e.grantee<>x.relowner LOOP
   grantee:=pg_get_userbyid(a.grantee); EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',obj,grantee);
  END LOOP;
 END LOOP;
 FOR x IN SELECT p.oid,p.proowner,p.proacl,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='defproc_v2_private' OR n.nspname='public' AND p.proname IN
   ('defproc_action_asof_v2','defproc_action_coverage_asof_v2','defproc_award_asof_v2','defproc_family_asof_v2','defproc_money_flow_asof_v2')
 LOOP
  obj:=format('%I.%I(%s)',x.nspname,x.proname,x.args);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',obj);
  FOR a IN SELECT DISTINCT e.grantee FROM aclexplode(coalesce(x.proacl,acldefault('f',x.proowner))) e WHERE e.grantee<>0 AND e.grantee<>x.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',obj,pg_get_userbyid(a.grantee));
  END LOOP;
 END LOOP;
 -- A broad schema default grant would defeat the intended helper boundary.
 FOR a IN SELECT DISTINCT e.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) e
  WHERE n.nspname='defproc_v2_private' AND e.grantee<>0 AND e.grantee<>n.nspowner LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA defproc_v2_private FROM %I',pg_get_userbyid(a.grantee));
 END LOOP;
END $$;
-- Only the two relations used by the real accepted reader are application-visible.
-- Parameterized as-of equivalents expose exactly the same safe projections.
GRANT SELECT ON public.v_defproc_action_v2,public.v_defproc_action_coverage_v2 TO capiro_app;
GRANT EXECUTE ON FUNCTION public.defproc_action_asof_v2(timestamptz,text),public.defproc_action_coverage_asof_v2(timestamptz,text) TO capiro_app;
-- Family/flow/catalog diagnostics remain owner-only pending a concrete consumer
-- grant review. No name bridge is presented as legal vendor identity.
COMMIT;
