-- Knowledge Plane Phase 8 — Temporal Knowledge Graph.
--
-- Canonical identity is the node identity. KnowledgeAssertion remains the
-- authoritative relation record and KnowledgeEvidence remains the authoritative
-- proof. This migration does NOT create another graph table or copy evidence
-- excerpts. Instead it adds a read-only graph projection over the existing
-- Knowledge Plane and SECURITY DEFINER traversal functions with mandatory
-- tenant/security-partition parameters.
--
-- The existing kg_edge_cache / kg_walk_bounded infrastructure remains intact.
-- Phase 8 adds the canonical temporal relation surface alongside it so Phase 9
-- can compose retrieval without replacing either source-of-truth or the current
-- bounded traversal path.

CREATE OR REPLACE VIEW kg_temporal_assertion_edges
WITH (security_barrier = true)
AS
SELECT
  'canonical_entity'::text AS src_kind,
  src.id::text AS src_id,
  'canonical_entity'::text AS dst_kind,
  dst.id::text AS dst_id,
  a.predicate::text AS edge_type,
  a.confidence::double precision AS confidence,
  'knowledge_assertion'::text AS source,
  'knowledge'::text AS origin,
  a.observed_at,
  a.valid_from,
  a.valid_until,
  a.tenant_id,
  a.sensitivity::text AS sensitivity,
  a.access_scope,
  COALESCE(client_scope.client_ref_keys, '{}'::text[]) AS client_ref_keys,
  a.id AS assertion_id,
  a.origin_event_id AS event_id,
  proof.id AS evidence_id,
  proof.source_type::text AS evidence_source_type,
  proof.source_id::text AS evidence_source_id,
  proof.content_hash::text AS evidence_content_hash,
  proof.start_offset AS evidence_start_offset,
  proof.end_offset AS evidence_end_offset
FROM knowledge_assertions a
JOIN knowledge_events ev
  ON ev.tenant_id = a.tenant_id
 AND ev.id = a.origin_event_id
 AND ev.status = 'active'
JOIN canonical_entities src
  ON src.id::text = a.subject_id
 AND src.status = 'active'
 AND (src.tenant_id IS NULL OR src.tenant_id = a.tenant_id)
JOIN canonical_entities dst
  ON dst.id::text = a.object_id
 AND dst.status = 'active'
 AND (dst.tenant_id IS NULL OR dst.tenant_id = a.tenant_id)
JOIN LATERAL (
  -- Phase 3 guarantees at least one origin-event excerpt for every durable
  -- assertion. Pick one deterministically for edge-level provenance; callers
  -- can expand to all proof through assertion_id without duplicating excerpts.
  SELECT e.id, e.source_type, e.source_id, e.content_hash, e.start_offset, e.end_offset
  FROM knowledge_evidence e
  WHERE e.tenant_id = a.tenant_id
    AND e.assertion_id = a.id
    AND e.event_id = a.origin_event_id
  ORDER BY e.created_at ASC, e.id ASC
  LIMIT 1
) proof ON TRUE
LEFT JOIN LATERAL (
  SELECT ARRAY_AGG(keys.client_ref_key ORDER BY keys.client_ref_key) AS client_ref_keys
  FROM (
    SELECT DISTINCT
      (ref.value ->> 'type') || ':' || (ref.value ->> 'id') AS client_ref_key
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(ev.client_refs) = 'array' THEN ev.client_refs ELSE '[]'::jsonb END
    ) AS ref(value)
    WHERE jsonb_typeof(ref.value) = 'object'
      AND NULLIF(BTRIM(ref.value ->> 'type'), '') IS NOT NULL
      AND NULLIF(BTRIM(ref.value ->> 'id'), '') IS NOT NULL
  ) keys
) client_scope ON TRUE
WHERE a.status = 'active'
  AND a.subject_type = 'canonical_entity'
  AND a.object_type = 'canonical_entity'
  AND a.object_id IS NOT NULL
  -- Assertions inherit both fields from the immutable origin event. Repeat the
  -- equality here because this view is a security-sensitive derived surface.
  AND a.sensitivity = ev.sensitivity
  AND a.access_scope = ev.access_scope;

COMMENT ON VIEW kg_temporal_assertion_edges IS
  'Phase 8 derived temporal canonical graph. RLS-exempt owner view: NEVER grant raw SELECT to tenant paths. Use kg_temporal_walk_bounded / kg_temporal_relation_history, which require exact tenant + security partition parameters.';

-- The view owner may bypass RLS on underlying tables. Direct application reads
-- would therefore be unsafe. The only sanctioned application access is through
-- the mandatory-parameter SECURITY DEFINER functions below.
REVOKE ALL ON TABLE kg_temporal_assertion_edges FROM PUBLIC;
REVOKE ALL ON TABLE kg_temporal_assertion_edges FROM capiro_app;

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
  v_depth int := LEAST(GREATEST(COALESCE(p_max_depth, 2), 1), 5);
  v_fanout int := LEAST(GREATEST(COALESCE(p_fanout, 25), 1), 100);
  v_budget int := LEAST(GREATEST(COALESCE(p_row_budget, 500), 1), 5000);
  v_client_ref_keys text[];
BEGIN
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

  SELECT COALESCE(ARRAY_AGG(k ORDER BY k), '{}'::text[])
  INTO v_client_ref_keys
  FROM (
    SELECT DISTINCT BTRIM(refs.value) AS k
    FROM unnest(p_client_ref_keys) AS refs(value)
    WHERE NULLIF(BTRIM(refs.value), '') IS NOT NULL
  ) normalized;

  RETURN QUERY
  WITH RECURSIVE walk AS (
    SELECT
      0 AS depth,
      p_canonical_entity_id AS node_id,
      ARRAY[p_canonical_entity_id]::uuid[] AS visited,
      NULL::uuid AS e_src_id,
      NULL::uuid AS e_dst_id,
      NULL::text AS e_edge_type,
      NULL::double precision AS e_confidence,
      NULL::timestamptz AS e_observed_at,
      NULL::timestamptz AS e_valid_from,
      NULL::timestamptz AS e_valid_until,
      NULL::uuid AS e_assertion_id,
      NULL::uuid AS e_event_id,
      NULL::uuid AS e_evidence_id,
      NULL::text AS e_evidence_source_type,
      NULL::text AS e_evidence_source_id,
      NULL::text AS e_evidence_content_hash,
      NULL::int AS e_evidence_start_offset,
      NULL::int AS e_evidence_end_offset,
      NULL::text AS e_sensitivity,
      NULL::text[] AS e_client_ref_keys
    UNION ALL
    SELECT
      w.depth + 1,
      nb.next_id,
      w.visited || nb.next_id,
      nb.src_id,
      nb.dst_id,
      nb.edge_type,
      nb.confidence,
      nb.observed_at,
      nb.valid_from,
      nb.valid_until,
      nb.assertion_id,
      nb.event_id,
      nb.evidence_id,
      nb.evidence_source_type,
      nb.evidence_source_id,
      nb.evidence_content_hash,
      nb.evidence_start_offset,
      nb.evidence_end_offset,
      nb.sensitivity,
      nb.client_ref_keys
    FROM walk w
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN e.src_id::uuid = w.node_id THEN e.dst_id::uuid ELSE e.src_id::uuid END AS next_id,
        e.src_id::uuid AS src_id,
        e.dst_id::uuid AS dst_id,
        e.edge_type,
        e.confidence,
        e.observed_at,
        e.valid_from,
        e.valid_until,
        e.assertion_id,
        e.event_id,
        e.evidence_id,
        e.evidence_source_type,
        e.evidence_source_id,
        e.evidence_content_hash,
        e.evidence_start_offset,
        e.evidence_end_offset,
        e.sensitivity,
        e.client_ref_keys
      FROM kg_temporal_assertion_edges e
      WHERE e.tenant_id = p_tenant_id
        AND e.sensitivity = p_sensitivity
        AND e.access_scope = p_access_scope
        AND e.client_ref_keys = v_client_ref_keys
        -- Bitemporal safety: the relation must be valid at the requested time,
        -- and the system must already have observed it by that time. This
        -- prevents future knowledge from leaking into historical reasoning.
        AND e.valid_from <= p_as_of
        AND (e.valid_until IS NULL OR p_as_of < e.valid_until)
        AND e.observed_at <= p_as_of
        AND (p_edge_types IS NULL OR e.edge_type = ANY(p_edge_types))
        AND (
             (p_direction IN ('out', 'both') AND e.src_id = w.node_id::text)
          OR (p_direction IN ('in', 'both')  AND e.dst_id = w.node_id::text)
        )
      ORDER BY e.confidence DESC NULLS LAST, e.observed_at DESC, e.assertion_id
      LIMIT v_fanout
    ) nb
    WHERE w.depth < v_depth
      AND nb.next_id <> ALL(w.visited)
  )
  SELECT
    w.depth,
    w.e_src_id,
    w.e_dst_id,
    w.e_edge_type,
    w.e_confidence,
    w.e_observed_at,
    w.e_valid_from,
    w.e_valid_until,
    w.e_assertion_id,
    w.e_event_id,
    w.e_evidence_id,
    w.e_evidence_source_type,
    w.e_evidence_source_id,
    w.e_evidence_content_hash,
    w.e_evidence_start_offset,
    w.e_evidence_end_offset,
    w.e_sensitivity,
    w.e_client_ref_keys
  FROM walk w
  WHERE w.depth > 0
  LIMIT v_budget;
END $fn$;

REVOKE ALL ON FUNCTION kg_temporal_walk_bounded(uuid, text, jsonb, text[], uuid, timestamptz, int, text[], int, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kg_temporal_walk_bounded(uuid, text, jsonb, text[], uuid, timestamptz, int, text[], int, int, text) TO capiro_app;

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
  v_budget int := LEAST(GREATEST(COALESCE(p_row_budget, 500), 1), 5000);
  v_client_ref_keys text[];
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

  SELECT COALESCE(ARRAY_AGG(k ORDER BY k), '{}'::text[])
  INTO v_client_ref_keys
  FROM (
    SELECT DISTINCT BTRIM(refs.value) AS k
    FROM unnest(p_client_ref_keys) AS refs(value)
    WHERE NULLIF(BTRIM(refs.value), '') IS NOT NULL
  ) normalized;

  RETURN QUERY
  SELECT
    e.src_id::uuid,
    e.dst_id::uuid,
    e.edge_type,
    e.confidence,
    e.observed_at,
    e.valid_from,
    e.valid_until,
    e.assertion_id,
    e.event_id,
    e.evidence_id,
    e.evidence_source_type,
    e.evidence_source_id,
    e.evidence_content_hash,
    e.evidence_start_offset,
    e.evidence_end_offset,
    e.sensitivity,
    e.client_ref_keys
  FROM kg_temporal_assertion_edges e
  WHERE e.tenant_id = p_tenant_id
    AND e.sensitivity = p_sensitivity
    AND e.access_scope = p_access_scope
    AND e.client_ref_keys = v_client_ref_keys
    AND e.observed_at <= p_observed_through
    -- Half-open validity ranges overlap the requested window.
    AND e.valid_from < p_window_end
    AND (e.valid_until IS NULL OR e.valid_until > p_window_start)
    AND (p_edge_types IS NULL OR e.edge_type = ANY(p_edge_types))
    AND (
         (p_direction IN ('out', 'both') AND e.src_id = p_canonical_entity_id::text)
      OR (p_direction IN ('in', 'both')  AND e.dst_id = p_canonical_entity_id::text)
    )
  ORDER BY e.valid_from ASC, e.observed_at ASC, e.assertion_id ASC
  LIMIT v_budget;
END $fn$;

REVOKE ALL ON FUNCTION kg_temporal_relation_history(uuid, text, jsonb, text[], uuid, timestamptz, timestamptz, timestamptz, text[], int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kg_temporal_relation_history(uuid, text, jsonb, text[], uuid, timestamptz, timestamptz, timestamptz, text[], int, text) TO capiro_app;

-- Explicitly document the absence of historical writes/backfill: the Phase 8
-- graph is derived directly from immutable assertion/evidence rows, so existing
-- history is available immediately through the view with no migration-time data
-- mutation and no background reconstruction job.
