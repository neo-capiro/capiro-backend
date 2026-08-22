-- Derive audit scope from the durable entity anchors. The readiness writer may
-- omit audit_scope; PostgreSQL remains authoritative and classifies the finding
-- before the scope/anchor constraint is evaluated.

CREATE OR REPLACE FUNCTION derive_legiwatch_event_audit_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.audit_scope = CASE
    WHEN NEW.hearing_id IS NOT NULL THEN 'EVENT'
    WHEN NEW.observation_id IS NOT NULL THEN 'OBSERVATION'
    WHEN NEW.committee_system_code IS NOT NULL THEN 'BODY'
    ELSE 'RUN'
  END;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "legiwatch_event_audit_scope_derive"
  ON "legiwatch_event_audit";
CREATE TRIGGER "legiwatch_event_audit_scope_derive"
BEFORE INSERT OR UPDATE OF hearing_id, observation_id, committee_system_code
ON "legiwatch_event_audit"
FOR EACH ROW
EXECUTE FUNCTION derive_legiwatch_event_audit_scope();

REVOKE ALL ON FUNCTION derive_legiwatch_event_audit_scope() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT EXECUTE ON FUNCTION derive_legiwatch_event_audit_scope() TO capiro_app;
  END IF;
END
$$;
