-- Forward-only, repeatable. No historical deletion is inferred or backfilled.
ALTER TABLE client_activity_commands
  ADD COLUMN IF NOT EXISTS undo_request_id uuid,
  ADD COLUMN IF NOT EXISTS undo_request_hash varchar(64),
  ADD COLUMN IF NOT EXISTS undone_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='client_activity_commands'::regclass
    AND conname='client_activity_commands_undo_tuple_chk') THEN
    ALTER TABLE client_activity_commands ADD CONSTRAINT client_activity_commands_undo_tuple_chk CHECK (
      (undo_request_id IS NULL AND undo_request_hash IS NULL AND undone_at IS NULL) OR
      (undo_request_id IS NOT NULL AND undo_request_hash IS NOT NULL AND undone_at IS NOT NULL
        AND undo_request_hash ~ '^[0-9a-f]{64}$' AND assignee_user_id IS NULL AND status='completed')
    );
  END IF;
END $$;
CREATE OR REPLACE FUNCTION preserve_client_activity_command_undo() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.undo_request_id IS NOT NULL AND
    (ROW(NEW.undo_request_id,NEW.undo_request_hash,NEW.undone_at,
         NEW.id,NEW.tenant_id,NEW.client_id,NEW.actor_user_id,NEW.actor_clerk_user_id,
         NEW.request_id,NEW.request_hash,NEW.activity_id)
      IS DISTINCT FROM
     ROW(OLD.undo_request_id,OLD.undo_request_hash,OLD.undone_at,
         OLD.id,OLD.tenant_id,OLD.client_id,OLD.actor_user_id,OLD.actor_clerk_user_id,
         OLD.request_id,OLD.request_hash,OLD.activity_id)) THEN
    RAISE EXCEPTION 'Recorded activity Undo is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS client_activity_commands_preserve_undo ON client_activity_commands;
CREATE TRIGGER client_activity_commands_preserve_undo BEFORE UPDATE ON client_activity_commands
  FOR EACH ROW EXECUTE FUNCTION preserve_client_activity_command_undo();
