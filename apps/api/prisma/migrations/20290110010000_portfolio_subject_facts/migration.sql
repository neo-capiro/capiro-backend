-- Expand the existing research owner. Historical client runs remain valid.
ALTER TABLE client_profile_fill_run ADD COLUMN prospect_id uuid;
ALTER TABLE client_profile_fill_run ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE client_profile_fill_run ADD CONSTRAINT profile_run_subject CHECK (num_nonnulls(client_id,prospect_id)=1);
ALTER TABLE client_profile_fill_run ADD CONSTRAINT profile_run_client_fk FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id);
ALTER TABLE client_profile_fill_run ADD CONSTRAINT profile_run_prospect_fk FOREIGN KEY(tenant_id,prospect_id) REFERENCES business_development_prospects(tenant_id,id);
ALTER TABLE client_profile_fill_run ADD CONSTRAINT profile_run_prospect_scope UNIQUE(id,tenant_id,prospect_id);
CREATE INDEX profile_run_prospect_created ON client_profile_fill_run(tenant_id,prospect_id,created_at DESC) WHERE prospect_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['client_profile_fill_task','client_profile_fill_extension_task','client_profile_fill_finding'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN prospect_id uuid',t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN client_id DROP NOT NULL',t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK(num_nonnulls(client_id,prospect_id)=1)',t,t||'_subject');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(run_id,tenant_id,prospect_id) REFERENCES client_profile_fill_run(id,tenant_id,prospect_id) ON DELETE CASCADE',t,t||'_prospect_run_fk');
    EXECUTE format('CREATE INDEX %I ON %I(tenant_id,prospect_id,run_id)',t||'_prospect_idx',t);
  END LOOP;
END $$;
-- Provenance may cross subjects during conversion, but never a tenant boundary.
CREATE UNIQUE INDEX profile_run_tenant_id_key ON client_profile_fill_run(tenant_id,id);
CREATE UNIQUE INDEX profile_finding_tenant_id_key ON client_profile_fill_finding(tenant_id,id);
CREATE UNIQUE INDEX profile_finding_tenant_run_id_key ON client_profile_fill_finding(tenant_id,run_id,id);
CREATE UNIQUE INDEX profile_attachment_tenant_id_key ON engagement_attachments(tenant_id,id);
CREATE UNIQUE INDEX profile_attachment_prospect_scope_key ON engagement_attachments(tenant_id,prospect_id,id);
CREATE TABLE profile_fact (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 client_id uuid, prospect_id uuid, field_key text NOT NULL, value_jsonb jsonb NOT NULL,
 origin text NOT NULL CHECK(origin IN ('person','research','official','legacy')),
 source_type text, source_url text, attachment_id uuid, evidence_jsonb jsonb NOT NULL DEFAULT '[]',
 observed_at timestamptz, confidence numeric CHECK(confidence BETWEEN 0 AND 1),
 status text NOT NULL CHECK(status IN ('pending','approved','rejected','superseded')),
 is_current boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 approved_by uuid, approved_at timestamptz, supersedes_id uuid,
 finding_id uuid, run_id uuid,
 canonical_entity_id uuid REFERENCES canonical_entities(id), origin_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(client_id,prospect_id)=1), CHECK(NOT is_current OR status='approved'),
 FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id),
 FOREIGN KEY(tenant_id,prospect_id) REFERENCES business_development_prospects(tenant_id,id),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,client_id,field_key,id), UNIQUE(tenant_id,prospect_id,field_key,id),
 FOREIGN KEY(tenant_id,finding_id) REFERENCES client_profile_fill_finding(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES client_profile_fill_run(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id,finding_id) REFERENCES client_profile_fill_finding(tenant_id,run_id,id),
 FOREIGN KEY(tenant_id,attachment_id) REFERENCES engagement_attachments(tenant_id,id) ON DELETE SET NULL (attachment_id),
 FOREIGN KEY(tenant_id,client_id,field_key,supersedes_id) REFERENCES profile_fact(tenant_id,client_id,field_key,id),
 FOREIGN KEY(tenant_id,prospect_id,field_key,supersedes_id) REFERENCES profile_fact(tenant_id,prospect_id,field_key,id)
);
CREATE UNIQUE INDEX profile_fact_origin ON profile_fact(tenant_id,COALESCE(client_id,prospect_id), (client_id IS NOT NULL),origin_id);
CREATE UNIQUE INDEX profile_fact_current ON profile_fact(tenant_id,COALESCE(client_id,prospect_id),(client_id IS NOT NULL),field_key) WHERE is_current;
CREATE INDEX profile_fact_subject ON profile_fact(tenant_id,client_id,prospect_id,created_at);
CREATE TABLE profile_fact_conflict (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 client_id uuid,prospect_id uuid,field_key text NOT NULL,current_fact_id uuid NOT NULL,proposed_fact_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
 resolution text CHECK(resolution IN ('keep_current','accept_proposed')),version integer NOT NULL DEFAULT 1,
 resolved_by uuid,resolved_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(client_id,prospect_id)=1),
 FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id),
 FOREIGN KEY(tenant_id,prospect_id) REFERENCES business_development_prospects(tenant_id,id),
 CHECK(current_fact_id<>proposed_fact_id),
 FOREIGN KEY(tenant_id,client_id,field_key,current_fact_id) REFERENCES profile_fact(tenant_id,client_id,field_key,id),
 FOREIGN KEY(tenant_id,prospect_id,field_key,current_fact_id) REFERENCES profile_fact(tenant_id,prospect_id,field_key,id),
 FOREIGN KEY(tenant_id,client_id,field_key,proposed_fact_id) REFERENCES profile_fact(tenant_id,client_id,field_key,id),
 FOREIGN KEY(tenant_id,prospect_id,field_key,proposed_fact_id) REFERENCES profile_fact(tenant_id,prospect_id,field_key,id),
 UNIQUE(current_fact_id,proposed_fact_id), UNIQUE(proposed_fact_id)
);
CREATE TABLE profile_entity_candidate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid,prospect_id uuid,
 canonical_entity_id uuid NOT NULL REFERENCES canonical_entities(id),evidence_jsonb jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','chosen','rejected')),
 reviewed_by uuid,reviewed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(client_id,prospect_id)=1),
 FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id),
 FOREIGN KEY(tenant_id,prospect_id) REFERENCES business_development_prospects(tenant_id,id)
);
CREATE UNIQUE INDEX profile_entity_candidate_subject ON profile_entity_candidate(tenant_id,COALESCE(client_id,prospect_id),(client_id IS NOT NULL),canonical_entity_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['profile_fact','profile_fact_conflict','profile_entity_candidate'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(rls_bypass() OR tenant_id=current_tenant_id()) WITH CHECK(rls_bypass() OR tenant_id=current_tenant_id())',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO capiro_app',t); END IF;
 END LOOP;
END $$;
-- Preserve pre-existing values without inventing source evidence or review dates.
INSERT INTO profile_fact(tenant_id,client_id,field_key,value_jsonb,origin,status,is_current,origin_id)
SELECT c.tenant_id,c.id,kv.key,kv.value,'legacy','approved',true,'legacy:field:'||kv.key
FROM clients c CROSS JOIN LATERAL jsonb_each(jsonb_build_object('name',c.name,'website',c.website,'description',c.description,
 'productDescription',c.product_description,'uei',c.uei,'cageCode',c.cage_code,'naicsCodes',c.naics_codes,'pscCodes',c.psc_codes)) kv
WHERE kv.value<>'null'::jsonb AND kv.value<>'[]'::jsonb AND kv.value<>'""'::jsonb;
INSERT INTO profile_fact(tenant_id,prospect_id,field_key,value_jsonb,origin,status,is_current,origin_id)
SELECT p.tenant_id,p.id,kv.key,kv.value,'legacy','approved',true,'legacy:field:'||kv.key
FROM business_development_prospects p CROSS JOIN LATERAL jsonb_each(jsonb_build_object('name',p.display_name,'website',p.website,'description',p.description)) kv
WHERE kv.value<>'null'::jsonb AND kv.value<>'""'::jsonb;
CREATE TABLE profile_attachment_link (
 tenant_id uuid NOT NULL,client_id uuid NOT NULL,prospect_id uuid NOT NULL,attachment_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,client_id,attachment_id),
 FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id),
 FOREIGN KEY(tenant_id,prospect_id) REFERENCES business_development_prospects(tenant_id,id),
 FOREIGN KEY(tenant_id,prospect_id,attachment_id) REFERENCES engagement_attachments(tenant_id,prospect_id,id) ON DELETE CASCADE
);
ALTER TABLE profile_attachment_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_attachment_link FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON profile_attachment_link USING(rls_bypass() OR tenant_id=current_tenant_id()) WITH CHECK(rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON profile_attachment_link TO capiro_app; END IF; END $$;
