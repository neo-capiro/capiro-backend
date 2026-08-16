-- Phase 5 governance atomicity.
--
-- UniversalEntityResolutionService.correctResolution appends a corrected
-- EntityResolution in its own transaction. Project the corresponding governance
-- event from an AFTER INSERT trigger so the correction and audit history either
-- commit together or roll back together.

CREATE OR REPLACE FUNCTION project_corrected_resolution_governance()
RETURNS trigger AS $$
DECLARE
  v_idempotency_key TEXT;
BEGIN
  IF NEW.status <> 'corrected'
     OR NEW.resolution_method <> 'user_corrected' THEN
    RETURN NEW;
  END IF;

  v_idempotency_key :=
    md5('resolution_confirmed:' || NEW.tenant_id::text || ':' || NEW.id::text)
    || md5('governance:v1:' || NEW.id::text);

  INSERT INTO entity_identity_governance_events (
    tenant_id,
    idempotency_key,
    action_type,
    subject_type,
    subject_id,
    entity_id,
    actor_user_id,
    reason_code,
    reason,
    metadata
  )
  VALUES (
    NEW.tenant_id,
    v_idempotency_key,
    'resolution_confirmed',
    'resolution',
    NEW.correction_of_resolution_id,
    NEW.selected_entity_id,
    NEW.actor_user_id,
    'user_confirmed',
    NULL,
    jsonb_build_object(
      'correctedResolutionId', NEW.id,
      'governanceBoundary', 'entity_resolutions_after_insert'
    )
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entity_resolutions_project_confirmation_governance"
  AFTER INSERT ON "entity_resolutions"
  FOR EACH ROW EXECUTE FUNCTION project_corrected_resolution_governance();

COMMENT ON FUNCTION project_corrected_resolution_governance() IS
  'Atomically projects user-corrected EntityResolution rows into the append-only governance ledger.';
