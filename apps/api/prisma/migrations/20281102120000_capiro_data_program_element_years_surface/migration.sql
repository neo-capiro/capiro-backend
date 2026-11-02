-- query_capiro_data / describe_capiro_data: publish Program Element funding by
-- fiscal year on the public surface, and say on the budget-position relations
-- that they are not populated yet.
--
-- public.program_element_year is the consolidated PE funding ladder the typed
-- get_pe_budget_timeline read serves (program-element-read.service.ts): one row
-- per (pe_code, fy) with the President's Budget request, the HASC/SASC
-- authorization marks, the HAC-D/SAC-D appropriations marks, the NDAA
-- conference value and the enacted amount, in USD millions, written by the
-- budget-document and committee-report loaders (rebuild-pe-years, parse-*-report,
-- parse-ndaa-conference). It was not a meri_public relation, so a SQL question
-- such as "FY2026 request for PE 0604800F" or "PEs whose enacted amount exceeds
-- the request" had no path, while the published budget-position relations
-- (program_element_budget_positions, program_element_project_budget_positions)
-- have no production writer yet (budget-position-writer.ts: promotion pending)
-- and hold no rows.
--
-- Additive, following 20281101010000 and 20281102100000: owner role with
-- definer semantics, security_barrier, explicit SELECT grant to
-- capiro_analytics_ro, JSON metadata comments in the shape
-- sql-reader-connection.ts parses. The only change to existing objects is the
-- budget-position view comments, which gain one limitation stating that the
-- relations are expected to be empty and where funding by fiscal year lives;
-- no view definition, grant, policy, role or row changes.
DO $prerequisites$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'capiro_public_projection_owner') THEN
    RAISE EXCEPTION 'Expected the public projection owner role from 20281101010000_capiro_data_published_surface';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meri_public' AND c.relkind = 'v') <> 10 THEN
    RAISE EXCEPTION 'Expected the ten published public projection views';
  END IF;
  IF to_regclass('public.program_element_year') IS NULL THEN
    RAISE EXCEPTION 'Expected public.program_element_year';
  END IF;
END
$prerequisites$;

GRANT SELECT ON TABLE public.program_element_year TO capiro_public_projection_owner;

SET ROLE capiro_public_projection_owner;

CREATE VIEW meri_public.program_element_years
WITH (security_barrier = true, security_invoker = false) AS
SELECT pe_code, fy, request, hasc_mark, sasc_mark, hac_d_mark, sac_d_mark, ndaa_conference, conference, enacted, reprogrammed, executed, last_synced_at
FROM public.program_element_year
WHERE EXISTS (SELECT 1 FROM public.program_element pe WHERE pe.pe_code = program_element_year.pe_code AND pe.retired_at IS NULL);

COMMENT ON VIEW meri_public.program_element_years IS '{"description":"Program Element funding by federal fiscal year and budget stage in USD millions, as Capiro extracted it from the President''s Budget books and the congressional authorization and appropriations reports: request, HASC/SASC marks, HAC-D/SAC-D marks, NDAA conference, enacted. The same data the PE budget timeline read serves; use it for funding amounts by PE and year.","grain":"One row per (pe_code, fy).","primaryKey":["pe_code","fy"],"relationships":[{"fields":["pe_code"],"referencedRelation":"program_elements","referencedFields":["pe_code"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Null is not loaded, never zero. Stages are separate quantities (request, each mark, conference, enacted) and are never summed across stages; sums across fiscal years must say which stage they total.","For fiscal years beyond the current budget cycle, request holds the outyear projection printed in the latest President''s Budget book, not a submitted request; marks and enacted exist only for years Congress has acted on.","Amounts are USD millions as extracted; per-value source citations and the current-cycle determination come from the PE budget timeline read, not from this relation.","Only active program elements (program_elements) are included."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.program_element_years.pe_code IS '{"description":"Program Element or procurement line code (program_elements.pe_code), e.g. 0604800F; with fy the key of this relation.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_years.fy IS '{"description":"Federal fiscal year the amounts are for, e.g. 2026; years beyond the current budget cycle are outyear projections from the latest President''s Budget book.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_years.request IS '{"description":"President''s Budget request for this fiscal year; for outyears the projection printed in the latest book, not a submitted request. Null when not loaded.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.hasc_mark IS '{"description":"House Armed Services Committee authorization mark (NDAA) for this fiscal year; null when the committee has not marked the year or the mark is not loaded.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.sasc_mark IS '{"description":"Senate Armed Services Committee authorization mark (NDAA) for this fiscal year; null when the committee has not marked the year or the mark is not loaded.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.hac_d_mark IS '{"description":"House Appropriations Defense Subcommittee mark for this fiscal year; null when not marked or not loaded.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.sac_d_mark IS '{"description":"Senate Appropriations Defense Subcommittee mark for this fiscal year; null when not marked or not loaded, which is the common case.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.ndaa_conference IS '{"description":"NDAA conference report (authorization) value for this fiscal year, reconciling the HASC and SASC marks; an authorization, not an appropriation. Null when not loaded.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.conference IS '{"description":"Defense Appropriations conference value for this fiscal year; reserved and null on every row until an appropriations-conference loader exists.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.enacted IS '{"description":"Enacted appropriation for this fiscal year; present only for years with an enacted act loaded. Null is not loaded, never zero.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.reprogrammed IS '{"description":"Reprogrammed amount for this fiscal year when loaded; rarely populated.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.executed IS '{"description":"Executed (obligated) amount for this fiscal year when loaded; rarely populated.","unit":"USD millions"}';
COMMENT ON COLUMN meri_public.program_element_years.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

-- The budget-position relations keep their definitions and existing metadata;
-- one limitation is appended so describe_capiro_data states that they are
-- expected to be empty and where funding by fiscal year lives.
DO $unpopulated$
DECLARE
  view_name text;
  current_comment jsonb;
  added text := 'No production writer has populated this relation yet (budget-position promotion pending), so it is expected to hold no rows; when a query over it returns nothing, state that budget position amounts are not loaded and use program_element_years or the PE budget timeline read for funding by fiscal year. Never estimate an amount.';
BEGIN
  FOREACH view_name IN ARRAY ARRAY['program_element_budget_positions', 'program_element_project_budget_positions'] LOOP
    current_comment := obj_description(format('meri_public.%I', view_name)::regclass, 'pg_class')::jsonb;
    IF current_comment IS NULL OR jsonb_typeof(current_comment -> 'limitations') <> 'array' THEN
      RAISE EXCEPTION 'Expected JSON metadata with limitations on meri_public.%', view_name;
    END IF;
    EXECUTE format('COMMENT ON VIEW meri_public.%I IS %L', view_name,
      jsonb_set(current_comment, '{limitations}', (current_comment -> 'limitations') || to_jsonb(added))::text);
  END LOOP;
END
$unpopulated$;

RESET ROLE;

GRANT SELECT ON TABLE meri_public.program_element_years TO capiro_analytics_ro;
