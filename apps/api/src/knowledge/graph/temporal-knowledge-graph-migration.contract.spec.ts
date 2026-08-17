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
  repositoryPath('prisma/migrations/20261120170000_temporal_knowledge_graph/migration.sql'),
  'utf8',
);

describe('Knowledge Plane Phase 8 temporal graph migration contract', () => {
  test('extends the graph as a derived view and creates no second graph table', () => {
    expect(migration).toContain('CREATE OR REPLACE VIEW kg_temporal_assertion_edges');
    expect(migration).not.toMatch(/CREATE TABLE\s+[^;]*(graph|edge)/i);
    expect(migration).not.toContain('knowledge_graph_projection_jobs');
    expect(migration).not.toMatch(/INSERT\s+INTO\s+kg_temporal/i);
  });

  test('canonical entity IDs are graph node identity without re-resolution', () => {
    expect(migration).toContain("'canonical_entity'::text AS src_kind");
    expect(migration).toContain('src.id::text AS src_id');
    expect(migration).toContain('dst.id::text AS dst_id');
    expect(migration).toContain("a.subject_type = 'canonical_entity'");
    expect(migration).toContain("a.object_type = 'canonical_entity'");
    expect(migration).not.toMatch(/resolver|web search|embedding/i);
  });

  test('foreign-tenant canonical entities are excluded while global entities remain valid', () => {
    expect(migration).toContain('(src.tenant_id IS NULL OR src.tenant_id = a.tenant_id)');
    expect(migration).toContain('(dst.tenant_id IS NULL OR dst.tenant_id = a.tenant_id)');
  });

  test('every graph edge is backed by an active assertion, active event, and deterministic evidence', () => {
    expect(migration).toContain("a.status = 'active'");
    expect(migration).toContain("ev.status = 'active'");
    expect(migration).toContain('e.assertion_id = a.id');
    expect(migration).toContain('e.event_id = a.origin_event_id');
    expect(migration).toContain('ORDER BY e.created_at ASC, e.id ASC');
    expect(migration).toContain('proof.id AS evidence_id');
    expect(migration).toContain('proof.content_hash::text AS evidence_content_hash');
  });

  test('does not duplicate evidence excerpts into the graph surface', () => {
    expect(migration).not.toMatch(/proof\.excerpt|e\.excerpt|AS\s+excerpt/i);
    expect(migration).toContain('evidence_start_offset');
    expect(migration).toContain('evidence_end_offset');
  });

  test('raw view reads are revoked because the owner view is RLS-exempt', () => {
    expect(migration).toContain('REVOKE ALL ON TABLE kg_temporal_assertion_edges FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON TABLE kg_temporal_assertion_edges FROM capiro_app');
  });

  test('bounded traversal requires exact tenant and security partition on every hop', () => {
    expect(migration).toContain('kg_temporal_walk_bounded');
    expect(migration).toContain('p_tenant_id         uuid');
    expect(migration).toContain('p_sensitivity       text');
    expect(migration).toContain('p_access_scope      jsonb');
    expect(migration).toContain('p_client_ref_keys   text[]');
    expect(migration).toContain('e.tenant_id = p_tenant_id');
    expect(migration).toContain('e.sensitivity = p_sensitivity');
    expect(migration).toContain('e.access_scope = p_access_scope');
    expect(migration).toContain('e.client_ref_keys = v_client_ref_keys');
  });

  test('historical walks enforce both valid-time and transaction-time cutoffs', () => {
    expect(migration).toContain('e.valid_from <= p_as_of');
    expect(migration).toContain('(e.valid_until IS NULL OR p_as_of < e.valid_until)');
    expect(migration).toContain('e.observed_at <= p_as_of');
    expect(migration).toContain('e.observed_at <= p_observed_through');
    expect(migration).toContain('e.valid_from < p_window_end');
    expect(migration).toContain('(e.valid_until IS NULL OR e.valid_until > p_window_start)');
  });

  test('anti-starvation guards remain bounded', () => {
    expect(migration).toContain("SET statement_timeout = '3s'");
    expect(migration).toContain('LEAST(GREATEST(COALESCE(p_max_depth, 2), 1), 5)');
    expect(migration).toContain('LEAST(GREATEST(COALESCE(p_fanout, 25), 1), 100)');
    expect(migration).toContain('LEAST(GREATEST(COALESCE(p_row_budget, 500), 1), 5000)');
    expect(migration).toContain('nb.next_id <> ALL(w.visited)');
    expect(migration).toContain('LIMIT v_fanout');
    expect(migration).toContain('LIMIT v_budget');
  });

  test('there is no feature flag, tenant allowlist, or historical backfill', () => {
    expect(migration).not.toMatch(/FEATURE_FLAG|ALLOWLIST|ENABLED=/i);
    expect(migration).toContain('no migration-time data');
    expect(migration).not.toMatch(/INSERT\s+INTO\s+knowledge_/i);
  });
});
