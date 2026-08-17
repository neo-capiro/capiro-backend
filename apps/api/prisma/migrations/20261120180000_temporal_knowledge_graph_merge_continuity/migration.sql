-- Knowledge Plane Phase 8 hardening — canonical merge continuity.
--
-- Historical KnowledgeAssertions are immutable and may reference a canonical
-- entity that Phase 5 later merged. Resolve that historical UUID through the
-- authoritative CanonicalEntity lifecycle at read time; never rewrite the
-- assertion, event, or evidence lineage and never introduce a second graph.

CREATE OR REPLACE FUNCTION kg_resolve_terminal_canonical_entity(
  p_entity_id uuid,
  p_tenant_id uuid
) RETURNS uuid
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_current uuid := p_entity_id;
  v_next uuid;
  v_status text;
  v_scope text;
  v_owner uuid;
  v_entity_type text;
  v_expected_type text;
  v_seen uuid[] := '{}'::uuid[];
  v_hops int := 0;
  v_max_hops constant int := 16;
BEGIN
  IF p_entity_id IS NULL OR p_tenant_id IS NULL THEN
    RETURN NULL;
  END IF;

  LOOP
    -- Corrupt/cyclic chains fail closed instead of leaking or hanging.
    IF v_current = ANY(v_seen) OR v_hops > v_max_hops THEN
      RETURN NULL;
    END IF;

    SELECT status, identity_scope, tenant_id, entity_type, merged_into_entity_id
      INTO v_status, v_scope, v_owner, v_entity_type, v_next
    FROM canonical_entities
    WHERE id = v_current;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    IF v_expected_type IS NULL THEN
      v_expected_type := v_entity_type;
    ELSIF v_entity_type IS DISTINCT FROM v_expected_type THEN
      RETURN NULL;
    END IF;

    -- Phase 5 visibility contract: global public identity is tenantless;
    -- private identity belongs to exactly the assertion tenant.
    IF NOT (
      (v_scope = 'global_public' AND v_owner IS NULL)
      OR
      (v_scope = 'tenant_private' AND v_owner = p_tenant_id)
    ) THEN
      RETURN NULL;
    END IF;

    v_seen := array_append(v_seen, v_current);

    IF v_status = 'active' THEN
      -- Active entities are terminal. A dangling merge pointer is malformed.
      IF v_next IS NOT NULL THEN
        RETURN NULL;
      END IF;
      RETURN v_current;
    END IF;

    -- Only a same-tenant private entity can be a Phase 5 merge source.
    IF v_status <> 'merged'
       OR v_scope <> 'tenant_private'
       OR v_owner <> p_tenant_id
       OR v_next IS NULL THEN
      RETURN NULL;
    END IF;

    -- A persisted merge pointer without its append-only Phase 5 lineage is
    -- invalid. Require the exact source -> target record before following it.
    IF NOT EXISTS (
      SELECT 1
      FROM canonical_entity_merges m
      WHERE m.tenant_id = p_tenant_id
        AND m.source_entity_id = v_current
        AND m.target_entity_id = v_next
    ) THEN
      RETURN NULL;
    END IF;

    v_current := v_next;
    v_hops := v_hops + 1;
  END LOOP;
END $fn$;

COMMENT ON FUNCTION kg_resolve_terminal_canonical_entity(uuid, uuid) IS
  'Phase 8 internal read-time canonical merge resolver. Bounded, cycle-safe, tenant/global-public scoped, lineage-checked, and fail-closed.';

-- This helper executes with owner visibility because canonical identity can be
-- global while assertions are tenant-private. It is internal to the owner view;
-- application roles must use the sanctioned temporal graph functions instead.
REVOKE ALL ON FUNCTION kg_resolve_terminal_canonical_entity(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION kg_resolve_terminal_canonical_entity(uuid, uuid) FROM capiro_app;

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
JOIN LATERAL (
  SELECT kg_resolve_terminal_canonical_entity(
    CASE
      WHEN a.subject_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN a.subject_id::uuid
      ELSE NULL
    END,
    a.tenant_id
  ) AS id
) src_resolved ON src_resolved.id IS NOT NULL
JOIN canonical_entities src
  ON src.id = src_resolved.id
 AND src.status = 'active'
 AND (
      (src.identity_scope = 'global_public' AND src.tenant_id IS NULL)
      OR (src.identity_scope = 'tenant_private' AND src.tenant_id = a.tenant_id)
 )
JOIN LATERAL (
  SELECT kg_resolve_terminal_canonical_entity(
    CASE
      WHEN a.object_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN a.object_id::uuid
      ELSE NULL
    END,
    a.tenant_id
  ) AS id
) dst_resolved ON dst_resolved.id IS NOT NULL
JOIN canonical_entities dst
  ON dst.id = dst_resolved.id
 AND dst.status = 'active'
 AND (
      (dst.identity_scope = 'global_public' AND dst.tenant_id IS NULL)
      OR (dst.identity_scope = 'tenant_private' AND dst.tenant_id = a.tenant_id)
 )
JOIN LATERAL (
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
  AND a.sensitivity = ev.sensitivity
  AND a.access_scope = ev.access_scope;

COMMENT ON VIEW kg_temporal_assertion_edges IS
  'Phase 8 derived temporal canonical graph with read-time Phase 5 merge continuity. Original assertion/event/evidence provenance is preserved; terminal canonical IDs are graph node identity.';

REVOKE ALL ON TABLE kg_temporal_assertion_edges FROM PUBLIC;
REVOKE ALL ON TABLE kg_temporal_assertion_edges FROM capiro_app;
