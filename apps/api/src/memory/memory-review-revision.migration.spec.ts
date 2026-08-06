import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('memory Phase 2 revision migration contract', () => {
  it('serializes predecessor and workflow state before creating a successor', () => {
    expect(migration).toContain('FROM memory_candidate');
    expect(migration).toContain('FOR UPDATE;');
    expect(migration).toContain("workflow.status <> 'changes_needed'");
    expect(migration).toContain('memory_candidate_one_successor_per_predecessor');
    expect(migration).toContain('memory_candidate_root_revision_unique');
  });

  it('refreshes revision-owned source identity instead of cloning stale hashes', () => {
    expect(migration).toContain('p_source_content_hash text');
    expect(migration).toContain("'source_content_hash', p_source_content_hash");
    expect(migration).toContain("'source_version', 'candidate:' || p_successor_id::text");
    expect(migration).toContain("'origin_trace_id', p_successor_id::text");
    expect(migration).toContain('MEMORY_REVISION_CONTENT_HASH_REQUIRED');
  });

  it('preserves the reviewer decision attribution when the proposer supersedes it', () => {
    const reviewUpdate = migration.match(
      /UPDATE review_request[\s\S]*?WHERE id = workflow\.id;/,
    )?.[0];
    expect(reviewUpdate).toBeDefined();
    expect(reviewUpdate).toContain("status = 'superseded'");
    expect(reviewUpdate).toContain("'supersededByUserId', p_proposer_id::text");
    expect(reviewUpdate).not.toMatch(/\bdecided_by\s*=/);
    expect(reviewUpdate).not.toMatch(/\bdecided_at\s*=/);
  });

  it('never mutates active memory while revising a candidate', () => {
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+memory_items\b/i);
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+clio_memory\b/i);
  });
});
