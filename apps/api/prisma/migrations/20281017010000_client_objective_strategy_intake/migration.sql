-- Atomic selected-type companion to the unchanged v1 native retry receipt.
-- This is consistency storage, not a delegation, issuer, claim or effect grant.
-- Core inserts the intake before its fresh reserved job in ONE transaction.
-- Strategy owns sp_draft_job: deliberately no new cross-owner job FK or GRANT.
CREATE TABLE public.client_objective_strategy_intakes (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  work_action VARCHAR(40) NOT NULL CHECK (work_action='objective.strategy.draft'),
  control_id UUID NOT NULL,
  consent_id UUID NOT NULL,
  command_receipt_id UUID NOT NULL,
  command_request_id UUID NOT NULL,
  control_version INTEGER NOT NULL CHECK (control_version>0),
  actor_user_id UUID NOT NULL,
  actor_membership_id UUID NOT NULL,
  original_clerk_user_id VARCHAR(128) NOT NULL CHECK (length(btrim(original_clerk_user_id))>0),
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
  selected_type VARCHAR(32) NOT NULL CHECK (selected_type IN
    ('appropriations','authorization','regulatory','coalition','procurement','earmark','amendment')),
  generation_request_id UUID NOT NULL,
  wrapper JSONB NOT NULL CHECK (jsonb_typeof(wrapper)='object'),
  wrapper_sha256 CHAR(64) NOT NULL CHECK (wrapper_sha256 ~ '^[0-9a-f]{64}$'),
  typed_request JSONB NOT NULL,
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  job_request_key TEXT NOT NULL CHECK (job_request_key ~ '^objective-v1:[0-9a-f]{64}$'),
  generation_job_id UUID NOT NULL,
  original_deadline_at TIMESTAMPTZ(6) NOT NULL,
  reserved_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT objective_strategy_intakes_deadline_check CHECK (original_deadline_at>reserved_at),
  CONSTRAINT objective_strategy_intakes_typed_request_check CHECK (typed_request=jsonb_build_object(
    'requestId',generation_request_id,'clientId',client_id,
    'objective',jsonb_build_object('objectiveId',objective_id,'objectiveVersion',source_objective_version),
    'type',selected_type)),
  CONSTRAINT objective_strategy_intakes_consent_key UNIQUE
    (tenant_id,client_id,objective_id,work_action,control_id,consent_id),
  CONSTRAINT objective_strategy_intakes_receipt_key UNIQUE
    (tenant_id,client_id,objective_id,work_action,control_id,command_receipt_id),
  CONSTRAINT objective_strategy_intakes_request_key UNIQUE
    (tenant_id,client_id,objective_id,work_action,actor_user_id,command_request_id),
  CONSTRAINT objective_strategy_intakes_generation_request_key UNIQUE
    (tenant_id,original_clerk_user_id,generation_request_id),
  CONSTRAINT objective_strategy_intakes_job_key UNIQUE (generation_job_id),
  CONSTRAINT objective_strategy_intakes_consent_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,consent_id)
    REFERENCES public.client_objective_work_consents (tenant_id,client_id,objective_id,work_action,control_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT objective_strategy_intakes_receipt_fk FOREIGN KEY
    (tenant_id,client_id,objective_id,work_action,control_id,command_receipt_id)
    REFERENCES public.client_objective_work_command_receipts (tenant_id,client_id,objective_id,work_action,control_id,id)
    ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER objective_strategy_intakes_immutable BEFORE UPDATE ON public.client_objective_strategy_intakes
  FOR EACH ROW EXECUTE FUNCTION public.objective_work_record_immutable();

CREATE FUNCTION public.objective_strategy_intake_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  c public.client_objective_work_consents%ROWTYPE;
  r public.client_objective_work_command_receipts%ROWTYPE;
  j public.sp_draft_job%ROWTYPE;
  snapshot JSONB;
  source JSONB;
  envelope JSONB;
BEGIN
  SELECT * INTO c FROM public.client_objective_work_consents
    WHERE tenant_id=NEW.tenant_id AND client_id=NEW.client_id AND objective_id=NEW.objective_id
      AND work_action=NEW.work_action AND control_id=NEW.control_id AND id=NEW.consent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Objective Strategy intake consent missing' USING ERRCODE='23514';
  END IF;
  SELECT * INTO r FROM public.client_objective_work_command_receipts
    WHERE tenant_id=NEW.tenant_id AND client_id=NEW.client_id AND objective_id=NEW.objective_id
      AND work_action=NEW.work_action AND control_id=NEW.control_id AND id=NEW.command_receipt_id;
  IF NOT FOUND OR r.command_kind<>'retry' OR r.outcome<>'reconsent_recorded'
    OR r.created_consent_id IS DISTINCT FROM c.id OR r.result_consent_id IS DISTINCT FROM c.id
    OR (r.request_id,r.control_version_after,r.actor_user_id,r.actor_membership_id,
        r.canonical_plan_id,r.canonical_epoch,r.canonical_strategy_id,r.canonical_project_id,r.canonical_binding_version,
        r.root_intent_id,r.source_revision_id,r.source_objective_version,r.source_snapshot_hash,r.root_actor_user_id)
       IS DISTINCT FROM
       (NEW.command_request_id,NEW.control_version,NEW.actor_user_id,NEW.actor_membership_id,
        NEW.canonical_plan_id,NEW.canonical_epoch,NEW.canonical_strategy_id,NEW.canonical_project_id,NEW.canonical_binding_version,
        NEW.root_intent_id,NEW.source_revision_id,NEW.source_objective_version,NEW.source_snapshot_hash,NEW.root_actor_user_id)
    OR (c.command_request_id,c.command_receipt_id,c.consenting_actor_user_id,c.consenting_membership_id,
        c.canonical_plan_id,c.canonical_epoch,c.canonical_strategy_id,c.canonical_project_id,c.canonical_binding_version,
        c.root_intent_id,c.source_revision_id,c.source_objective_version,c.source_snapshot_hash,c.root_actor_user_id,c.payload_digest)
       IS DISTINCT FROM
       (r.request_id,r.id,r.actor_user_id,r.actor_membership_id,
        r.canonical_plan_id,r.canonical_epoch,r.canonical_strategy_id,r.canonical_project_id,r.canonical_binding_version,
        r.root_intent_id,r.source_revision_id,r.source_objective_version,r.source_snapshot_hash,r.root_actor_user_id,r.payload_digest)
    OR c.previous_consent_id IS DISTINCT FROM r.target_consent_id
    OR r.command_revision_id<>NEW.source_revision_id OR r.command_objective_version<>NEW.source_objective_version
    OR c.confirmed_at>r.committed_at OR r.committed_at>=c.expires_at
    OR NEW.reserved_at<r.committed_at OR NEW.reserved_at>clock_timestamp()
    OR NEW.original_deadline_at>c.expires_at
    OR NEW.wrapper IS DISTINCT FROM jsonb_build_object('schemaVersion',2,'command',r.command,
      'selection',jsonb_build_object('type',NEW.selected_type,'generationRequestId',NEW.generation_request_id)) THEN
    RAISE EXCEPTION 'Objective Strategy intake native lineage mismatch' USING ERRCODE='23514';
  END IF;
  -- Capture the original mapping under the same native locks. This historical
  -- literal is intentionally not an FK to a mutable users.clerk_user_id value.
  PERFORM 1 FROM public.users u JOIN public.tenant_memberships m ON m.user_id=u.id
    WHERE u.id=NEW.actor_user_id AND u.clerk_user_id=NEW.original_clerk_user_id
      AND m.id=NEW.actor_membership_id AND m.tenant_id=NEW.tenant_id
      AND m.status::text='active' AND m.role::text IN ('standard_user','user_admin','capiro_admin')
    FOR SHARE OF u,m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Objective Strategy intake original identity mismatch' USING ERRCODE='23514';
  END IF;
  SELECT v.snapshot INTO snapshot FROM public.client_objective_revisions v
    WHERE v.tenant_id=NEW.tenant_id AND v.client_id=NEW.client_id AND v.objective_id=NEW.objective_id
      AND v.id=NEW.source_revision_id AND v.version=NEW.source_objective_version AND v.operation='confirm_ready';
  IF NOT FOUND OR jsonb_typeof(snapshot->'outcome') IS DISTINCT FROM 'string'
    OR snapshot->>'status' IS DISTINCT FROM 'ready' OR snapshot->>'id' IS DISTINCT FROM NEW.objective_id::text
    OR snapshot->>'clientId' IS DISTINCT FROM NEW.client_id::text
    OR snapshot->'version' IS DISTINCT FROM to_jsonb(NEW.source_objective_version)
    OR (snapshot->'deletedAt' IS NOT NULL AND snapshot->'deletedAt'<>'null'::jsonb) THEN
    RAISE EXCEPTION 'Objective Strategy intake saved source mismatch' USING ERRCODE='23514';
  END IF;
  source:=jsonb_build_object('clientId',NEW.client_id,'objectiveId',NEW.objective_id,
    'objectiveVersion',NEW.source_objective_version,'objectiveRevisionId',NEW.source_revision_id);
  envelope:=jsonb_build_object('request',NEW.typed_request,'fingerprint',NEW.request_fingerprint,
    'receipt',jsonb_build_object('schemaVersion',1,'requestId',NEW.generation_request_id,'source',source,
      'context',jsonb_build_object('reobservedAt',NULL,'state','pending','packetId',NULL,'compiledAt',NULL,
        'sourceDigest',NULL,'coverageDigest',NULL,'inputDigest',NULL,'issues','[]'::jsonb),'result',NULL,'failure',NULL));
  -- The owning transaction just inserted this job. Do not introduce a late
  -- job lock after Core locks, or require UPDATE on immutable revision rows.
  SELECT * INTO j FROM public.sp_draft_job WHERE id=NEW.generation_job_id;
  IF NOT FOUND OR (j.tenant_id,j.client_id,j.owner_user_id,j.request_key,(j.deadline_at AT TIME ZONE 'UTC'))
    IS DISTINCT FROM (NEW.tenant_id,NEW.client_id,NEW.original_clerk_user_id,NEW.job_request_key,NEW.original_deadline_at)
    OR j.status::text<>'queued' OR j.attempt<>1 OR j.claimed_by IS NOT NULL OR j.claimed_at IS NOT NULL
    OR j.strategy_id IS NOT NULL OR j.input IS DISTINCT FROM jsonb_build_object(
      'bearer',NULL,'dto',jsonb_build_object('clientId',NEW.client_id,'type',NEW.selected_type,'goal',snapshot->'outcome'),
      'objectiveGeneration',envelope,'objectiveCanonicalReservation',jsonb_build_object('schemaVersion',1,
        'intakeId',NEW.id,'consentId',NEW.consent_id,'commandReceiptId',NEW.command_receipt_id,'wrapperSha256',NEW.wrapper_sha256)) THEN
    RAISE EXCEPTION 'Objective Strategy intake reserved job mismatch' USING ERRCODE='23514';
  END IF;
  -- Hash/key formulas are validated by the existing application codecs before
  -- insertion. jsonb::text is deliberately NOT treated as their serialization.
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER objective_strategy_intakes_insert_guard AFTER INSERT ON public.client_objective_strategy_intakes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.objective_strategy_intake_insert_guard();

CREATE FUNCTION public.objective_strategy_intake_job_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  t public.client_objective_strategy_intakes%ROWTYPE;
  resource public.sp_planner_resources%ROWTYPE;
  reservation JSONB;
  canonical JSONB;
  a JSONB;
  marker JSONB;
  admitted_ms NUMERIC;
  expires_ms NUMERIC;
  now_ms NUMERIC;
BEGIN
  SELECT * INTO t FROM public.client_objective_strategy_intakes WHERE generation_job_id=OLD.id;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Objective Strategy intake job cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.client_id,NEW.owner_user_id,NEW.request_key,(NEW.deadline_at AT TIME ZONE 'UTC'))
    IS DISTINCT FROM (OLD.id,t.tenant_id,t.client_id,t.original_clerk_user_id,t.job_request_key,t.original_deadline_at)
    OR jsonb_typeof(NEW.input) IS DISTINCT FROM 'object'
    OR NEW.input->'bearer' IS DISTINCT FROM 'null'::jsonb
    OR NEW.input->'dto' IS DISTINCT FROM OLD.input->'dto'
    OR NEW.input#>'{objectiveGeneration,request}' IS DISTINCT FROM t.typed_request
    OR NEW.input#>'{objectiveGeneration,fingerprint}' IS DISTINCT FROM to_jsonb(t.request_fingerprint)
    OR NEW.input#>'{objectiveGeneration,receipt,source}' IS DISTINCT FROM OLD.input#>'{objectiveGeneration,receipt,source}'
    OR NEW.input#>'{objectiveGeneration,receipt,schemaVersion}' IS DISTINCT FROM '1'::jsonb
    OR NEW.input#>'{objectiveGeneration,receipt,requestId}' IS DISTINCT FROM to_jsonb(t.generation_request_id) THEN
    RAISE EXCEPTION 'Objective Strategy intake job identity changed' USING ERRCODE='23514';
  END IF;
  reservation:=jsonb_build_object('schemaVersion',1,'intakeId',t.id,'consentId',t.consent_id,
    'commandReceiptId',t.command_receipt_id,'wrapperSha256',t.wrapper_sha256);
  IF OLD.input ? 'objectiveCanonicalReservation' THEN
    IF OLD.input->'objectiveCanonicalReservation' IS DISTINCT FROM reservation OR OLD.input ? 'canonicalGeneration'
      OR OLD.status::text<>'queued' OR OLD.attempt<>1 OR OLD.claimed_by IS NOT NULL OR OLD.claimed_at IS NOT NULL
      OR OLD.strategy_id IS NOT NULL OR NEW.status::text<>'queued' OR NEW.attempt<>1
      OR NEW.claimed_by IS NOT NULL OR NEW.claimed_at IS NOT NULL OR NEW.strategy_id IS NOT NULL THEN
      RAISE EXCEPTION 'Objective Strategy intake pending job changed' USING ERRCODE='23514';
    END IF;
    IF NEW.input ? 'objectiveCanonicalReservation' THEN
      IF NEW.input IS DISTINCT FROM OLD.input THEN
        RAISE EXCEPTION 'Objective Strategy intake reservation changed' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    marker:=NEW.input->'canonicalGeneration';
    IF jsonb_typeof(marker) IS DISTINCT FROM 'object' OR jsonb_typeof(marker->'admissionId') IS DISTINCT FROM 'string'
      OR marker IS DISTINCT FROM jsonb_build_object('admissionId',marker->'admissionId')
      OR (marker->>'admissionId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR (NEW.input-'canonicalGeneration') IS DISTINCT FROM (OLD.input-'objectiveCanonicalReservation') THEN
      RAISE EXCEPTION 'Objective Strategy intake admission marker invalid' USING ERRCODE='23514';
    END IF;
    -- Probe the exact tenant+ID first; alleged kind/owner/data cannot hide a
    -- conflicting row. The application codec supplies its deterministic ID.
    SELECT * INTO resource FROM public.sp_planner_resources
      WHERE tenant_id=t.tenant_id AND id=(marker->>'admissionId')::uuid FOR SHARE;
    IF NOT FOUND OR resource.kind<>'objective_canonical_generation_admission'
      OR resource.owner_id<>t.original_clerk_user_id OR resource.project_id IS NOT NULL
      OR resource.version<>1 OR resource.archived OR resource.share_token_hash IS NOT NULL
      OR resource.name<>'Objective canonical generation evidence' THEN
      RAISE EXCEPTION 'Objective Strategy intake admission ledger missing' USING ERRCODE='23514';
    END IF;
    a:=resource.data;
    IF jsonb_typeof(a) IS DISTINCT FROM 'object'
      OR jsonb_typeof(a->'admittedAtMs') IS DISTINCT FROM 'number'
      OR jsonb_typeof(a->'effectExpiresAtMs') IS DISTINCT FROM 'number'
      OR (a->>'admittedAtMs') !~ '^(0|[1-9][0-9]*)$' OR length(a->>'admittedAtMs')>16
      OR (a->>'effectExpiresAtMs') !~ '^(0|[1-9][0-9]*)$' OR length(a->>'effectExpiresAtMs')>16
      OR (a->'expectedStrategyVersionId'='null'::jsonb OR
        (jsonb_typeof(a->'expectedStrategyVersionId')='string' AND (a->>'expectedStrategyVersionId') ~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) IS NOT TRUE THEN
      RAISE EXCEPTION 'Objective Strategy intake admission shape invalid' USING ERRCODE='23514';
    END IF;
    admitted_ms:=(a->>'admittedAtMs')::numeric;
    expires_ms:=(a->>'effectExpiresAtMs')::numeric;
    now_ms:=ceil(extract(epoch FROM clock_timestamp())*1000);
    canonical:=jsonb_build_object('canonicalPlanId',t.canonical_plan_id,'tenantId',t.tenant_id,
      'clientId',t.client_id,'objectiveId',t.objective_id,'canonicalStrategyId',t.canonical_strategy_id,
      'canonicalProjectId',t.canonical_project_id,'bindingVersion',t.canonical_binding_version,'epoch',t.canonical_epoch,
      'requestedIntentId',t.root_intent_id,'requestedObjectiveRevisionId',t.source_revision_id,
      'requestedObjectiveVersion',t.source_objective_version,'snapshotHash',t.source_snapshot_hash);
    IF a IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'namespace','capiro.objective-strategy.admission:v1',
      'canonical',canonical,'actorUserId',t.actor_user_id,'clerkUserId',t.original_clerk_user_id,
      'consentId',t.consent_id,'controlVersion',t.control_version,'generationJobId',t.generation_job_id,
      'generationRequestId',t.generation_request_id,'admittedAtMs',a->'admittedAtMs',
      'effectExpiresAtMs',a->'effectExpiresAtMs','expectedStrategyVersionId',a->'expectedStrategyVersionId')
      OR admitted_ms<ceil(extract(epoch FROM t.reserved_at)*1000) OR admitted_ms>now_ms
      OR expires_ms<=admitted_ms OR expires_ms<=now_ms OR expires_ms>8640000000000000
      OR expires_ms>floor(extract(epoch FROM t.original_deadline_at)*1000) THEN
      RAISE EXCEPTION 'Objective Strategy intake admission lineage changed' USING ERRCODE='23514';
    END IF;
  ELSE
    -- Promotion is one-way. Later publication/context/history/completion updates
    -- may advance, but neither the intake's request nor its admission may move.
    IF NEW.input ? 'objectiveCanonicalReservation' OR jsonb_typeof(OLD.input->'canonicalGeneration') IS DISTINCT FROM 'object'
      OR OLD.input->'canonicalGeneration' IS DISTINCT FROM jsonb_build_object(
        'admissionId',OLD.input#>'{canonicalGeneration,admissionId}')
      OR jsonb_typeof(OLD.input#>'{canonicalGeneration,admissionId}') IS DISTINCT FROM 'string'
      OR NEW.input->'canonicalGeneration' IS DISTINCT FROM OLD.input->'canonicalGeneration' THEN
      RAISE EXCEPTION 'Objective Strategy intake admission identity changed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER objective_strategy_intake_jobs_guard BEFORE UPDATE OR DELETE ON public.sp_draft_job
  FOR EACH ROW EXECUTE FUNCTION public.objective_strategy_intake_job_guard();

-- Core takes this SAME global UUID gate before its native scope locks and
-- absence reads. All output writers participate, including foreign RLS scopes;
-- no visible canonical parent or intake row is needed to select the key.
-- Contention fails immediately, avoiding a child-row -> waiting-parent cycle.
CREATE FUNCTION public.objective_strategy_output_gate(strategy_uuid UUID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF pg_try_advisory_xact_lock(hashtextextended(
    'capiro.objective-strategy.output:v1:'||strategy_uuid::text,0::bigint)) IS NOT TRUE THEN
    RAISE EXCEPTION 'Objective Strategy output gate unavailable' USING ERRCODE='55P03';
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.objective_strategy_output_writer_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  previous_strategy UUID;
  next_strategy UUID;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_TABLE_NAME NOT IN ('sp_strategy','sp_version') THEN
    RAISE EXCEPTION 'Objective Strategy output gate relation invalid' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='sp_strategy' THEN
    next_strategy:=NEW.id;
    IF TG_OP='UPDATE' THEN previous_strategy:=OLD.id; END IF;
  ELSE
    next_strategy:=NEW.strategy_id;
    IF TG_OP='UPDATE' THEN previous_strategy:=OLD.strategy_id; END IF;
  END IF;
  -- Moves protect both the old and new global Strategy UUID. A tenant change
  -- retaining the UUID takes one key; distinct keys are acquired in UUID order.
  IF previous_strategy IS NOT NULL AND previous_strategy IS DISTINCT FROM next_strategy THEN
    IF previous_strategy<next_strategy THEN
      PERFORM public.objective_strategy_output_gate(previous_strategy);
      PERFORM public.objective_strategy_output_gate(next_strategy);
    ELSE
      PERFORM public.objective_strategy_output_gate(next_strategy);
      PERFORM public.objective_strategy_output_gate(previous_strategy);
    END IF;
  ELSE
    PERFORM public.objective_strategy_output_gate(next_strategy);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER objective_strategy_output_strategy_gate BEFORE INSERT OR UPDATE OF id,tenant_id
  ON public.sp_strategy FOR EACH ROW EXECUTE FUNCTION public.objective_strategy_output_writer_guard();
CREATE TRIGGER objective_strategy_output_version_gate BEFORE INSERT OR UPDATE OF strategy_id,tenant_id
  ON public.sp_version FOR EACH ROW EXECUTE FUNCTION public.objective_strategy_output_writer_guard();

ALTER TABLE public.client_objective_strategy_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_objective_strategy_intakes FORCE ROW LEVEL SECURITY;
CREATE POLICY objective_strategy_intakes_isolation ON public.client_objective_strategy_intakes
  USING (public.rls_bypass() OR tenant_id=public.current_tenant_id())
  WITH CHECK (public.rls_bypass() OR tenant_id=public.current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE UPDATE,DELETE,TRUNCATE ON public.client_objective_strategy_intakes FROM capiro_app;
  END IF;
END $$;
