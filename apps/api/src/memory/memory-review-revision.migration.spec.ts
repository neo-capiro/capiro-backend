import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

const targetMigration = migration.replace(
  `-- SQL-OWNED LINEAGE CONTRACT
-- The four additive lineage columns remain intentionally absent from Prisma's
-- MemoryCandidate model during Phase 2. The application reads/writes them only
-- through locked raw SQL and create_memory_candidate_revision. This prevents a
-- generated Prisma delegate from offering unsafe partial lineage mutations while
-- Prisma safely ignores additive database columns during validate/generate.`,
  `-- PRISMA-MODELED, SQL-ENFORCED LINEAGE CONTRACT
-- Prisma models the four additive columns and self-relations so future schema
-- reconciliation cannot classify them as unmanaged drift. The application
-- creates and mutates lineage only through locked raw SQL and
-- create_memory_candidate_revision; generated delegates are not a valid
-- lifecycle mutation path.`,
);

describe('memory Phase 2 revision migration contract', () => {
  it('serializes predecessor and workflow state before creating a successor', () => {
    expect(migration).toContain('FROM memory_candidate');
    expect(migration).toContain('FOR UPDATE;');
    expect(migration).toContain("workflow.status <> 'changes_needed'");
    expect(migration).toContain('memory_candidate_one_successor_per_predecessor');
    expect(migration).toContain('memory_candidate_root_revision_unique');
  });

  it('targets Prisma-modeled but SQL-enforced tenant-bound lineage', () => {
    expect(targetMigration).toContain('PRISMA-MODELED, SQL-ENFORCED LINEAGE CONTRACT');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS revision_root_id uuid');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS predecessor_candidate_id uuid');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS revision_number integer');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS superseded_by_id uuid');
    expect(migration).toContain('memory_candidate_tenant_id_id_unique');
    expect(migration).toContain('FOREIGN KEY (tenant_id, revision_root_id)');
    expect(migration).toContain('FOREIGN KEY (tenant_id, predecessor_candidate_id)');
    expect(migration).toContain('FOREIGN KEY (tenant_id, superseded_by_id)');
    expect(migration).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(migration).toMatch(/SET\s+search_path\s*=\s*public,\s*pg_temp/i);
  });

  it('binds the function to withTenantUser transaction context', () => {
    expect(migration).toContain("current_setting('app.current_tenant', true)");
    expect(migration).toContain("current_setting('app.current_user', true)");
    expect(migration).toContain("current_setting('app.bypass_rls', true)");
    expect(migration).toContain('MEMORY_REVISION_TENANT_CONTEXT_REQUIRED');
    expect(migration).toContain('MEMORY_REVISION_ACTOR_CONTEXT_REQUIRED');
    expect(migration).toContain('MEMORY_REVISION_SYSTEM_BYPASS_DENIED');
    expect(migration).toContain('tenant_context::uuid <> p_tenant_id');
    expect(migration).toContain('actor_context::uuid <> p_proposer_id');
  });

  it('refreshes revision-owned source identity instead of cloning stale hashes', () => {
    expect(migration).toContain('p_source_content_hash text');
    expect(migration).toContain("'source_content_hash', p_source_content_hash");
    expect(migration).toContain("'source_version', 'candidate:' || p_successor_id::text");
    expect(migration).toContain("'origin_trace_id', p_successor_id::text");
    expect(migration).toContain('MEMORY_REVISION_CONTENT_HASH_REQUIRED');
  });

  it('preserves reviewer attribution when the proposer supersedes it', () => {
    const reviewUpdate = migration.match(/UPDATE review_request[\s\S]*?WHERE id = workflow\.id;/)?.[0];
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
