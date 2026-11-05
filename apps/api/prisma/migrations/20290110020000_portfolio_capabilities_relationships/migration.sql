-- Preserve canonical capabilities/targets and every existing client-level tracked link.
-- Historical provenance remains unknown: no fabricated URLs, dates or approvers.
ALTER TABLE client_capabilities
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'unspecified',
  ADD COLUMN review_status text NOT NULL DEFAULT 'legacy',
  ADD COLUMN provenance jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT client_capabilities_review_status_chk CHECK (review_status IN ('legacy','approved')),
  ADD CONSTRAINT client_capabilities_lifecycle_chk CHECK (lifecycle IN ('unspecified','in_service','in_development','planned')),
  ADD CONSTRAINT client_capabilities_version_chk CHECK (version > 0),
  ADD CONSTRAINT client_capabilities_tenant_client_id_key UNIQUE (tenant_id,client_id,id);
ALTER TABLE client_targets
  ADD COLUMN relationship_status text NOT NULL DEFAULT 'uncontacted',
  ADD COLUMN owner_user_id uuid,
  ADD COLUMN last_contact_at timestamptz(6),
  ADD COLUMN next_step text,
  ADD COLUMN stance text NOT NULL DEFAULT 'unknown',
  ADD COLUMN office_term text NOT NULL DEFAULT 'unknown',
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN history jsonb NOT NULL DEFAULT '[]',
  ADD CONSTRAINT client_targets_relationship_status_chk CHECK (relationship_status IN ('uncontacted','planned','introduced','in_discussion','supportive','champion','declined')),
  ADD CONSTRAINT client_targets_stance_chk CHECK (stance IN ('unknown','interested','supportive','champion','declined')),
  ADD CONSTRAINT client_targets_version_chk CHECK (version > 0),
  ADD CONSTRAINT client_targets_tenant_client_id_key UNIQUE (tenant_id,client_id,id);
-- Same provider id in different directories must not collide. Historical terms use the explicit 'unknown' marker; no term is inferred.
DROP INDEX IF EXISTS client_targets_client_member_key;
CREATE UNIQUE INDEX client_targets_client_directory_member_term_key ON client_targets(client_id,source_directory,member_id,office_term);

CREATE TABLE client_portfolio_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, client_id uuid NOT NULL, capability_id uuid,
 kind text NOT NULL CHECK (kind IN ('capability','alignment','office_recommendation','statement','case_field','sector_anchor','business_unit')),
 dedupe_key text NOT NULL, status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','draft','approved','rejected','merged','split','superseded')),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'), evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)>0),
 version integer NOT NULL DEFAULT 1 CHECK (version>0), review_history jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(review_history)='array'),
 reviewed_by_user_id uuid, reviewed_at timestamptz(6), created_at timestamptz(6) NOT NULL DEFAULT now(), updated_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT portfolio_proposals_subject_dedupe_key UNIQUE(tenant_id,client_id,kind,dedupe_key),
 CONSTRAINT portfolio_proposals_client_fk FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id) ON DELETE CASCADE,
 CONSTRAINT portfolio_proposals_capability_fk FOREIGN KEY(tenant_id,client_id,capability_id) REFERENCES client_capabilities(tenant_id,client_id,id) ON DELETE CASCADE,
 CONSTRAINT portfolio_proposals_alignment_capability_chk CHECK (kind<>'alignment' OR capability_id IS NOT NULL),
 CONSTRAINT portfolio_proposals_sector_draft_chk CHECK (kind<>'sector_anchor' OR status IN ('draft','rejected'))
);
CREATE INDEX portfolio_proposals_subject_status_idx ON client_portfolio_proposals(tenant_id,client_id,status);
CREATE TABLE client_capability_terms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, client_id uuid NOT NULL, capability_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('keyword','pe','program')), value text NOT NULL CHECK (length(btrim(value))>0), evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)>0),
 approved_by_user_id uuid NOT NULL, approved_at timestamptz(6) NOT NULL,
 CONSTRAINT capability_terms_value_key UNIQUE(tenant_id,client_id,capability_id,kind,value),
 CONSTRAINT capability_terms_client_fk FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id) ON DELETE CASCADE,
 CONSTRAINT capability_terms_capability_fk FOREIGN KEY(tenant_id,client_id,capability_id) REFERENCES client_capabilities(tenant_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX capability_terms_subject_idx ON client_capability_terms(tenant_id,client_id);
CREATE TABLE client_capability_tracking (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, client_id uuid NOT NULL, capability_id uuid NOT NULL,
 item_kind text NOT NULL CHECK (item_kind IN ('bill','hearing','budget','grant','news','statement')), item_id text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','dismissed')),
 term_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(term_ids)='array'), history jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(history)='array'),
 created_at timestamptz(6) NOT NULL DEFAULT now(), updated_at timestamptz(6) NOT NULL DEFAULT now(),
 CONSTRAINT capability_tracking_item_key UNIQUE(tenant_id,client_id,capability_id,item_kind,item_id),
 CONSTRAINT capability_tracking_client_fk FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id) ON DELETE CASCADE,
 CONSTRAINT capability_tracking_capability_fk FOREIGN KEY(tenant_id,client_id,capability_id) REFERENCES client_capabilities(tenant_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX capability_tracking_subject_idx ON client_capability_tracking(tenant_id,client_id);
CREATE TABLE client_target_supports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, client_id uuid NOT NULL, target_id uuid NOT NULL, capability_id uuid NOT NULL,
 stance text NOT NULL DEFAULT 'interested' CHECK (stance IN ('interested','supportive','champion','declined')),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)>0), history jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(history)='array'),
 approved_by_user_id uuid NOT NULL, approved_at timestamptz(6) NOT NULL, version integer NOT NULL DEFAULT 1 CHECK (version>0),
 CONSTRAINT target_support_capability_key UNIQUE(target_id,capability_id),
 CONSTRAINT target_support_client_fk FOREIGN KEY(tenant_id,client_id) REFERENCES clients(tenant_id,id) ON DELETE CASCADE,
 CONSTRAINT target_support_capability_fk FOREIGN KEY(tenant_id,client_id,capability_id) REFERENCES client_capabilities(tenant_id,client_id,id) ON DELETE CASCADE,
 CONSTRAINT target_support_target_fk FOREIGN KEY(tenant_id,client_id,target_id) REFERENCES client_targets(tenant_id,client_id,id) ON DELETE CASCADE
);
CREATE INDEX target_support_subject_idx ON client_target_supports(tenant_id,client_id);

-- Audits are append-only across transitions; a refresh cannot erase rejection memory.
CREATE FUNCTION portfolio_review_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ordinality),'[]'::jsonb) FROM jsonb_array_elements(NEW.review_history) WITH ORDINALITY e WHERE e.ordinality<=jsonb_array_length(OLD.review_history)) IS DISTINCT FROM OLD.review_history
   OR NEW.version<>OLD.version+1
   OR NEW.tenant_id<>OLD.tenant_id OR NEW.client_id<>OLD.client_id OR NEW.kind<>OLD.kind
 THEN RAISE EXCEPTION 'Portfolio review provenance is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.status='rejected' AND NEW.status NOT IN ('rejected','proposed','draft') THEN
   RAISE EXCEPTION 'Rejected proposal requires explicit restore before review' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER portfolio_review_history_guard BEFORE UPDATE ON client_portfolio_proposals
 FOR EACH ROW EXECUTE FUNCTION portfolio_review_history_guard();

-- Each capability disposition must cite only terms approved for that exact tenant/client/capability.
CREATE FUNCTION portfolio_tracking_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requested integer; matched integer;
BEGIN
 SELECT count(DISTINCT value) INTO requested FROM jsonb_array_elements_text(NEW.term_ids);
 SELECT count(*) INTO matched FROM client_capability_terms t
 WHERE t.tenant_id=NEW.tenant_id AND t.client_id=NEW.client_id AND t.capability_id=NEW.capability_id
   AND t.id::text IN (SELECT value FROM jsonb_array_elements_text(NEW.term_ids));
 IF requested=0 OR requested<>matched THEN RAISE EXCEPTION 'Capability tracking requires approved terms in the same scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER portfolio_tracking_terms_guard BEFORE INSERT OR UPDATE ON client_capability_tracking
 FOR EACH ROW EXECUTE FUNCTION portfolio_tracking_terms_guard();

-- Tenant + ethical-wall policies complement the canonical Core actor checks and locks.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['client_portfolio_proposals','client_capability_terms','client_capability_tracking','client_target_supports'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON %I USING (rls_bypass() OR (tenant_id=current_tenant_id() AND EXISTS (SELECT 1 FROM clients c WHERE c.id=%I.client_id AND c.tenant_id=%I.tenant_id AND (NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access a WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=current_user_id()))))) WITH CHECK (rls_bypass() OR (tenant_id=current_tenant_id() AND EXISTS (SELECT 1 FROM clients c WHERE c.id=%I.client_id AND c.tenant_id=%I.tenant_id AND (NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access a WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=current_user_id())))))',tab||'_isolation',tab,tab,tab,tab,tab);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO capiro_app',tab); END IF;
 END LOOP;
END $$;
