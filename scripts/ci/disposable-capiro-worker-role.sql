-- Restricted worker prerequisite for owned disposable CI databases only.
DO $bootstrap$
DECLARE
  role_is_safe boolean;
  role_has_memberships boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_worker') THEN
    CREATE ROLE capiro_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  ELSE
    SELECT NOT (
      rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR rolcanlogin OR
      rolreplication OR rolbypassrls
    )
    INTO role_is_safe
    FROM pg_roles
    WHERE rolname = 'capiro_worker';

    SELECT EXISTS (
      SELECT 1
      FROM pg_auth_members memberships
      JOIN pg_roles fixture_role
        ON fixture_role.oid IN (memberships.roleid, memberships.member)
      WHERE fixture_role.rolname = 'capiro_worker'
    )
    INTO role_has_memberships;

    IF NOT role_is_safe OR role_has_memberships THEN
      RAISE EXCEPTION
        'existing capiro_worker role is not the expected least-privilege CI fixture';
    END IF;
  END IF;
END
$bootstrap$;
