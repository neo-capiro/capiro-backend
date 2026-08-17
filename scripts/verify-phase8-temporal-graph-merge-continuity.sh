#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

INSERT INTO tenants (id, slug, name, status)
VALUES
  ('f8000000-0000-4000-8000-000000000001'::uuid, 'phase8-merge-a', 'Phase 8 Merge A', 'active'),
  ('f8000000-0000-4000-8000-000000000002'::uuid, 'phase8-merge-b', 'Phase 8 Merge B', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO canonical_entities (
  id, tenant_id, identity_scope, entity_type, canonical_name, normalized_name,
  status, resolution_confidence, resolution_method, metadata
) VALUES
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001', 'tenant_private', 'organization', 'Historical A', 'historical a', 'active', 1, 'human_confirmed', '{}'),
  ('f8100000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000001', 'tenant_private', 'organization', 'Intermediate B', 'intermediate b', 'active', 1, 'human_confirmed', '{}'),
  ('f8100000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000001', 'tenant_private', 'organization', 'Terminal C', 'terminal c', 'active', 1, 'human_confirmed', '{}'),
  ('f8100000-0000-4000-8000-000000000004', 'f8000000-0000-4000-8000-000000000001', 'tenant_private', 'organization', 'Object O', 'object o', 'active', 1, 'human_confirmed', '{}'),
  ('f8100000-0000-4000-8000-000000000005', 'f8000000-0000-4000-8000-000000000002', 'tenant_private', 'organization', 'Foreign D', 'foreign d', 'active', 1, 'human_confirmed', '{}'),
  ('f8100000-0000-4000-8000-000000000006', NULL, 'global_public', 'organization', 'Global G', 'global g', 'active', 1, 'human_confirmed', '{}'),
  ('f8100000-0000-4000-8000-000000000007', 'f8000000-0000-4000-8000-000000000001', 'tenant_private', 'organization', 'Cycle X', 'cycle x', 'active', 1, 'human_confirmed', '{}'),
  ('f8100000-0000-4000-8000-000000000008', 'f8000000-0000-4000-8000-000000000001', 'tenant_private', 'organization', 'Cycle Y', 'cycle y', 'active', 1, 'human_confirmed', '{}'),
  ('f8100000-0000-4000-8000-000000000009', 'f8000000-0000-4000-8000-000000000001', 'tenant_private', 'organization', 'Foreign Source', 'foreign source', 'active', 1, 'human_confirmed', '{}');

-- Durable evidence is written while Historical A is still active. These IDs
-- must remain unchanged after canonical convergence.
INSERT INTO knowledge_events (
  id, tenant_id, idempotency_key, source_type, source_id, source_content_hash,
  event_type, occurred_at, observed_at, actor_refs, entity_refs, client_refs,
  sensitivity, access_scope, evidence_locator, metadata, status
) VALUES (
  'f8200000-0000-4000-8000-000000000001',
  'f8000000-0000-4000-8000-000000000001',
  repeat('1', 64), 'mail', 'phase8-message', repeat('a', 64), 'relationship_observed',
  '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z', '[]', '[]', '[]',
  'normal', '{"kind":"tenant"}', '{"kind":"message","id":"phase8-message"}', '{}', 'active'
);

INSERT INTO knowledge_assertions (
  id, tenant_id, idempotency_key, origin_event_id, subject_type, subject_id,
  predicate, object_type, object_id, assertion_class, confidence, authority,
  observed_at, valid_from, status, conflict_status, sensitivity, access_scope
) VALUES (
  'f8300000-0000-4000-8000-000000000001',
  'f8000000-0000-4000-8000-000000000001',
  repeat('2', 64), 'f8200000-0000-4000-8000-000000000001',
  'canonical_entity', 'f8100000-0000-4000-8000-000000000001',
  'works_with', 'canonical_entity', 'f8100000-0000-4000-8000-000000000004',
  'relationship', 0.95, 'source_reported',
  '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z',
  'active', 'none', 'normal', '{"kind":"tenant"}'
);

INSERT INTO knowledge_evidence (
  id, tenant_id, assertion_id, event_id, source_type, source_id, excerpt,
  start_offset, end_offset, content_hash
) VALUES (
  'f8400000-0000-4000-8000-000000000001',
  'f8000000-0000-4000-8000-000000000001',
  'f8300000-0000-4000-8000-000000000001',
  'f8200000-0000-4000-8000-000000000001',
  'mail', 'phase8-message', 'works with', 0, 10, repeat('a', 64)
);

-- A second, wholly separate tenant's own assertion touching the same
-- global-public entity as tenant A. Used to prove tenant B's private graph
-- data is invisible to tenant A even though the canonical entity is shared.
INSERT INTO knowledge_events (
  id, tenant_id, idempotency_key, source_type, source_id, source_content_hash,
  event_type, occurred_at, observed_at, actor_refs, entity_refs, client_refs,
  sensitivity, access_scope, evidence_locator, metadata, status
) VALUES (
  'f8200000-0000-4000-8000-000000000002',
  'f8000000-0000-4000-8000-000000000002',
  repeat('3', 64), 'mail', 'phase8-message-b', repeat('b', 64), 'relationship_observed',
  '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z', '[]', '[]', '[]',
  'normal', '{"kind":"tenant"}', '{"kind":"message","id":"phase8-message-b"}', '{}', 'active'
);

INSERT INTO knowledge_assertions (
  id, tenant_id, idempotency_key, origin_event_id, subject_type, subject_id,
  predicate, object_type, object_id, assertion_class, confidence, authority,
  observed_at, valid_from, status, conflict_status, sensitivity, access_scope
) VALUES (
  'f8300000-0000-4000-8000-000000000002',
  'f8000000-0000-4000-8000-000000000002',
  repeat('4', 64), 'f8200000-0000-4000-8000-000000000002',
  'canonical_entity', 'f8100000-0000-4000-8000-000000000005',
  'affiliated_with', 'canonical_entity', 'f8100000-0000-4000-8000-000000000006',
  'relationship', 0.95, 'source_reported',
  '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z',
  'active', 'none', 'normal', '{"kind":"tenant"}'
);

INSERT INTO knowledge_evidence (
  id, tenant_id, assertion_id, event_id, source_type, source_id, excerpt,
  start_offset, end_offset, content_hash
) VALUES (
  'f8400000-0000-4000-8000-000000000002',
  'f8000000-0000-4000-8000-000000000002',
  'f8300000-0000-4000-8000-000000000002',
  'f8200000-0000-4000-8000-000000000002',
  'mail', 'phase8-message-b', 'affiliated with', 0, 15, repeat('b', 64)
);

-- A -> B -> C multi-hop convergence using the real Phase 5 ledger contract.
INSERT INTO canonical_entity_merges (
  tenant_id, source_entity_id, target_entity_id, reason_code, reason, provenance
) VALUES (
  'f8000000-0000-4000-8000-000000000001',
  'f8100000-0000-4000-8000-000000000001',
  'f8100000-0000-4000-8000-000000000002',
  'duplicate_identity', 'Phase 8 continuity rehearsal A to B', '[]'
);
UPDATE canonical_entities
SET status = 'merged', merged_into_entity_id = 'f8100000-0000-4000-8000-000000000002'
WHERE id = 'f8100000-0000-4000-8000-000000000001';

INSERT INTO canonical_entity_merges (
  tenant_id, source_entity_id, target_entity_id, reason_code, reason, provenance
) VALUES (
  'f8000000-0000-4000-8000-000000000001',
  'f8100000-0000-4000-8000-000000000002',
  'f8100000-0000-4000-8000-000000000003',
  'duplicate_identity', 'Phase 8 continuity rehearsal B to C', '[]'
);
UPDATE canonical_entities
SET status = 'merged', merged_into_entity_id = 'f8100000-0000-4000-8000-000000000003'
WHERE id = 'f8100000-0000-4000-8000-000000000002';

DO $$
DECLARE
  v_terminal uuid;
  v_src uuid;
  v_assertion uuid;
  v_event uuid;
  v_evidence uuid;
BEGIN
  SELECT kg_resolve_terminal_canonical_entity(
    'f8100000-0000-4000-8000-000000000001',
    'f8000000-0000-4000-8000-000000000001'
  ) INTO v_terminal;
  IF v_terminal IS DISTINCT FROM 'f8100000-0000-4000-8000-000000000003'::uuid THEN
    RAISE EXCEPTION 'multi-hop terminal resolution failed: %', v_terminal;
  END IF;

  SELECT src_id::uuid, assertion_id, event_id, evidence_id
    INTO v_src, v_assertion, v_event, v_evidence
  FROM kg_temporal_assertion_edges
  WHERE assertion_id = 'f8300000-0000-4000-8000-000000000001';

  IF v_src IS DISTINCT FROM 'f8100000-0000-4000-8000-000000000003'::uuid THEN
    RAISE EXCEPTION 'pre-merge assertion did not survive through terminal canonical node: %', v_src;
  END IF;
  IF v_assertion IS DISTINCT FROM 'f8300000-0000-4000-8000-000000000001'::uuid
     OR v_event IS DISTINCT FROM 'f8200000-0000-4000-8000-000000000001'::uuid
     OR v_evidence IS DISTINCT FROM 'f8400000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'historical provenance changed during terminal projection';
  END IF;

  IF kg_resolve_terminal_canonical_entity(
    'f8100000-0000-4000-8000-000000000005',
    'f8000000-0000-4000-8000-000000000001'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'foreign-tenant canonical identity was visible';
  END IF;

  IF kg_resolve_terminal_canonical_entity(
    'f8100000-0000-4000-8000-000000000006',
    'f8000000-0000-4000-8000-000000000001'
  ) IS DISTINCT FROM 'f8100000-0000-4000-8000-000000000006'::uuid THEN
    RAISE EXCEPTION 'legitimate global-public canonical identity was rejected';
  END IF;
END $$;

-- A resolved edge existing in the view is not sufficient: a caller that still
-- holds the pre-merge UUID must reach the surviving node through the actual
-- sanctioned entry points (kg_temporal_walk_bounded / kg_temporal_relation_history),
-- not merely through the internal resolver or a direct view read.
DO $$
DECLARE
  v_src uuid;
  v_dst uuid;
  v_assertion uuid;
  v_event uuid;
  v_evidence uuid;
  v_hash text;
  v_start int;
  v_end int;
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000001'::uuid, -- OLD pre-merge query root (Historical A)
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'walkAsOf(oldMergedUuid) did not reach exactly one edge from the surviving terminal node: got %', v_count;
  END IF;

  SELECT src_canonical_entity_id, dst_canonical_entity_id, assertion_id, event_id, evidence_id,
         evidence_content_hash, evidence_start_offset, evidence_end_offset
    INTO v_src, v_dst, v_assertion, v_event, v_evidence, v_hash, v_start, v_end
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000001'::uuid,
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );

  IF v_src IS DISTINCT FROM 'f8100000-0000-4000-8000-000000000003'::uuid THEN
    RAISE EXCEPTION 'walkAsOf(oldMergedUuid) did not project the surviving terminal canonical node as src: %', v_src;
  END IF;
  IF v_dst IS DISTINCT FROM 'f8100000-0000-4000-8000-000000000004'::uuid THEN
    RAISE EXCEPTION 'walkAsOf(oldMergedUuid) resolved an unexpected dst node: %', v_dst;
  END IF;
  IF v_assertion IS DISTINCT FROM 'f8300000-0000-4000-8000-000000000001'::uuid
     OR v_event IS DISTINCT FROM 'f8200000-0000-4000-8000-000000000001'::uuid
     OR v_evidence IS DISTINCT FROM 'f8400000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'walkAsOf(oldMergedUuid) altered historical assertion/event/evidence provenance';
  END IF;
  IF v_hash IS DISTINCT FROM repeat('a', 64) OR v_start IS DISTINCT FROM 0 OR v_end IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'walkAsOf(oldMergedUuid) altered evidence content hash or offsets: hash=%, start=%, end=%', v_hash, v_start, v_end;
  END IF;

  -- Same continuity proof for relationHistory, the other sanctioned query root.
  SELECT src_canonical_entity_id, dst_canonical_entity_id, assertion_id, event_id, evidence_id
    INTO v_src, v_dst, v_assertion, v_event, v_evidence
  FROM kg_temporal_relation_history(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000001'::uuid, -- OLD pre-merge query root
    '2026-08-01T00:00:00Z'::timestamptz,
    '2026-08-02T00:00:00Z'::timestamptz,
    '2026-08-02T00:00:00Z'::timestamptz,
    NULL, 500, 'both'
  );

  IF v_src IS DISTINCT FROM 'f8100000-0000-4000-8000-000000000003'::uuid THEN
    RAISE EXCEPTION 'relationHistory(oldMergedUuid) did not project the surviving terminal canonical node as src: %', v_src;
  END IF;
  IF v_assertion IS DISTINCT FROM 'f8300000-0000-4000-8000-000000000001'::uuid
     OR v_event IS DISTINCT FROM 'f8200000-0000-4000-8000-000000000001'::uuid
     OR v_evidence IS DISTINCT FROM 'f8400000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'relationHistory(oldMergedUuid) altered historical assertion/event/evidence provenance';
  END IF;

  -- A malformed/cyclic/foreign-tenant query root must fail closed through the
  -- sanctioned entry point too, not only through the internal resolver.
  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000005'::uuid, -- foreign tenant-private entity
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'kg_temporal_walk_bounded did not fail closed on a foreign-tenant query root';
  END IF;

  -- Bitemporal safety: a fact must not be visible before the system actually
  -- observed it, even though its valid_from predates that instant. Prevents
  -- hindsight leakage into historical reasoning.
  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000001'::uuid,
    '2026-07-01T00:00:00Z'::timestamptz, -- before observed_at (2026-08-01)
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'walkAsOf leaked a fact before its observed_at instant (hindsight leakage): got % rows', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM kg_temporal_relation_history(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000001'::uuid,
    '2026-08-01T00:00:00Z'::timestamptz,
    '2026-08-02T00:00:00Z'::timestamptz,
    '2026-07-01T00:00:00Z'::timestamptz, -- observedThrough before observed_at
    NULL, 500, 'both'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'relationHistory leaked a fact before observedThrough (hindsight leakage): got % rows', v_count;
  END IF;
END $$;

-- Tenant isolation: tenant B has its own assertion touching a shared
-- global-public entity. Tenant A must not see it even though the entity is
-- visible to both, and tenant B must see it under its own tenant_id.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid, -- tenant A
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000006'::uuid, -- Global G (shared identity)
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'tenant A saw tenant B private graph edges through a shared global-public entity: got % rows', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000002'::uuid, -- tenant B, its own data
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000006'::uuid,
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant B could not see its own graph edge through its own tenant_id: got % rows', v_count;
  END IF;

  -- Wrong sensitivity, wrong access_scope, and wrong client_ref_keys must each
  -- independently yield zero rows against tenant A's own real, correctly
  -- scoped assertion (terminal node, so this isolates the partition check from
  -- merge continuity).
  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'restricted', -- wrong sensitivity; real value is 'normal'
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000003'::uuid,
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'wrong sensitivity partition returned cross-partition data: got % rows', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"other"}'::jsonb, -- wrong access_scope; real value is {"kind":"tenant"}
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000003'::uuid,
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'wrong access_scope partition returned cross-partition data: got % rows', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY['bogus:key'], -- wrong client_ref_keys; real value is {} (no client refs)
    'f8100000-0000-4000-8000-000000000003'::uuid,
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'wrong client_ref_keys partition returned cross-partition data: got % rows', v_count;
  END IF;
END $$;

-- Defense in depth: the SQL layer must clamp depth/fanout/row-budget itself
-- (LEAST/GREATEST) even if a caller bypasses the TypeScript-layer validation
-- and passes wildly out-of-range values directly to the function.
DO $$
DECLARE
  v_count int;
  v_started timestamptz := clock_timestamp();
  v_elapsed_ms double precision;
BEGIN
  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000003'::uuid,
    '2026-08-02T00:00:00Z'::timestamptz,
    999999,   -- absurd depth; must clamp to 5
    NULL,
    999999,   -- absurd fanout; must clamp to 100
    999999999, -- absurd row budget; must clamp to 5000
    'both'
  );
  v_elapsed_ms := extract(epoch FROM clock_timestamp() - v_started) * 1000;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'out-of-range traversal parameters produced an unexpected row count: got %', v_count;
  END IF;
  IF v_elapsed_ms > 3000 THEN
    RAISE EXCEPTION 'out-of-range traversal parameters were not bounded: took % ms', v_elapsed_ms;
  END IF;
END $$;

-- The sanctioned wrapper functions must actually work when invoked as the real
-- tenant application role, and the internal resolver / unresolved primitives
-- must remain inaccessible to that same role. Grepping migration text for
-- GRANT/REVOKE statements proves intent; this proves the runtime contract.
SET ROLE capiro_app;

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
  FROM kg_temporal_walk_bounded(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000001'::uuid,
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'capiro_app could not use the sanctioned kg_temporal_walk_bounded entry point: got % rows', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM kg_temporal_relation_history(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000001'::uuid,
    '2026-08-01T00:00:00Z'::timestamptz,
    '2026-08-02T00:00:00Z'::timestamptz,
    '2026-08-02T00:00:00Z'::timestamptz,
    NULL, 500, 'both'
  );
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'capiro_app could not use the sanctioned kg_temporal_relation_history entry point: got % rows', v_count;
  END IF;
END $$;

DO $$
BEGIN
  PERFORM kg_resolve_terminal_canonical_entity(
    'f8100000-0000-4000-8000-000000000001'::uuid,
    'f8000000-0000-4000-8000-000000000001'::uuid
  );
  RAISE EXCEPTION 'capiro_app was able to execute the internal kg_resolve_terminal_canonical_entity resolver directly';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL; -- expected: capiro_app has no EXECUTE grant on this internal function
END $$;

DO $$
BEGIN
  PERFORM kg_temporal_walk_bounded_unresolved(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000003'::uuid,
    '2026-08-02T00:00:00Z'::timestamptz,
    2, NULL, 25, 500, 'both'
  );
  RAISE EXCEPTION 'capiro_app was able to execute the internal kg_temporal_walk_bounded_unresolved function directly';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL; -- expected
END $$;

DO $$
BEGIN
  PERFORM kg_temporal_relation_history_unresolved(
    'f8000000-0000-4000-8000-000000000001'::uuid,
    'normal',
    '{"kind":"tenant"}'::jsonb,
    ARRAY[]::text[],
    'f8100000-0000-4000-8000-000000000003'::uuid,
    '2026-08-01T00:00:00Z'::timestamptz,
    '2026-08-02T00:00:00Z'::timestamptz,
    '2026-08-02T00:00:00Z'::timestamptz,
    NULL, 500, 'both'
  );
  RAISE EXCEPTION 'capiro_app was able to execute the internal kg_temporal_relation_history_unresolved function directly';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL; -- expected
END $$;

RESET ROLE;

-- Build deliberately malformed chains with governance triggers disabled to
-- prove the read path fails closed even if privileged maintenance corrupts data.
ALTER TABLE canonical_entity_merges DISABLE TRIGGER USER;
ALTER TABLE canonical_entities DISABLE TRIGGER USER;

INSERT INTO canonical_entity_merges (
  tenant_id, source_entity_id, target_entity_id, reason_code, reason, provenance
) VALUES
  ('f8000000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000007', 'f8100000-0000-4000-8000-000000000008', 'test_corruption', 'cycle x-y', '[]'),
  ('f8000000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000008', 'f8100000-0000-4000-8000-000000000007', 'test_corruption', 'cycle y-x', '[]'),
  ('f8000000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000009', 'f8100000-0000-4000-8000-000000000005', 'test_corruption', 'foreign target', '[]');

UPDATE canonical_entities
SET status = 'merged', merged_into_entity_id = 'f8100000-0000-4000-8000-000000000008'
WHERE id = 'f8100000-0000-4000-8000-000000000007';
UPDATE canonical_entities
SET status = 'merged', merged_into_entity_id = 'f8100000-0000-4000-8000-000000000007'
WHERE id = 'f8100000-0000-4000-8000-000000000008';
UPDATE canonical_entities
SET status = 'merged', merged_into_entity_id = 'f8100000-0000-4000-8000-000000000005'
WHERE id = 'f8100000-0000-4000-8000-000000000009';

ALTER TABLE canonical_entities ENABLE TRIGGER USER;
ALTER TABLE canonical_entity_merges ENABLE TRIGGER USER;

DO $$
BEGIN
  IF kg_resolve_terminal_canonical_entity(
    'f8100000-0000-4000-8000-000000000007',
    'f8000000-0000-4000-8000-000000000001'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'cyclic canonical merge chain did not fail closed';
  END IF;

  IF kg_resolve_terminal_canonical_entity(
    'f8100000-0000-4000-8000-000000000009',
    'f8000000-0000-4000-8000-000000000001'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'foreign-tenant merge target did not fail closed';
  END IF;
END $$;

ROLLBACK;
SQL

# The derived view runs with owner visibility, so direct tenant-path reads must
# remain denied. SECURITY DEFINER traversal functions are the only app surface.
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET ROLE capiro_app; SELECT * FROM kg_temporal_assertion_edges LIMIT 1;" >/tmp/phase8-raw-view.out 2>/tmp/phase8-raw-view.err; then
  echo "raw kg_temporal_assertion_edges SELECT unexpectedly succeeded as capiro_app" >&2
  cat /tmp/phase8-raw-view.out >&2
  exit 1
fi

echo "Phase 8 temporal graph merge-continuity database rehearsal passed."
