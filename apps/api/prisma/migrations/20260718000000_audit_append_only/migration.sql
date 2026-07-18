-- Enterprise blocker #3c — make the audit tables append-only (tamper-evident).
--
-- audit_logs + compliance_check were UPDATE/DELETE-able by the app role. Because
-- capiro_app is a MEMBER of the table-owner role (capiro_master), it inherits
-- owner rights, so a plain `REVOKE UPDATE, DELETE` would NOT bind it (the same
-- reason RLS is decorative for capiro_app — see infra_capiro_app_bypasses_rls). A
-- BEFORE row trigger fires for EVERY role including the owner, so it is the
-- mechanism that actually enforces append-only here.
--
-- Two legitimate cascades must still work:
--   * GDPR tenant hard-delete: both tables have tenant_id FK ON DELETE CASCADE, so
--     deleting a tenant removes its audit rows. Allowed ONLY when the caller sets
--     app.allow_audit_purge='on' for that transaction (CapiroAdminService.
--     deleteTenant does; nothing else does), so a routine capiro_app session
--     cannot erase history.
--   * user hard-delete: audit_logs.actor_user_id FK ON DELETE SET NULL issues an
--     UPDATE that nulls ONLY that column. Allowed when actor_user_id is the only
--     change. (Dormant today — the app never hard-deletes users — kept so a future
--     user deletion doesn't wedge on this trigger.)
-- Every other UPDATE/DELETE raises (SQLSTATE 0A000).
--
-- NOTE: a fully-compromised owner could still ALTER TABLE ... DISABLE TRIGGER —
-- that is a loud DDL, and the durable fix is the DB-role re-architecture (deferred).
-- This makes ordinary tampering impossible and any bypass conspicuous.

CREATE OR REPLACE FUNCTION enforce_audit_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_audit_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'append-only: % rows cannot be deleted', TG_TABLE_NAME
      USING ERRCODE = '0A000';
  END IF;
  -- UPDATE: audit_logs may accept ONLY the actor FK SET NULL cascade
  -- (actor_user_id -> NULL, nothing else changed). compliance_check has no such
  -- cascade, so every UPDATE of it raises.
  IF TG_TABLE_NAME = 'audit_logs'
     AND OLD.actor_user_id IS NOT NULL
     AND NEW.actor_user_id IS NULL
     AND (to_jsonb(NEW) - 'actor_user_id') = (to_jsonb(OLD) - 'actor_user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only: % rows cannot be modified', TG_TABLE_NAME
    USING ERRCODE = '0A000';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON "audit_logs";
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_append_only();

DROP TRIGGER IF EXISTS compliance_check_append_only ON "compliance_check";
CREATE TRIGGER compliance_check_append_only
  BEFORE UPDATE OR DELETE ON "compliance_check"
  FOR EACH ROW EXECUTE FUNCTION enforce_audit_append_only();
