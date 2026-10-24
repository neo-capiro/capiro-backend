-- Test-only extension of prerequisites.sql for actual Prisma admission writers.
-- Scalar shapes follow schema.prisma Client, ClientIntelMapping, Prospect/Activity,
-- AuditLog and LdaClient. Omitted unrelated foreign owners are not qualified here.
ALTER TABLE tenants
  ADD status text NOT NULL DEFAULT 'active',
  ADD settings_jsonb jsonb NOT NULL DEFAULT '{"clioFeatureFlags":{"businessDevelopment.enabled":true}}',
  ADD billing_status text NOT NULL DEFAULT 'active',
  ADD client_slots integer NOT NULL DEFAULT 2,
  ADD lda_registrant_id integer DEFAULT 7,
  ADD lda_registrant_name text DEFAULT 'Synthetic firm';
ALTER TABLE clients
  ADD name text NOT NULL DEFAULT 'Synthetic client',
  ADD website text, ADD description text, ADD product_description text,
  ADD primary_contact_name text, ADD primary_contact_email text, ADD primary_contact_phone text,
  ADD logo_s3_key text, ADD logo_content_type text, ADD logo_uploaded_at timestamptz,
  ADD intake_data_jsonb jsonb NOT NULL DEFAULT '{}', ADD sector_tag text,
  ADD profile_type text DEFAULT 'CLIENT', ADD profile_status text NOT NULL DEFAULT 'ACTIVE',
  ADD submission_tracks text[] NOT NULL DEFAULT '{}', ADD issue_codes text[] NOT NULL DEFAULT '{}',
  ADD uei varchar(12), ADD cage_code varchar(5), ADD naics_codes text[] NOT NULL DEFAULT '{}',
  ADD psc_codes text[] NOT NULL DEFAULT '{}', ADD applicant_types text[] NOT NULL DEFAULT '{}',
  ADD set_aside_certifications text[] NOT NULL DEFAULT '{}', ADD lda_client_ids integer[] NOT NULL DEFAULT '{}',
  ADD tango_entity_last_synced_at timestamptz, ADD tango_entity_last_attempt_at timestamptz,
  ADD tango_entity_last_error text, ADD created_by_user_id uuid,
  ADD created_at timestamptz NOT NULL DEFAULT now(), ADD updated_at timestamptz NOT NULL DEFAULT now(),
  ADD canonical_entity_id uuid;
CREATE UNIQUE INDEX a2_clients_canonical ON clients(tenant_id,canonical_entity_id) WHERE canonical_entity_id IS NOT NULL;
CREATE TABLE canonical_entities (
  id uuid PRIMARY KEY,canonical_name text NOT NULL,normalized_name text NOT NULL,entity_type varchar(64) NOT NULL
);
CREATE TABLE business_development_prospects (
  id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),canonical_entity_id uuid REFERENCES canonical_entities(id),
  display_name text NOT NULL,domain text,website text,description text,service_hypothesis text,geography text,
  owner_user_id uuid,stage varchar(16) NOT NULL DEFAULT 'researching',status varchar(16) NOT NULL DEFAULT 'active',
  dismissed_at timestamptz,conflict_excluded boolean NOT NULL DEFAULT false,conflict_reason text,
  next_action text,next_action_due_at timestamptz,linked_client_id uuid REFERENCES clients(id),converted_at timestamptz,
  watch_requested boolean NOT NULL DEFAULT false,created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX a2_prospect_client ON business_development_prospects(linked_client_id) WHERE linked_client_id IS NOT NULL;
CREATE UNIQUE INDEX a2_prospect_canonical ON business_development_prospects(tenant_id,canonical_entity_id) WHERE canonical_entity_id IS NOT NULL;
CREATE TABLE business_development_prospect_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
  prospect_id uuid NOT NULL REFERENCES business_development_prospects(id) ON DELETE CASCADE,
  actor_user_id uuid,kind varchar(24) NOT NULL DEFAULT 'note',body text NOT NULL,
  before_jsonb jsonb,after_jsonb jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),actor_user_id uuid,
  actor_role text,action text NOT NULL,entity_type text,entity_id text,before_jsonb jsonb,after_jsonb jsonb,
  ip text,user_agent text,request_id text,occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE client_intel_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),client_id uuid NOT NULL REFERENCES clients(id),
  source text NOT NULL,external_id text NOT NULL,external_name text NOT NULL,confidence double precision NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,match_basis varchar(40),match_tier integer,match_evidence_jsonb jsonb,
  relationship_type varchar(24),roll_up_awards boolean,review_status varchar(16) NOT NULL DEFAULT 'candidate',
  reviewed_by uuid,reviewed_at timestamptz,rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(client_id,source,external_id)
);
CREATE TABLE lda_client (
  id integer PRIMARY KEY,name text NOT NULL,general_description text,state text,country text NOT NULL DEFAULT 'US',
  effective_date date,total_filings integer NOT NULL DEFAULT 0,total_spending numeric(18,2),latest_filing_year integer,
  issue_codes text[] NOT NULL DEFAULT '{}',last_synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lda_filing (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),registrant_id integer,client_id integer);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['business_development_prospects','business_development_prospect_activity','audit_logs','client_intel_mapping'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id())',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON business_development_prospects,business_development_prospect_activity,audit_logs,client_intel_mapping TO capiro_app;
GRANT SELECT ON canonical_entities,lda_client,lda_filing TO capiro_app;
