-- The Phase 10 delivery migration installs an append-only trigger that depends on
-- this shared helper. Preserve an already-compatible helper; never replace it.
DO $migration$
DECLARE
  existing_function oid := to_regprocedure('public.reject_append_only_mutation()');
  existing_returns_trigger boolean;
  existing_language name;
  existing_security_definer boolean;
  existing_source text;
BEGIN
  IF existing_function IS NULL THEN
    CREATE FUNCTION public.reject_append_only_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'Append-only table: updates and deletes are not allowed on %', TG_TABLE_NAME;
    END;
    $function$;
  ELSE
    SELECT
      function_definition.prorettype = 'pg_catalog.trigger'::regtype,
      function_language.lanname,
      function_definition.prosecdef,
      btrim(regexp_replace(function_definition.prosrc, '[[:space:]]+', ' ', 'g'))
    INTO
      existing_returns_trigger,
      existing_language,
      existing_security_definer,
      existing_source
    FROM pg_catalog.pg_proc AS function_definition
    JOIN pg_catalog.pg_language AS function_language
      ON function_language.oid = function_definition.prolang
    WHERE function_definition.oid = existing_function;

    IF NOT existing_returns_trigger
      OR existing_language <> 'plpgsql'
      OR existing_security_definer
      OR existing_source <>
        'BEGIN RAISE EXCEPTION ''Append-only table: updates and deletes are not allowed on %'', TG_TABLE_NAME; END;'
    THEN
      RAISE EXCEPTION
        'Incompatible existing function public.reject_append_only_mutation(); expected a SECURITY INVOKER plpgsql trigger function with the append-only rejection behavior';
    END IF;
  END IF;
END;
$migration$;
