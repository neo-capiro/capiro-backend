-- LegiWatch Phase 9 — fail closed without making one malformed source value
-- abort the complete readiness audit.
--
-- The canonical observation payload is third-party public metadata. A malformed
-- event.startsAt value is removed before storage and must then be represented by
-- observed_date / first_seen_at plus an explicit reconciliation disposition.

CREATE OR REPLACE FUNCTION legiwatch_try_timestamptz(value TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
STRICT
SET search_path = public, pg_catalog
AS $$
BEGIN
  RETURN value::timestamptz;
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN NULL;
END
$$;

UPDATE "hearing_source_observation"
SET "source_metadata" = "source_metadata" #- '{event,startsAt}',
    "updated_at" = now()
WHERE NULLIF("source_metadata" #>> '{event,startsAt}', '') IS NOT NULL
  AND legiwatch_try_timestamptz(
        NULLIF("source_metadata" #>> '{event,startsAt}', '')
      ) IS NULL;

CREATE OR REPLACE FUNCTION sanitize_hearing_observation_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  raw_start TEXT;
BEGIN
  raw_start := NULLIF(NEW.source_metadata #>> '{event,startsAt}', '');
  IF raw_start IS NOT NULL AND legiwatch_try_timestamptz(raw_start) IS NULL THEN
    NEW.source_metadata := NEW.source_metadata #- '{event,startsAt}';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "hearing_source_observation_timestamp_sanitize"
  ON "hearing_source_observation";
CREATE TRIGGER "hearing_source_observation_timestamp_sanitize"
BEFORE INSERT OR UPDATE OF "source_metadata"
ON "hearing_source_observation"
FOR EACH ROW
EXECUTE FUNCTION sanitize_hearing_observation_timestamp();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hearing_source_observation_starts_at_valid_check'
  ) THEN
    ALTER TABLE "hearing_source_observation"
      ADD CONSTRAINT "hearing_source_observation_starts_at_valid_check" CHECK (
        NULLIF(source_metadata #>> '{event,startsAt}', '') IS NULL OR
        legiwatch_try_timestamptz(
          NULLIF(source_metadata #>> '{event,startsAt}', '')
        ) IS NOT NULL
      );
  END IF;
END
$$;

REVOKE ALL ON FUNCTION legiwatch_try_timestamptz(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION sanitize_hearing_observation_timestamp() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT EXECUTE ON FUNCTION legiwatch_try_timestamptz(TEXT) TO capiro_app;
    GRANT EXECUTE ON FUNCTION sanitize_hearing_observation_timestamp() TO capiro_app;
  END IF;
END
$$;

COMMENT ON FUNCTION legiwatch_try_timestamptz(TEXT) IS
  'Phase 9 safe parser for untrusted official-source timestamps. Invalid values return NULL.';
