import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import {
  applyMemoryPhase2MigrationOwnershipContract,
  applyMemoryPhase2PrismaLineageModel,
  assertMemoryPhase2PersistenceContract,
  MemoryPhase2PersistenceContractError,
  type MemoryPhase2PersistenceSources,
} from './memory-phase2-persistence-contract.js';

const apiRoot = new URL('../../', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, apiRoot), 'utf8');
}

const committed: MemoryPhase2PersistenceSources = {
  prismaSchema: read('prisma/schema.prisma'),
  workflowMigration: read(
    'prisma/migrations/20260818010000_memory_phase2_review_workflow_foundation/migration.sql',
  ),
  revisionMigration: read(
    'prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql',
  ),
  revisionService: read('src/memory/memory-review-revision.service.ts'),
};

const target: MemoryPhase2PersistenceSources = {
  ...committed,
  prismaSchema: applyMemoryPhase2PrismaLineageModel(committed.prismaSchema),
  revisionMigration: applyMemoryPhase2MigrationOwnershipContract(
    committed.revisionMigration,
  ),
};

function expectFailure(workflowMigration: string): void {
  expect(() =>
    assertMemoryPhase2PersistenceContract({ ...target, workflowMigration }),
  ).toThrow(MemoryPhase2PersistenceContractError);
}

describe('memory Phase 2 body-free workflow metadata contract', () => {
  it('accepts normalized title, candidate kind, and reconciliation helpers', () => {
    expect(() => assertMemoryPhase2PersistenceContract(target)).not.toThrow();
    expect(target.workflowMigration).toContain(
      "p_payload #>> '{canonicalItem,title}'",
    );
    expect(target.workflowMigration).toContain("p_payload ->> 'key'");
    expect(target.workflowMigration).toContain(
      'memory_review_workflow_metadata(NEW.source_kind, NEW.scope, false)',
    );
  });

  it('fails if workflow title can derive from the proposed memory body', () => {
    expectFailure(
      target.workflowMigration.replace(
        "p_payload ->> 'key'",
        "p_payload ->> 'value'",
      ),
    );
  });

  it('fails if body content is added to review_request metadata', () => {
    expectFailure(
      target.workflowMigration.replace(
        "'assignmentEnforced', p_assignment_enforced",
        "'assignmentEnforced', p_assignment_enforced,\n    'value', p_payload ->> 'value'",
      ),
    );
  });

  it('fails if immutable candidate kinds collapse to a generic label', () => {
    expectFailure(
      target.workflowMigration.replace(
        "WHEN 'memory_correction' THEN 'correction'",
        "WHEN 'memory_correction' THEN 'standard'",
      ),
    );
  });

  it('fails if partial-application reconciliation is removed', () => {
    const start = target.workflowMigration.indexOf('UPDATE review_request rr');
    const end = target.workflowMigration.indexOf(
      '-- Create the workflow obligation',
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expectFailure(
      `${target.workflowMigration.slice(0, start)}${target.workflowMigration.slice(end)}`,
    );
  });
});
