-- Knowledge Plane Phase 8 hardening — canonical query-root continuity.
--
-- The derived edge view resolves historical assertion endpoints to terminal
-- canonical IDs. Sanctioned graph reads must do the same for a caller that still
-- holds a pre-merge canonical UUID, otherwise the surviving edge would exist but
-- a walk/history query rooted at the historical UUID would starve.

ALTER FUNCTION kg_temporal_walk_bounded(
  uuid, text, jsonb, text[], uuid, timestamptz, int, text[], int, int, text
) RENAME TO kg_temporal_walk_bounded_unresolved;

ALTER FUNCTION kg_temporal_relation_history(
  uuid, text, jsonb, text[], uuid, timestamptz, timestamptz, timestamptz, text[], int, text
) RENAME TO kg_temporal_relation_history_unresolved;

-- The renamed implementations are internal only. Their prior EXECUTE grants
-- follow the renamed objects, so explicitly remove them before exposing wrappers.
REVOKE ALL ON FUNCTION kg_temporal_walk_bounded_unresolved(
  uuid, text, jsonb, text[], uuid, timestamptz, int, text[], int, int, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION kg_temporal_walk_bounded_unresolved(
  uuid, text, jsonb, text[], uuid, timestamptz, int, text[], int, int, text
) FROM capiro_app;
REVOKE ALL ON FUNCTION kg_temporal_relation_history_unresolved(
  uuid, text, jsonb, text[], uuid, timestamptz, timestamptz, timestamptz, text[], int, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION kg_temporal_relation_history_unresolved(
  uuid, text, jsonb, text[], uuid, timestamptz, timestamptz, timestamptz, text[], int, text
) FROM capiro_app;

CREATE OR REPLACE FUNCTION kg_temporal_walk_bounded(
  p_tenant_id         uuid,
  p_sensitivity       text,
  p_access_scope      jsonb,
  p_client_ref_keys   text[],
  p_canonical_entity_id uuid,
  p_as_of             timestamptz,
  p_max_depth         int    DEFAULT 2,
  p_edge_types        text[] DEFAULT NULL,
  p_fanout            int    DEFAULT 25,
  p_row_budget        int    DEFAULT 500,
  p_direction         text   DEFAULT 'both'
) RETURNS TABLE (
  depth int,
  src_canonical_entity_id uuid,
  dst_canonical_entity_id uuid,
  edge_type text,
  confidence double precision,
  observed_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  assertion_id uuid,
  event_id uuid,
  evidence_id uuid,
  evidence_source_type text,
  evidence_source_id text,
  evidence_content_hash text,
  evidence_start_offset int,
  evidence_end_offset int,
  sensitivity text,
  client_ref_keys text[]
) LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET statement_timeout = '3s'
AS $fn$
DECLARE
  v_terminal_entity_id uuid;
BEGIN
  -- Preserve the original public contract before performing identity lookup.
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_walk_bounded: p_tenant_id is mandatory';
  END IF;
  IF NULLIF(BTRIM(p_sensitivity), '') IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_walk_bounded: p_sensitivity is mandatory';
  END IF;
  IF p_access_scope IS NULL OR jsonb_typeof(p_access_scope) <> 'object' THEN
    RAISE EXCEPTION 'kg_temporal_walk_bounded: p_access_scope object is mandatory';
  END IF;
  IF p_client_ref_keys IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_walk_bounded: p_client_ref_keys is mandatory (pass {} explicitly)';
  END IF;
  IF p_canonical_entity_id IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_walk_bounded: p_canonical_entity_id is mandatory';
  END IF;
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_walk_bounded: p_as_of is mandatory';
  END IF;
  IF p_direction IS NULL OR p_direction NOT IN ('out', 'in', 'both') THEN
    RAISE EXCEPTION 'kg_temporal_walk_bounded: p_direction must be out, in, or both';
  END IF;

  v_terminal_entity_id := kg_resolve_terminal_canonical_entity(
    p_canonical_entity_id,
    p_tenant_id
  );

  -- Unknown, withdrawn, malformed, cyclic, or foreign-tenant identity fails closed.
  IF v_terminal_entity_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM kg_temporal_walk_bounded_unresolved(
    p_tenant_id,
    p_sensitivity,
    p_access_scope,
    p_client_ref_keys,
    v_terminal_entity_id,
    p_as_of,
    p_max_depth,
    p_edge_types,
    p_fanout,
    p_row_budget,
    p_direction
  );
END $fn$;

CREATE OR REPLACE FUNCTION kg_temporal_relation_history(
  p_tenant_id         uuid,
  p_sensitivity       text,
  p_access_scope      jsonb,
  p_client_ref_keys   text[],
  p_canonical_entity_id uuid,
  p_window_start      timestamptz,
  p_window_end        timestamptz,
  p_observed_through  timestamptz,
  p_edge_types        text[] DEFAULT NULL,
  p_row_budget        int    DEFAULT 500,
  p_direction         text   DEFAULT 'both'
) RETURNS TABLE (
  src_canonical_entity_id uuid,
  dst_canonical_entity_id uuid,
  edge_type text,
  confidence double precision,
  observed_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  assertion_id uuid,
  event_id uuid,
  evidence_id uuid,
  evidence_source_type text,
  evidence_source_id text,
  evidence_content_hash text,
  evidence_start_offset int,
  evidence_end_offset int,
  sensitivity text,
  client_ref_keys text[]
) LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET statement_timeout = '3s'
AS $fn$
DECLARE
  v_terminal_entity_id uuid;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_relation_history: p_tenant_id is mandatory';
  END IF;
  IF NULLIF(BTRIM(p_sensitivity), '') IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_relation_history: p_sensitivity is mandatory';
  END IF;
  IF p_access_scope IS NULL OR jsonb_typeof(p_access_scope) <> 'object' THEN
    RAISE EXCEPTION 'kg_temporal_relation_history: p_access_scope object is mandatory';
  END IF;
  IF p_client_ref_keys IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_relation_history: p_client_ref_keys is mandatory (pass {} explicitly)';
  END IF;
  IF p_canonical_entity_id IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_relation_history: p_canonical_entity_id is mandatory';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL OR p_observed_through IS NULL THEN
    RAISE EXCEPTION 'kg_temporal_relation_history: temporal bounds are mandatory';
  END IF;
  IF p_window_end <= p_window_start THEN
    RAISE EXCEPTION 'kg_temporal_relation_history: window_end must be after window_start';
  END IF;
  IF p_direction IS NULL OR p_direction NOT IN ('out', 'in', 'both') THEN
    RAISE EXCEPTION 'kg_temporal_relation_history: p_direction must be out, in, or both';
  END IF;

  v_terminal_entity_id := kg_resolve_terminal_canonical_entity(
    p_canonical_entity_id,
    p_tenant_id
  );

  IF v_terminal_entity_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT *
  FROM kg_temporal_relation_history_unresolved(
    p_tenant_id,
    p_sensitivity,
    p_access_scope,
    p_client_ref_keys,
    v_terminal_entity_id,
    p_window_start,
    p_window_end,
    p_observed_through,
    p_edge_types,
    p_row_budget,
    p_direction
  );
END $fn$;

REVOKE ALL ON FUNCTION kg_temporal_walk_bounded(
  uuid, text, jsonb, text[], uuid, timestamptz, int, text[], int, int, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kg_temporal_walk_bounded(
  uuid, text, jsonb, text[], uuid, timestamptz, int, text[], int, int, text
) TO capiro_app;

REVOKE ALL ON FUNCTION kg_temporal_relation_history(
  uuid, text, jsonb, text[], uuid, timestamptz, timestamptz, timestamptz, text[], int, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kg_temporal_relation_history(
  uuid, text, jsonb, text[], uuid, timestamptz, timestamptz, timestamptz, text[], int, text
) TO capiro_app;

COMMENT ON FUNCTION kg_temporal_walk_bounded(
  uuid, text, jsonb, text[], uuid, timestamptz, int, text[], int, int, text
) IS 'Phase 8 sanctioned bounded temporal walk; historical canonical query roots resolve to their terminal visible identity before traversal.';
COMMENT ON FUNCTION kg_temporal_relation_history(
  uuid, text, jsonb, text[], uuid, timestamptz, timestamptz, timestamptz, text[], int, text
) IS 'Phase 8 sanctioned relation history; historical canonical query roots resolve to their terminal visible identity before retrieval.';
