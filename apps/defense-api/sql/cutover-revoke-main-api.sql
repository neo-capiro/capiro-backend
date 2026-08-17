\set ON_ERROR_STOP on

-- NOT a Session 2 migration. Disposable rehearsal / future cutover script only.
-- Invoke with:
--   psql -v DEFENSE_CUTOVER_APPROVED=YES -v main_api_role=capiro_app -f ...
\if :{?DEFENSE_CUTOVER_APPROVED}
\else
  \echo 'DEFENSE_CUTOVER_APPROVED is required'
  \quit 2
\endif

SELECT (:'DEFENSE_CUTOVER_APPROVED' = 'YES') AS approved \gset
\if :approved
\else
  \echo 'DEFENSE_CUTOVER_APPROVED must equal YES'
  \quit 2
\endif

SELECT set_config('capiro.defense_cutover_approved', :'DEFENSE_CUTOVER_APPROVED', false);
SELECT set_config('capiro.main_api_role', :'main_api_role', false);

DO $cutover$
DECLARE
  relation_name text;
  role_name text := current_setting('capiro.main_api_role');
BEGIN
  IF current_setting('capiro.defense_cutover_approved') <> 'YES' THEN
    RAISE EXCEPTION 'defense cutover was not approved';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'program_element',
    'program_element_source',
    'program_element_project',
    'program_element_year',
    'program_element_budget_position',
    'program_element_delta',
    'program_element_watch',
    'program_element_data_issue',
    'program',
    'program_alias',
    'pe_program_match',
    'defense_budget_active_snapshot',
    'defense_budget_program_element_snapshot'
  ]
  LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM %I',
        relation_name,
        role_name
      );
    END IF;
  END LOOP;
END
$cutover$;
