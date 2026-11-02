-- query_capiro_data / describe_capiro_data: publish the Unified Agenda government
-- forecasts on the public surface.
--
-- public.government_forecast (the current head: identity, RIN, status and the
-- approximate target window) and public.government_forecast_revision (the
-- immutable content revisions the head points at) are written by
-- src/government-forecasts/forecast-producer.ts from the Unified Agenda XML
-- (20281101120000_government_forecast_windows). The Core read
-- GET /government-forecasts serves them to the calendar and the Intelligence
-- module, but no meri_public relation existed, so "which forecasts have a window
-- in the next two quarters" had no SQL path. This migration adds one view
-- following 20281102140000_capiro_data_grants_notices_surface (owner role with
-- definer semantics, security_barrier, explicit SELECT grant to
-- capiro_analytics_ro, JSON metadata comments in the shape
-- sql-reader-connection.ts parses). Additive: no existing view, grant, policy,
-- role or row changes.
--
-- One row per forecast head joined to its current revision, exactly the rows the
-- Core read lists (government-forecasts.service.ts): heads whose
-- current_revision is 0 have no accepted content and are not published. Seven
-- columns are the head's stored columns (id as forecast_id, current_revision as
-- revision); seven are text members of the current revision's content JSON
-- (forecast-contract.ts ForecastContent), each read with ->> from one stored
-- column. The window is the publisher's approximate target month as civil-date
-- bounds, window_from inclusive and window_to exclusive (forecast-contract.ts
-- monthBounds), so a forecast overlaps a date range [a, b) exactly when
-- window_from < b AND window_to > a, the predicate the Core read uses. The
-- archived XML, content hashes, source keys, check and observation ledgers and
-- terminal identities are not published.
DO $prerequisites$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'capiro_public_projection_owner') THEN
    RAISE EXCEPTION 'Expected the public projection owner role from 20281101010000_capiro_data_published_surface';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meri_public' AND c.relkind = 'v') <> 13 THEN
    RAISE EXCEPTION 'Expected the thirteen published public projection views';
  END IF;
  IF to_regclass('public.government_forecast') IS NULL OR to_regclass('public.government_forecast_revision') IS NULL THEN
    RAISE EXCEPTION 'Expected public.government_forecast and public.government_forecast_revision';
  END IF;
END
$prerequisites$;

GRANT SELECT ON TABLE public.government_forecast, public.government_forecast_revision TO capiro_public_projection_owner;

SET ROLE capiro_public_projection_owner;

CREATE VIEW meri_public.government_forecasts
WITH (security_barrier = true, security_invoker = false) AS
SELECT f.id AS forecast_id, f.rin AS rin, r.content ->> 'title' AS title, r.content ->> 'eventType' AS event_type, f.status AS status, f.window_from AS window_from, f.window_to AS window_to, r.content -> 'period' ->> 'precision' AS period_precision, r.content -> 'period' ->> 'raw' AS period_text, r.content -> 'source' ->> 'edition' AS edition, r.content -> 'source' ->> 'url' AS source_url, f.current_revision AS revision, f.observed_at AS observed_at, r.recorded_at AS recorded_at
FROM public.government_forecast f JOIN public.government_forecast_revision r ON r.forecast_id = f.id AND r.revision = f.current_revision;

COMMENT ON VIEW meri_public.government_forecasts IS '{"description":"Federal regulatory forecasts from the OIRA Unified Agenda (reginfo.gov) as synchronized by Capiro: one row per forecast rulemaking action (a RIN at the proposed-rule or final-rule stage) with the publisher''s approximate target month as a civil-date window. These are rulemaking forecasts, not procurement or contract forecasts. A forecast overlaps a date range [a, b) when window_from < b AND window_to > a; open forecasts are status = ''published''. Approximate publisher targets, never confirmed events or deadlines.","grain":"One row per (forecast_id), the current revision of one forecast action.","primaryKey":["forecast_id"],"relationships":[],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Only the forecasts Capiro synchronized from the Unified Agenda editions it checked; a missing forecast is absence within this ingestion, not on reginfo.gov.","The window is the publisher''s approximate target month (window_from the first day, window_to the day after the last day); it is not a date the action will occur, and an elapsed window does not establish that the action happened.","window_from and window_to are null when the publisher gave no determinable month; period_text carries the publisher''s own timing statement. Count undated forecasts separately rather than treating them as outside every range.","No agency name column is stored; the first four digits of rin are the OMB agency code, and title and source_url identify the action.","status withdrawn and source_completed rows are terminal; filter status = ''published'' for forecasts the publisher still targets."],"freshnessField":"observed_at"}';
COMMENT ON COLUMN meri_public.government_forecasts.forecast_id IS '{"description":"Capiro forecast identity: 64 lowercase hexadecimal characters derived from the Unified Agenda RIN and rule stage; the key of this relation and the id of the Core forecast read.","nullable":false}';
COMMENT ON COLUMN meri_public.government_forecasts.rin IS '{"description":"Regulation Identifier Number as published by OIRA, e.g. 0938-AV12; its first four digits are the OMB agency code. Not unique here: a proposed-rule and a final-rule forecast can share one RIN.","nullable":false}';
COMMENT ON COLUMN meri_public.government_forecasts.title IS '{"description":"Rule title as published in the Unified Agenda; filter with ILIKE and a % pattern. Present on every published row."}';
COMMENT ON COLUMN meri_public.government_forecasts.event_type IS '{"description":"Rulemaking stage the forecast targets: proposed_rule (a notice of proposed rulemaking) or final_rule. Present on every published row.","enum":["proposed_rule","final_rule"]}';
COMMENT ON COLUMN meri_public.government_forecasts.status IS '{"description":"published: the publisher still targets the window; withdrawn: the publisher withdrew the action; source_completed: the publisher reports the action completed. Use status = ''published'' for open forecasts.","nullable":false,"enum":["published","withdrawn","source_completed"]}';
COMMENT ON COLUMN meri_public.government_forecasts.window_from IS '{"description":"First day (inclusive) of the publisher''s approximate target month; null when no month was determinable (see period_text)."}';
COMMENT ON COLUMN meri_public.government_forecasts.window_to IS '{"description":"Day after the last day of the approximate target month (exclusive), so the window is [window_from, window_to). A range [a, b) overlaps it when window_from < b AND window_to > a. Null exactly when window_from is null."}';
COMMENT ON COLUMN meri_public.government_forecasts.period_precision IS '{"description":"month when the publisher stated a calendar month (window_from and window_to are set); unknown when the timing text gave no month (both are null).","enum":["month","unknown"]}';
COMMENT ON COLUMN meri_public.government_forecasts.period_text IS '{"description":"The publisher''s own timing text, e.g. 11/00/2026 for November 2026, or a non-month statement such as To Be Determined; empty when the publisher gave none."}';
COMMENT ON COLUMN meri_public.government_forecasts.edition IS '{"description":"Unified Agenda edition the current revision was observed in, as YYYYMM, e.g. 202510."}';
COMMENT ON COLUMN meri_public.government_forecasts.source_url IS '{"description":"The reginfo.gov agenda page for this RIN (https://www.reginfo.gov/...); cite it."}';
COMMENT ON COLUMN meri_public.government_forecasts.revision IS '{"description":"Number of the current retained revision; it increases each time the publisher''s content for this action changed. Earlier revisions are not published here.","nullable":false}';
COMMENT ON COLUMN meri_public.government_forecasts.observed_at IS '{"description":"When Capiro last observed this forecast in a successful source check (UTC); the freshness field of this relation. Re-observing an unchanged edition advances it without changing revision."}';
COMMENT ON COLUMN meri_public.government_forecasts.recorded_at IS '{"description":"When Capiro recorded the current revision (UTC).","nullable":false}';

RESET ROLE;

GRANT SELECT ON TABLE meri_public.government_forecasts TO capiro_analytics_ro;
