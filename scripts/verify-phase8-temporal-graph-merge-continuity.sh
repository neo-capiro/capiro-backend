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
