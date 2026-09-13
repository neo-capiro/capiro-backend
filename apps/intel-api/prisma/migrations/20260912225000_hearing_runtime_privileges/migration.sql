-- The established owner's default ACL grants DML (and in the live environment
-- TRUNCATE) on new tables. A narrower GRANT does not remove inherited privileges.
-- Source grants are reviewed by the operator; the HTTP/worker role only reads
-- them. UPDATE on the identity column permits SELECT ... FOR SHARE, which
-- PostgreSQL requires during current-permission fencing, without allowing an
-- application task to change the approved operations or revoke/extend a grant.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON intel_hearing_media_permission FROM capiro_app;
GRANT SELECT, UPDATE(id) ON intel_hearing_media_permission TO capiro_app;

CREATE FUNCTION hearing_permission_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Hearing permission identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hearing_permission_identity_immutable BEFORE UPDATE ON intel_hearing_media_permission
FOR EACH ROW EXECUTE FUNCTION hearing_permission_identity_immutable();

-- Versions and consent remain auditable after correction or withdrawal.
REVOKE DELETE, TRUNCATE ON intel_hearing_publication, intel_hearing_sms_consent FROM capiro_app;
