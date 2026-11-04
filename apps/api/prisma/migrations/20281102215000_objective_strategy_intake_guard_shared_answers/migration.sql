-- Objectives saved through the shared Strategy intake keep their answers in the
-- revision snapshot (strategyIntake) and leave the legacy outcome blank. Since
-- f423f0e763 the selected Strategy intake reserves its job with the Strategy DTO
-- built from those answers, but this deferred guard still required the legacy
-- {clientId,type,goal:outcome} DTO, so every "Request Strategy generation" for
-- such an Objective failed at COMMIT (23514, surfaced as 503 AUTHORITY_UNAVAILABLE)
-- and rolled back. The guard now expects the same projection for both shapes and
-- checks that the saved intake type is the selected type. Nothing else changes.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE OR REPLACE FUNCTION public.objective_strategy_intake_insert_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  c public.client_objective_work_consents%ROWTYPE;
  r public.client_objective_work_command_receipts%ROWTYPE;
  j public.sp_draft_job%ROWTYPE;
  snapshot JSONB;
  source JSONB;
  envelope JSONB;
  dto JSONB;
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
    OR (snapshot->'deletedAt' IS NOT NULL AND snapshot->'deletedAt'<>'null'::jsonb)
    OR (snapshot ? 'strategyIntake' AND (jsonb_typeof(snapshot->'strategyIntake') IS DISTINCT FROM 'object'
      OR snapshot#>>'{strategyIntake,type}' IS DISTINCT FROM NEW.selected_type)) THEN
    RAISE EXCEPTION 'Objective Strategy intake saved source mismatch' USING ERRCODE='23514';
  END IF;
  source:=jsonb_build_object('clientId',NEW.client_id,'objectiveId',NEW.objective_id,
    'objectiveVersion',NEW.source_objective_version,'objectiveRevisionId',NEW.source_revision_id);
  envelope:=jsonb_build_object('request',NEW.typed_request,'fingerprint',NEW.request_fingerprint,
    'receipt',jsonb_build_object('schemaVersion',1,'requestId',NEW.generation_request_id,'source',source,
      'context',jsonb_build_object('reobservedAt',NULL,'state','pending','packetId',NULL,'compiledAt',NULL,
        'sourceDigest',NULL,'coverageDigest',NULL,'inputDigest',NULL,'issues','[]'::jsonb),'result',NULL,'failure',NULL));
  -- The same Strategy DTO the application projects (objectiveStrategyDraftInput):
  -- saved shared intake answers without their schemaVersion, or the legacy goal.
  dto:=CASE WHEN snapshot ? 'strategyIntake'
    THEN ((snapshot->'strategyIntake')-'schemaVersion')||jsonb_build_object('clientId',NEW.client_id,'type',NEW.selected_type)
    ELSE jsonb_build_object('clientId',NEW.client_id,'type',NEW.selected_type,'goal',snapshot->'outcome') END;
  -- The owning transaction just inserted this job. Do not introduce a late
  -- job lock after Core locks, or require UPDATE on immutable revision rows.
  SELECT * INTO j FROM public.sp_draft_job WHERE id=NEW.generation_job_id;
  IF NOT FOUND OR (j.tenant_id,j.client_id,j.owner_user_id,j.request_key,(j.deadline_at AT TIME ZONE 'UTC'))
    IS DISTINCT FROM (NEW.tenant_id,NEW.client_id,NEW.original_clerk_user_id,NEW.job_request_key,NEW.original_deadline_at)
    OR j.status::text<>'queued' OR j.attempt<>1 OR j.claimed_by IS NOT NULL OR j.claimed_at IS NOT NULL
    OR j.strategy_id IS NOT NULL OR j.input IS DISTINCT FROM jsonb_build_object(
      'bearer',NULL,'dto',dto,
      'objectiveGeneration',envelope,'objectiveCanonicalReservation',jsonb_build_object('schemaVersion',1,
        'intakeId',NEW.id,'consentId',NEW.consent_id,'commandReceiptId',NEW.command_receipt_id,'wrapperSha256',NEW.wrapper_sha256)) THEN
    RAISE EXCEPTION 'Objective Strategy intake reserved job mismatch' USING ERRCODE='23514';
  END IF;
  -- Hash/key formulas are validated by the existing application codecs before
  -- insertion. jsonb::text is deliberately NOT treated as their serialization.
  RETURN NULL;
END $$;
COMMIT;
