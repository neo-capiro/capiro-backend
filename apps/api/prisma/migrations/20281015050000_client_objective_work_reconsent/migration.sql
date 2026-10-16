-- Centrally reserved Objective lane. Consent/control records only; no dispatcher,
-- credential, output row, role, or current-authority grant is created here.
ALTER TABLE client_objective_work_intents
  ADD CONSTRAINT objective_work_intents_reconsent_scope_key
  UNIQUE (tenant_id,client_id,objective_id,id,objective_revision_id,
          objective_version,snapshot_hash,actor_user_id);
ALTER TABLE client_objective_canonical_plans
  ADD CONSTRAINT objective_canonical_plans_reconsent_scope_key
  UNIQUE (tenant_id,client_id,objective_id,id,epoch,canonical_strategy_id,canonical_project_id);

CREATE TABLE client_objective_work_controls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  work_action VARCHAR(40) NOT NULL CHECK (work_action IN ('objective.strategy.draft','objective.plan.prepare')),
  canonical_plan_id UUID NOT NULL,
  canonical_epoch INTEGER NOT NULL CHECK (canonical_epoch=1),
  canonical_strategy_id UUID NOT NULL,
  canonical_project_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version>=0),
  current_consent_id UUID,
  cancelled_at TIMESTAMPTZ(6),
  cancelled_by_user_id UUID,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT objective_work_controls_cancel_check CHECK (
    (cancelled_at IS NULL AND cancelled_by_user_id IS NULL) OR
    (cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)),
  CONSTRAINT objective_work_controls_state_check CHECK (
    (version=0 AND current_consent_id IS NULL AND cancelled_at IS NULL) OR
    (version>0 AND (current_consent_id IS NOT NULL OR cancelled_at IS NOT NULL))),
  CONSTRAINT objective_work_controls_scope_key UNIQUE (tenant_id,client_id,objective_id,work_action),
  CONSTRAINT objective_work_controls_lineage_key UNIQUE
    (tenant_id,client_id,objective_id,work_action,id,canonical_plan_id,
     canonical_epoch,canonical_strategy_id,canonical_project_id),
  CONSTRAINT objective_work_controls_canonical_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,canonical_plan_id,canonical_epoch,canonical_strategy_id,canonical_project_id)
    REFERENCES client_objective_canonical_plans
    (tenant_id,client_id,objective_id,id,epoch,canonical_strategy_id,canonical_project_id)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE client_objective_work_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  work_action VARCHAR(40) NOT NULL CHECK (work_action IN ('objective.strategy.draft','objective.plan.prepare')),
  control_id UUID NOT NULL,
  canonical_plan_id UUID NOT NULL,
  canonical_epoch INTEGER NOT NULL CHECK (canonical_epoch=1),
  canonical_strategy_id UUID NOT NULL,
  canonical_project_id UUID NOT NULL,
  canonical_binding_version INTEGER NOT NULL CHECK (canonical_binding_version>0),
  root_intent_id UUID NOT NULL,
  source_revision_id UUID NOT NULL,
  source_objective_version INTEGER NOT NULL CHECK (source_objective_version>0),
  source_snapshot_hash CHAR(64) NOT NULL CHECK (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  root_actor_user_id UUID NOT NULL,
  previous_consent_id UUID,
  consenting_actor_user_id UUID NOT NULL,
  consenting_membership_id UUID NOT NULL,
  consent_policy_id VARCHAR(128) NOT NULL,
  consent_policy_revision INTEGER NOT NULL,
  configured_duration_ms BIGINT NOT NULL,
  effective_duration_ms BIGINT NOT NULL,
  stricter_expires_at TIMESTAMPTZ(6),
  stricter_limit_ref VARCHAR(128),
  confirmed_at TIMESTAMPTZ(6) NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  command_request_id UUID NOT NULL,
  command_receipt_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  -- Literal product policy revision, distinct from workload policy SHA digests.
  -- An increase requires an explicit policy/source/constraint successor.
  CONSTRAINT objective_work_consents_policy_check CHECK (
    consent_policy_id='capiro.objective-generation-consent' AND consent_policy_revision=1
    AND configured_duration_ms BETWEEN 1 AND 1800000
    AND effective_duration_ms BETWEEN 1 AND 1800000
    AND effective_duration_ms<=configured_duration_ms),
  CONSTRAINT objective_work_consents_expiry_check CHECK (
    expires_at>confirmed_at
    AND expires_at<=confirmed_at+effective_duration_ms*INTERVAL '1 millisecond'
    AND expires_at<=confirmed_at+INTERVAL '24 hours'
    AND (stricter_expires_at IS NULL OR expires_at<=stricter_expires_at)),
  CONSTRAINT objective_work_consents_limit_check CHECK (
    (stricter_expires_at IS NULL AND stricter_limit_ref IS NULL) OR
    (stricter_expires_at IS NOT NULL AND stricter_limit_ref IS NOT NULL AND length(btrim(stricter_limit_ref))>0)),
  CONSTRAINT objective_work_consents_previous_check CHECK (previous_consent_id IS NULL OR previous_consent_id<>id),
  CONSTRAINT objective_work_consents_identity_key UNIQUE (tenant_id,client_id,objective_id,work_action,control_id,id),
  CONSTRAINT objective_work_consents_request_key UNIQUE
    (tenant_id,client_id,objective_id,work_action,consenting_actor_user_id,command_request_id),
  CONSTRAINT objective_work_consents_receipt_key UNIQUE
    (tenant_id,client_id,objective_id,work_action,control_id,command_receipt_id),
  CONSTRAINT objective_work_consents_control_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,canonical_plan_id,
     canonical_epoch,canonical_strategy_id,canonical_project_id)
    REFERENCES client_objective_work_controls
    (tenant_id,client_id,objective_id,work_action,id,canonical_plan_id,
     canonical_epoch,canonical_strategy_id,canonical_project_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_work_consents_root_intent_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,root_intent_id,source_revision_id,
     source_objective_version,source_snapshot_hash,root_actor_user_id)
    REFERENCES client_objective_work_intents
    (tenant_id,client_id,objective_id,id,objective_revision_id,objective_version,snapshot_hash,actor_user_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_work_consents_previous_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,previous_consent_id)
    REFERENCES client_objective_work_consents (tenant_id,client_id,objective_id,work_action,control_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

ALTER TABLE client_objective_work_controls ADD CONSTRAINT objective_work_controls_current_consent_fk
  FOREIGN KEY (tenant_id,client_id,objective_id,work_action,id,current_consent_id)
  REFERENCES client_objective_work_consents (tenant_id,client_id,objective_id,work_action,control_id,id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE client_objective_work_command_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  work_action VARCHAR(40) NOT NULL CHECK (work_action IN ('objective.strategy.draft','objective.plan.prepare')),
  control_id UUID NOT NULL,
  canonical_plan_id UUID NOT NULL,
  canonical_epoch INTEGER NOT NULL CHECK (canonical_epoch=1),
  canonical_strategy_id UUID NOT NULL,
  canonical_project_id UUID NOT NULL,
  canonical_binding_version INTEGER NOT NULL CHECK (canonical_binding_version>0),
  root_intent_id UUID NOT NULL,
  source_revision_id UUID NOT NULL,
  source_objective_version INTEGER NOT NULL CHECK (source_objective_version>0),
  source_snapshot_hash CHAR(64) NOT NULL CHECK (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  root_actor_user_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_membership_id UUID NOT NULL,
  request_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  command JSONB NOT NULL CHECK (jsonb_typeof(command)='object'),
  command_kind VARCHAR(8) NOT NULL CHECK (command_kind IN ('retry','cancel')),
  command_revision_id UUID NOT NULL,
  command_objective_version INTEGER NOT NULL CHECK (command_objective_version>0),
  control_version_before INTEGER NOT NULL CHECK (control_version_before>=0),
  control_version_after INTEGER NOT NULL CHECK (control_version_after>=0),
  target_consent_id UUID,
  created_consent_id UUID,
  result_consent_id UUID,
  outcome VARCHAR(24) NOT NULL CHECK (outcome IN ('reconsent_recorded','cancellation_recorded','unchanged')),
  committed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT objective_work_receipts_outcome_check CHECK (
    (command_kind='retry' AND outcome='reconsent_recorded' AND created_consent_id IS NOT NULL
      AND result_consent_id IS NOT NULL AND created_consent_id=result_consent_id
      AND created_consent_id IS DISTINCT FROM target_consent_id
      AND control_version_after::BIGINT=control_version_before::BIGINT+1) OR
    (command_kind='cancel' AND created_consent_id IS NULL
      AND result_consent_id IS NOT DISTINCT FROM target_consent_id
      AND ((outcome='cancellation_recorded' AND control_version_after::BIGINT=control_version_before::BIGINT+1)
        OR (outcome='unchanged' AND control_version_after=control_version_before)))),
  -- Equality enforces all eight normalized keys, types and explicit null target.
  CONSTRAINT objective_work_receipts_command_check CHECK (command=jsonb_build_object(
    'schemaVersion',1,'requestId',request_id,'command',command_kind,'workAction',work_action,
    'expectedObjectiveVersion',command_objective_version,'expectedControlVersion',control_version_before,
    'expectedCanonicalBindingVersion',canonical_binding_version,'targetAuthorizationRequestId',target_consent_id)),
  CONSTRAINT objective_work_receipts_request_key UNIQUE (tenant_id,client_id,objective_id,work_action,actor_user_id,request_id),
  CONSTRAINT objective_work_receipts_identity_key UNIQUE (tenant_id,client_id,objective_id,work_action,control_id,id),
  CONSTRAINT objective_work_receipts_control_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,canonical_plan_id,
     canonical_epoch,canonical_strategy_id,canonical_project_id)
    REFERENCES client_objective_work_controls
    (tenant_id,client_id,objective_id,work_action,id,canonical_plan_id,
     canonical_epoch,canonical_strategy_id,canonical_project_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_work_receipts_root_intent_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,root_intent_id,source_revision_id,
     source_objective_version,source_snapshot_hash,root_actor_user_id)
    REFERENCES client_objective_work_intents
    (tenant_id,client_id,objective_id,id,objective_revision_id,objective_version,snapshot_hash,actor_user_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_work_receipts_command_revision_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,command_revision_id,command_objective_version)
    REFERENCES client_objective_revisions (tenant_id,client_id,objective_id,id,version)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_work_receipts_target_consent_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,target_consent_id)
    REFERENCES client_objective_work_consents (tenant_id,client_id,objective_id,work_action,control_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_work_receipts_created_consent_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,created_consent_id)
    REFERENCES client_objective_work_consents (tenant_id,client_id,objective_id,work_action,control_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT objective_work_receipts_result_consent_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,result_consent_id)
    REFERENCES client_objective_work_consents (tenant_id,client_id,objective_id,work_action,control_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX objective_work_receipts_transition_key ON client_objective_work_command_receipts
  (tenant_id,client_id,objective_id,work_action,control_id,control_version_after) WHERE outcome<>'unchanged';

ALTER TABLE client_objective_work_consents ADD CONSTRAINT objective_work_consents_command_receipt_fk
  FOREIGN KEY (tenant_id,client_id,objective_id,work_action,control_id,command_receipt_id)
  REFERENCES client_objective_work_command_receipts (tenant_id,client_id,objective_id,work_action,control_id,id)
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION objective_work_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Objective work record is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER objective_work_consents_immutable BEFORE UPDATE ON client_objective_work_consents
  FOR EACH ROW EXECUTE FUNCTION objective_work_record_immutable();
CREATE TRIGGER objective_work_receipts_immutable BEFORE UPDATE ON client_objective_work_command_receipts
  FOR EACH ROW EXECUTE FUNCTION objective_work_record_immutable();

CREATE FUNCTION objective_work_control_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.version<>0 OR NEW.current_consent_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'Objective work control must start empty' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['version','current_consent_id','cancelled_at','cancelled_by_user_id','updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['version','current_consent_id','cancelled_at','cancelled_by_user_id','updated_at'])
       OR NEW.version::BIGINT<>OLD.version::BIGINT+1 THEN
      RAISE EXCEPTION 'Objective work control identity or version changed' USING ERRCODE='23514';
    END IF;
    IF NEW.cancelled_at IS NULL THEN
      IF NEW.current_consent_id IS NULL OR NEW.current_consent_id IS NOT DISTINCT FROM OLD.current_consent_id THEN
        RAISE EXCEPTION 'Objective retry requires a new consent' USING ERRCODE='23514';
      END IF;
    ELSIF OLD.cancelled_at IS NOT NULL OR NEW.current_consent_id IS DISTINCT FROM OLD.current_consent_id THEN
      RAISE EXCEPTION 'Objective cancellation must only advance its fence once' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER objective_work_controls_guard BEFORE INSERT OR UPDATE ON client_objective_work_controls
  FOR EACH ROW EXECUTE FUNCTION objective_work_control_guard();

-- Both sides are deferred: no consent, advancing control mutation or receipt
-- can commit alone. No UPDATE of historical consent/receipt identity is needed.
CREATE FUNCTION objective_work_control_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM client_objective_work_command_receipts r
    WHERE (r.tenant_id,r.client_id,r.objective_id,r.work_action,r.control_id,
           r.canonical_plan_id,r.canonical_epoch,r.canonical_strategy_id,r.canonical_project_id)
        =(NEW.tenant_id,NEW.client_id,NEW.objective_id,NEW.work_action,NEW.id,
          NEW.canonical_plan_id,NEW.canonical_epoch,NEW.canonical_strategy_id,NEW.canonical_project_id)
      AND r.control_version_before=OLD.version AND r.control_version_after=NEW.version
      AND r.target_consent_id IS NOT DISTINCT FROM OLD.current_consent_id
      AND r.result_consent_id IS NOT DISTINCT FROM NEW.current_consent_id
      AND ((NEW.cancelled_at IS NULL AND r.command_kind='retry' AND r.outcome='reconsent_recorded') OR
        (NEW.cancelled_at IS NOT NULL AND r.command_kind='cancel' AND r.outcome='cancellation_recorded'
          AND r.actor_user_id=NEW.cancelled_by_user_id AND NEW.cancelled_at<=r.committed_at))
  ) THEN
    RAISE EXCEPTION 'Objective work control receipt mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER objective_work_controls_receipt_guard AFTER UPDATE ON client_objective_work_controls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION objective_work_control_receipt_guard();

CREATE FUNCTION objective_work_consent_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c client_objective_work_consents%ROWTYPE;
  r client_objective_work_command_receipts%ROWTYPE;
  ctl client_objective_work_controls%ROWTYPE;
  p client_objective_canonical_plans%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='client_objective_work_consents' THEN
    c:=NEW;
    SELECT * INTO r FROM client_objective_work_command_receipts
      WHERE id=c.command_receipt_id AND tenant_id=c.tenant_id AND client_id=c.client_id
        AND objective_id=c.objective_id AND work_action=c.work_action AND control_id=c.control_id;
    IF NOT FOUND OR r.created_consent_id IS DISTINCT FROM c.id THEN
      RAISE EXCEPTION 'Objective consent receipt is missing' USING ERRCODE='23514';
    END IF;
  ELSE
    r:=NEW;
  END IF;
  SELECT * INTO ctl FROM client_objective_work_controls WHERE id=r.control_id
    AND tenant_id=r.tenant_id AND client_id=r.client_id AND objective_id=r.objective_id AND work_action=r.work_action;
  IF NOT FOUND OR ctl.version<r.control_version_after THEN
    RAISE EXCEPTION 'Objective receipt control mismatch' USING ERRCODE='23514';
  END IF;
  SELECT * INTO p FROM client_objective_canonical_plans WHERE id=r.canonical_plan_id
    AND tenant_id=r.tenant_id AND client_id=r.client_id AND objective_id=r.objective_id;
  IF NOT FOUND OR p.binding_version<>r.canonical_binding_version THEN
    RAISE EXCEPTION 'Objective receipt canonical version mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM client_objective_revisions v
    WHERE v.tenant_id=r.tenant_id AND v.client_id=r.client_id AND v.objective_id=r.objective_id
      AND v.id=r.source_revision_id AND v.version=r.source_objective_version AND v.operation='confirm_ready'
      AND v.snapshot->>'status'='ready' AND v.snapshot->>'id'=r.objective_id::text
      AND v.snapshot->>'clientId'=r.client_id::text AND v.snapshot->>'version'=r.source_objective_version::text
      AND v.snapshot->>'deletedAt' IS NULL) THEN
    RAISE EXCEPTION 'Objective work source is not its saved ready revision' USING ERRCODE='23514';
  END IF;
  IF r.command_kind='retry' THEN
    SELECT * INTO c FROM client_objective_work_consents WHERE id=r.created_consent_id
      AND tenant_id=r.tenant_id AND client_id=r.client_id AND objective_id=r.objective_id AND work_action=r.work_action;
    IF NOT FOUND OR
      (c.control_id,c.root_intent_id,c.source_revision_id,c.source_objective_version,c.source_snapshot_hash,c.root_actor_user_id,
       c.canonical_plan_id,c.canonical_epoch,c.canonical_strategy_id,c.canonical_project_id,c.canonical_binding_version,
       c.consenting_actor_user_id,c.consenting_membership_id,c.command_request_id,c.command_receipt_id,c.payload_digest)
      IS DISTINCT FROM
      (r.control_id,r.root_intent_id,r.source_revision_id,r.source_objective_version,r.source_snapshot_hash,r.root_actor_user_id,
       r.canonical_plan_id,r.canonical_epoch,r.canonical_strategy_id,r.canonical_project_id,r.canonical_binding_version,
       r.actor_user_id,r.actor_membership_id,r.request_id,r.id,r.payload_digest)
      OR c.previous_consent_id IS DISTINCT FROM r.target_consent_id
      OR c.confirmed_at>r.committed_at
      OR r.committed_at>=c.expires_at
      OR r.command_revision_id<>r.source_revision_id OR r.command_objective_version<>r.source_objective_version THEN
      RAISE EXCEPTION 'Objective consent reciprocal receipt mismatch' USING ERRCODE='23514';
    END IF;
  ELSIF r.target_consent_id IS NOT NULL THEN
    SELECT * INTO c FROM client_objective_work_consents WHERE id=r.target_consent_id
      AND tenant_id=r.tenant_id AND client_id=r.client_id AND objective_id=r.objective_id AND work_action=r.work_action;
    IF NOT FOUND OR
      (c.root_intent_id,c.source_revision_id,c.source_objective_version,c.source_snapshot_hash,c.root_actor_user_id)
      IS DISTINCT FROM
      (r.root_intent_id,r.source_revision_id,r.source_objective_version,r.source_snapshot_hash,r.root_actor_user_id) THEN
      RAISE EXCEPTION 'Objective cancellation source mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF r.command_kind='retry' OR r.target_consent_id IS NULL THEN
    IF (p.requested_intent_id,p.requested_objective_revision_id,p.requested_objective_version,p.requested_snapshot_hash)
       IS DISTINCT FROM
       (r.root_intent_id,r.source_revision_id,r.source_objective_version,r.source_snapshot_hash) THEN
      RAISE EXCEPTION 'Objective requested source mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF r.outcome='unchanged' AND
    (ctl.version<>r.control_version_after OR ctl.current_consent_id IS DISTINCT FROM r.target_consent_id
      OR ctl.cancelled_at IS NULL) THEN
    RAISE EXCEPTION 'Objective unchanged cancellation is not current' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER objective_work_consents_receipt_guard AFTER INSERT ON client_objective_work_consents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION objective_work_consent_receipt_guard();
CREATE CONSTRAINT TRIGGER objective_work_receipts_consent_guard AFTER INSERT ON client_objective_work_command_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION objective_work_consent_receipt_guard();

ALTER TABLE client_objective_work_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_work_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_work_controls_isolation ON client_objective_work_controls
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE client_objective_work_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_work_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_work_consents_isolation ON client_objective_work_consents
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE client_objective_work_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_work_command_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_work_receipts_isolation ON client_objective_work_command_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());

-- Reuse configured Core default privileges; no new role or broad GRANT. Actual
-- owner/inheritance/PUBLIC/effective ACL and FORCE RLS posture need native proof.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE DELETE,TRUNCATE ON client_objective_work_controls FROM capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON client_objective_work_consents,client_objective_work_command_receipts FROM capiro_app;
  END IF;
END $$;
