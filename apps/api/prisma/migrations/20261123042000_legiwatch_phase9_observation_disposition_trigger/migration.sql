-- Keep the Phase 3 provenance repository compatible with the Phase 9
-- reconciliation contract without introducing a second write path. The existing
-- repository continues to set hearing_id; this trigger atomically stamps the
-- corresponding RECONCILED disposition before the shape constraint is checked.

CREATE OR REPLACE FUNCTION align_hearing_observation_disposition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.hearing_id IS NOT NULL THEN
    NEW.reconciliation_status = 'RECONCILED';
    NEW.reconciliation_reason_code = COALESCE(
      NEW.reconciliation_reason_code,
      'CANONICAL_HEARING_LINKED'
    );
    NEW.reconciliation_reviewed_at = COALESCE(
      NEW.reconciliation_reviewed_at,
      now()
    );
    NEW.reconciliation_reviewed_by = COALESCE(
      NEW.reconciliation_reviewed_by,
      'canonical-reconciler'
    );
  ELSIF TG_OP = 'UPDATE' AND OLD.hearing_id IS NOT NULL THEN
    NEW.reconciliation_status = 'PENDING';
    NEW.reconciliation_reason_code = NULL;
    NEW.reconciliation_reviewed_at = NULL;
    NEW.reconciliation_reviewed_by = NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "hearing_source_observation_disposition_align"
  ON "hearing_source_observation";
CREATE TRIGGER "hearing_source_observation_disposition_align"
BEFORE INSERT OR UPDATE OF "hearing_id"
ON "hearing_source_observation"
FOR EACH ROW
EXECUTE FUNCTION align_hearing_observation_disposition();

REVOKE ALL ON FUNCTION align_hearing_observation_disposition() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT EXECUTE ON FUNCTION align_hearing_observation_disposition() TO capiro_app;
  END IF;
END
$$;
