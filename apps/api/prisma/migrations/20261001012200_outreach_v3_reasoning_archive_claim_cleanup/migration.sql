-- A conversation may be archived while an external reasoning call is in flight.
-- The archived conversation remains immutable except for clearing the exact
-- ephemeral turn-claim fields in the provider call's finally block.

CREATE OR REPLACE FUNCTION enforce_outreach_reasoning_conversation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.state_mode IS DISTINCT FROM OLD.state_mode
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.reasoning_effort IS DISTINCT FROM OLD.reasoning_effort
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'outreach reasoning conversation identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'archived' THEN
    IF NEW.status <> 'archived'
      OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
      OR NEW.last_response_id IS DISTINCT FROM OLD.last_response_id
      OR NEW.in_flight_turn_id IS NOT NULL
      OR NEW.in_flight_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'archived outreach reasoning conversation is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('active', 'archived') THEN
    RAISE EXCEPTION 'invalid outreach reasoning conversation status' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
