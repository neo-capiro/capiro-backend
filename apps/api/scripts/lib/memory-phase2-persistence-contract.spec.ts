import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import {
  assertMemoryPhase2PersistenceContract,
  MemoryPhase2PersistenceContractError,
  type MemoryPhase2PersistenceSources,
} from './memory-phase2-persistence-contract.js';

const apiRoot = new URL('../../', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, apiRoot), 'utf8');
}

const sources: MemoryPhase2PersistenceSources = {
  prismaSchema: read('prisma/schema.prisma'),
  workflowMigration: read(
    'prisma/migrations/20260818010000_memory_phase2_review_workflow_foundation/migration.sql',
  ),
  revisionMigration: read(
    'prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql',
  ),
  revisionService: read('src/memory/memory-review-revision.service.ts'),
};

function expectContractFailure(mutated: MemoryPhase2PersistenceSources): void {
  expect(() => assertMemoryPhase2PersistenceContract(mutated)).toThrow(
    MemoryPhase2PersistenceContractError,
  );
}

describe('memory Phase 2 persistence ownership contract', () => {
  it('accepts the committed SQL-owned lineage boundary', () => {
    expect(() => assertMemoryPhase2PersistenceContract(sources)).not.toThrow();
  });

  it('fails if a lineage field is exposed through the Prisma delegate', () => {
    expectContractFailure({
      ...sources,
      prismaSchema: sources.prismaSchema.replace(
        'payload           Json',
        'revisionRootId    String? @map("revision_root_id") @db.Uuid\n  payload           Json',
      ),
    });
  });

  it('fails if the SQL function becomes SECURITY DEFINER', () => {
    expectContractFailure({
      ...sources,
      revisionMigration: `${sources.revisionMigration}\nSECURITY DEFINER;`,
    });
  });

  it('fails when tenant, actor, or system-bypass guards are removed', () => {
    for (const guard of [
      "current_setting('app.current_tenant', true)",
      "current_setting('app.current_user', true)",
      "current_setting('app.bypass_rls', true)",
    ]) {
      expectContractFailure({
        ...sources,
        revisionMigration: sources.revisionMigration.replace(guard, 'removed_guard'),
      });
    }
  });

  it('fails when either concurrency uniqueness boundary is removed', () => {
    for (const indexName of [
      'memory_candidate_one_successor_per_predecessor',
      'memory_candidate_root_revision_unique',
    ]) {
      expectContractFailure({
        ...sources,
        revisionMigration: sources.revisionMigration.replace(indexName, 'removed_index'),
      });
    }
  });
});
