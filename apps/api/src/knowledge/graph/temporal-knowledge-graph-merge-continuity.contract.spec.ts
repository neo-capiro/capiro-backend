import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function repositoryPath(relativePath: string): string {
  const candidates = [join(process.cwd(), relativePath), join(process.cwd(), 'apps/api', relativePath)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`Could not resolve repository path: ${relativePath}`);
  return found;
}

const migration = readFileSync(
  repositoryPath(
    'prisma/migrations/20261120180000_temporal_knowledge_graph_merge_continuity/migration.sql',
  ),
  'utf8',
);

const phase5Merge = readFileSync(
  repositoryPath('prisma/migrations/20261120120000_canonical_entity_merge_ledger/migration.sql'),
  'utf8',
);

describe('Knowledge Plane Phase 8 canonical merge continuity contract', () => {
  test('resolves historical canonical IDs at read time without rewriting assertions', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION kg_resolve_terminal_canonical_entity');
    expect(migration).toContain('merged_into_entity_id');
    expect(migration).toContain('CREATE OR REPLACE VIEW kg_temporal_assertion_edges');
    expect(migration).toContain('src.id::text AS src_id');
    expect(migration).toContain('dst.id::text AS dst_id');
    expect(migration).not.toMatch(/UPDATE\s+knowledge_assertions/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+knowledge_assertions/i);
  });

  test('uses Phase 5 append-only merge lineage and terminal lifecycle semantics', () => {
    expect(migration).toContain('FROM canonical_entity_merges m');
    expect(migration).toContain('m.source_entity_id = v_current');
    expect(migration).toContain('m.target_entity_id = v_next');
    expect(migration).toContain("v_status <> 'merged'");
    expect(migration).toContain("v_status = 'active'");
    expect(phase5Merge).toContain('Canonical entity merge requires append-only merge lineage');
  });

  test('allows legitimate global-public targets but rejects foreign tenant-private identities', () => {
    expect(migration).toContain("v_scope = 'global_public' AND v_owner IS NULL");
    expect(migration).toContain("v_scope = 'tenant_private' AND v_owner = p_tenant_id");
    expect(migration).toContain("v_scope <> 'tenant_private'");
    expect(migration).toContain('v_owner <> p_tenant_id');
  });

  test('bounds multi-hop traversal and fails closed on cycles or malformed chains', () => {
    expect(migration).toContain('v_max_hops constant int := 16');
    expect(migration).toContain('v_current = ANY(v_seen)');
    expect(migration).toContain('v_hops > v_max_hops');
    expect(migration).toContain('v_seen := array_append(v_seen, v_current)');
    expect(migration).toContain('v_current := v_next');
    expect(migration).toContain('v_entity_type IS DISTINCT FROM v_expected_type');
    expect(migration).toContain('IF NOT FOUND THEN');
  });

  test('keeps the internal resolver inaccessible to tenant application paths', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION kg_resolve_terminal_canonical_entity(uuid, uuid) FROM PUBLIC',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION kg_resolve_terminal_canonical_entity(uuid, uuid) FROM capiro_app',
    );
  });

  test('preserves original assertion, event, and evidence provenance on projected edges', () => {
    expect(migration).toContain('a.id AS assertion_id');
    expect(migration).toContain('a.origin_event_id AS event_id');
    expect(migration).toContain('proof.id AS evidence_id');
    expect(migration).toContain('proof.content_hash::text AS evidence_content_hash');
    expect(migration).not.toMatch(/proof\.excerpt|e\.excerpt\s+AS/i);
  });

  test('does not introduce a second graph or canonical mapping table', () => {
    expect(migration).not.toMatch(/CREATE\s+TABLE/i);
    expect(migration).not.toContain('projection_queue');
    expect(migration).not.toContain('canonical_mapping');
  });
});
