import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

const apiRoot = new URL('../../', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, apiRoot), 'utf8');
}

function revisionFunction(migration: string): string {
  const start = migration.indexOf(
    'CREATE OR REPLACE FUNCTION create_memory_candidate_revision(',
  );
  const end = migration.indexOf('$$;', start);
  if (start < 0 || end < 0) throw new Error('Revision function was not found.');
  return migration.slice(start, end + 3);
}

describe('memory Phase 2 deterministic revision conflict contract', () => {
  const migration = read(
    'prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql',
  );
  const service = read('src/memory/memory-review-revision.service.ts');
  const fn = revisionFunction(migration);

  it('checks for the durable successor after locking and before terminal status', () => {
    const lock = fn.indexOf('FOR UPDATE;');
    const successorConflict = fn.indexOf('MEMORY_REVISION_SUCCESSOR_EXISTS');
    const terminalStatusGuard = fn.indexOf("IF predecessor.status <> 'pending'");

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(successorConflict).toBeGreaterThan(lock);
    expect(terminalStatusGuard).toBeGreaterThan(successorConflict);
  });

  it('retains the database uniqueness boundary and API conflict translation', () => {
    expect(migration).toContain(
      'memory_candidate_one_successor_per_predecessor',
    );
    expect(service).toContain("message.includes('MEMORY_REVISION_SUCCESSOR_EXISTS')");
    expect(service).toContain(
      "throw new ConflictException('A revised successor already exists for this proposal.')",
    );
  });
});
