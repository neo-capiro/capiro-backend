-- Read-only policy projection. Version 1 describes the installed owner-period
-- and Settings-draft constraints; it cannot change their expiry or authorize
-- deletion. No record content, individual hold or other store is projected.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.memory_retention_subjects') IS NULL OR
     to_regclass('public.memory_settings_drafts') IS NULL THEN
    RAISE EXCEPTION 'memory_retention_policy_prerequisite_missing';
  END IF;
END $$;
CREATE FUNCTION memory_retention_policy_v1() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object(
    'version',1,
    'personalAfterOffboardingHours',720,
    'clientAfterClosureHours',2160,
    'draftAfterCreationHours',720,
    'ownerClosureSuppressesImmediately',true,
    'firmSurvivesAuthorDeparture',true,
    'accessWithdrawal','revoke_access_only',
    'heldContent','retain_held_and_required_lineage',
    'receipts','retain_content_free_identity',
    'payloadStores',jsonb_build_array('memory_candidate','memory_items','clio_memory','context_embeddings'),
    'outsideScope',jsonb_build_array('conversations','uploads','office_drafts','filed_records'))
$$;
REVOKE ALL ON FUNCTION memory_retention_policy_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION memory_retention_policy_v1() TO capiro_app;
COMMIT;
