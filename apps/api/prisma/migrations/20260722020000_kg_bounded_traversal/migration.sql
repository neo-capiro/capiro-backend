-- Track B M2 — bounded, tenant + ethical-wall SCOPED graph traversal over the
-- materialized kg_edge_cache (fixes RC2: the old kg_walk had no fanout cap, no
-- cycle detection, no timeout, and ran the raw 22-branch union per hop inside a
-- pooled interactive txn — the pool-starvation cause). Additive; the old kg_walk
-- / kg_neighbors are untouched. Ships DARK (only called when KG_TRAVERSAL_SOURCE
-- ='cache'). SECURITY DEFINER: reads the un-GRANTed cache as owner; isolation is
-- enforced ENTIRELY by the mandatory params below (the cache is RLS-exempt).
--
-- Anti-starvation ceilings, ALL enforced: per-node fanout cap (LATERAL LIMIT),
-- per-path cycle detection (visited array), depth cap, total row budget, and a
-- hard function-scoped statement_timeout (auto-restored on return).

CREATE OR REPLACE FUNCTION kg_walk_bounded(
  p_tenant_id         uuid,             -- MANDATORY (RAISE on NULL)
  p_denied_client_ids uuid[],           -- MANDATORY (RAISE on NULL; pass '{}' only for a
                                        --   see-everything caller — fail-closed otherwise)
  p_kind              text,
  p_id                text,
  p_max_depth         int    DEFAULT 2,
  p_edge_types        text[] DEFAULT NULL,
  p_fanout            int    DEFAULT 25,
  p_row_budget        int    DEFAULT 500,
  p_direction         text   DEFAULT 'both'
) RETURNS TABLE (
  depth int, src_kind text, src_id text, dst_kind text, dst_id text, edge_type text,
  confidence float, source text, origin text, observed_at timestamptz,
  agg_weight numeric, agg_count int, tenant_id uuid
) LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET statement_timeout = '3s'
AS $fn$
DECLARE
  v_depth int := LEAST(GREATEST(COALESCE(p_max_depth, 2), 1), 5);
  v_fanout int := LEAST(GREATEST(COALESCE(p_fanout, 25), 1), 100);
  v_budget int := LEAST(GREATEST(COALESCE(p_row_budget, 500), 1), 5000);
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'kg_walk_bounded: p_tenant_id is mandatory';
  END IF;
  IF p_denied_client_ids IS NULL THEN
    RAISE EXCEPTION 'kg_walk_bounded: p_denied_client_ids is mandatory (pass ''{}'' explicitly)';
  END IF;

  RETURN QUERY
  WITH RECURSIVE walk AS (
    -- Seed node (depth 0, no edge). chr(31) = ASCII unit separator (never in ids).
    SELECT 0 AS depth,
           p_kind AS node_kind, p_id AS node_id,
           ARRAY[p_kind || chr(31) || p_id] AS visited,
           NULL::text AS e_src_kind, NULL::text AS e_src_id,
           NULL::text AS e_dst_kind, NULL::text AS e_dst_id, NULL::text AS e_edge_type,
           NULL::float AS e_confidence, NULL::text AS e_source, NULL::text AS e_origin,
           NULL::timestamptz AS e_observed_at, NULL::numeric AS e_agg_weight,
           NULL::int AS e_agg_count, NULL::uuid AS e_tenant_id
    UNION ALL
    SELECT w.depth + 1,
           nb.n_kind, nb.n_id,
           w.visited || (nb.n_kind || chr(31) || nb.n_id),
           nb.c_src_kind, nb.c_src_id, nb.c_dst_kind, nb.c_dst_id, nb.c_edge_type,
           nb.c_confidence, nb.c_source, nb.c_origin, nb.c_observed_at,
           nb.c_agg_weight, nb.c_agg_count, nb.c_tenant_id
    FROM walk w
    CROSS JOIN LATERAL (
      SELECT
        (CASE WHEN c.src_kind = w.node_kind AND c.src_id = w.node_id THEN c.dst_kind ELSE c.src_kind END) AS n_kind,
        (CASE WHEN c.src_kind = w.node_kind AND c.src_id = w.node_id THEN c.dst_id ELSE c.src_id END) AS n_id,
        c.src_kind AS c_src_kind, c.src_id AS c_src_id, c.dst_kind AS c_dst_kind,
        c.dst_id AS c_dst_id, c.edge_type AS c_edge_type, c.confidence AS c_confidence,
        c.source AS c_source, c.origin AS c_origin, c.observed_at AS c_observed_at,
        c.agg_weight AS c_agg_weight, c.agg_count AS c_agg_count, c.tenant_id AS c_tenant_id
      FROM kg_edge_cache c
      WHERE (c.tenant_id IS NULL OR c.tenant_id = p_tenant_id)          -- TENANT (every hop)
        AND NOT (c.wall_client_ids && p_denied_client_ids)             -- WALL   (every hop)
        AND (p_edge_types IS NULL OR c.edge_type = ANY(p_edge_types))
        AND (
             (p_direction IN ('out','both') AND c.src_kind = w.node_kind AND c.src_id = w.node_id)
          OR (p_direction IN ('in','both')  AND c.dst_kind = w.node_kind AND c.dst_id = w.node_id)
        )
      ORDER BY COALESCE(c.agg_weight, 0) DESC, c.confidence DESC NULLS LAST
      LIMIT v_fanout
    ) nb
    WHERE w.depth < v_depth
      AND (nb.n_kind || chr(31) || nb.n_id) <> ALL(w.visited)          -- cycle detection
  )
  SELECT w.depth, w.e_src_kind, w.e_src_id, w.e_dst_kind, w.e_dst_id, w.e_edge_type,
         w.e_confidence, w.e_source, w.e_origin, w.e_observed_at, w.e_agg_weight,
         w.e_agg_count, w.e_tenant_id
  FROM walk w
  WHERE w.depth > 0
  LIMIT v_budget;
END $fn$;

GRANT EXECUTE ON FUNCTION kg_walk_bounded(uuid, uuid[], text, text, int, text[], int, int, text) TO capiro_app;

-- ROLLBACK (paired revert migration):
--   DROP FUNCTION IF EXISTS kg_walk_bounded(uuid, uuid[], text, text, int, text[], int, int, text);
