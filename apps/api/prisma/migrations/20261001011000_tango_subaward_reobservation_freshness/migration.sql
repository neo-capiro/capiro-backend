-- A successful re-observation of unchanged provider bytes must advance local
-- freshness without pretending the source content changed.
--
-- sync-tango-subawards uses INSERT ... ON CONFLICT ... WHERE content_sha differs
-- so unchanged observations return zero rows and are counted as `unchanged`.
-- A BEFORE INSERT trigger is the only place that can both preserve that result
-- shape and stamp the existing row before PostgreSQL skips the conflict update.

CREATE OR REPLACE FUNCTION tango_subaward_touch_same_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE tango_subaward
     SET last_synced_at = CURRENT_TIMESTAMP
   WHERE provider_key = NEW.provider_key
     AND content_sha256 = NEW.content_sha256;

  IF FOUND THEN
    -- Existing semantic observation was successfully seen again. Keep
    -- updated_at/content bytes unchanged and suppress the redundant insert.
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tango_subaward_touch_same_observation_trg ON tango_subaward;
CREATE TRIGGER tango_subaward_touch_same_observation_trg
BEFORE INSERT ON tango_subaward
FOR EACH ROW
EXECUTE FUNCTION tango_subaward_touch_same_observation();
