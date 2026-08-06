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

function expectContractFailure(mutated: MemoryPhase2PersistenceSources): void {
  expect(() => assertMemoryPhase2PersistenceContract(mutated)).toThrow(
    MemoryPhase2PersistenceContractError,
  );
}

describe('memory Phase 2 persistence ownership contract', () => {
  it('accepts the Prisma-modeled, SQL-enforced tenant-bound target contract', () => {
    expect(() => assertMemoryPhase2PersistenceContract(target)).not.toThrow();
  });

  it('reports whether the committed schema still requires the guarded transformer', () => {
    const alreadyModeled = committed.prismaSchema.includes('revisionRootId');
    if (alreadyModeled) {
      expect(() => assertMemoryPhase2PersistenceContract(committed)).not.toThrow();
    } else {
      expectContractFailure(committed);
      expect(target.prismaSchema).not.toBe(committed.prismaSchema);
    }
  });

  it('is idempotent and rejects a partially applied Prisma model', () => {
    expect(applyMemoryPhase2PrismaLineageModel(target.prismaSchema)).toBe(target.prismaSchema);
    expect(() =>
      applyMemoryPhase2PrismaLineageModel(
        committed.prismaSchema.replace(
          'payload           Json',
          'revisionRootId String? @map("revision_root_id") @db.Uuid\n  payload           Json',
        ),
      ),
    ).toThrow(MemoryPhase2PersistenceContractError);
  });

  it('reconciles the legacy ownership comment, is idempotent, and rejects drift', () => {
    const legacy = target.revisionMigration.replace(
      `-- PRISMA-MODELED, SQL-ENFORCED LINEAGE CONTRACT
-- Prisma models the four additive columns and tenant-bound self-relations so
-- future schema reconciliation cannot classify them as unmanaged drift. The
-- application creates and mutates lineage only through locked raw SQL and
-- create_memory_candidate_revision; generated delegates are not a valid
-- lifecycle mutation path.`,
      `-- SQL-OWNED LINEAGE CONTRACT
-- The four additive lineage columns remain intentionally absent from Prisma's
-- MemoryCandidate model during Phase 2. The application reads/writes them only
-- through locked raw SQL and create_memory_candidate_revision. This prevents a
-- generated Prisma delegate from offering unsafe partial lineage mutations while
-- Prisma safely ignores additive database columns during validate/generate.`,
    );
    expect(applyMemoryPhase2MigrationOwnershipContract(legacy)).toBe(
      target.revisionMigration,
    );
    expect(applyMemoryPhase2MigrationOwnershipContract(target.revisionMigration)).toBe(
      target.revisionMigration,
    );
    expect(() =>
      applyMemoryPhase2MigrationOwnershipContract(
        target.revisionMigration.replace(
          'tenant-bound self-relations',
          'partially drifted relations',
        ),
      ),
    ).toThrow(MemoryPhase2PersistenceContractError);
  });

  it('fails if a modeled lineage field, tenant key, or self-relation is removed', () => {
    expectContractFailure({
      ...target,
      prismaSchema: target.prismaSchema.replace(
        'revisionNumber         Int     @default(1) @map("revision_number")',
        '',
      ),
    });
    expectContractFailure({
      ...target,
      prismaSchema: target.prismaSchema.replace(
        '@@unique([tenantId, id], map: "memory_candidate_tenant_id_id_unique")',
        '',
      ),
    });
    expectContractFailure({
      ...target,
      prismaSchema: target.prismaSchema.replace(
        'fields: [tenantId, predecessorCandidateId], references: [tenantId, id]',
        'fields: [predecessorCandidateId], references: [id]',
      ),
    });
  });

  it('fails if Prisma relation names or referential actions drift from PostgreSQL', () => {
    for (const [current, drifted] of [
      [
        'onDelete: Restrict, onUpdate: NoAction, map: "memory_candidate_revision_root_fk"',
        'onDelete: Restrict',
      ],
      [
        'map: "memory_candidate_predecessor_fk"',
        'map: "memory_candidate_predecessor_drift_fk"',
      ],
      [
        'onDelete: Restrict, onUpdate: NoAction, map: "memory_candidate_superseded_by_fk"',
        'onDelete: SetNull, onUpdate: Cascade, map: "memory_candidate_superseded_by_fk"',
      ],
    ] as const) {
      expectContractFailure({
        ...target,
        prismaSchema: target.prismaSchema.replace(current, drifted),
      });
    }
  });

  it('fails if any migration lineage FK loses tenant binding, name, or actions', () => {
    for (const [current, unsafe] of [
      [
        'FOREIGN KEY (tenant_id, revision_root_id)\n    REFERENCES memory_candidate(tenant_id, id)',
        'FOREIGN KEY (revision_root_id)\n    REFERENCES memory_candidate(id)',
      ],
      [
        'ADD CONSTRAINT memory_candidate_predecessor_fk',
        'ADD CONSTRAINT memory_candidate_predecessor_drift_fk',
      ],
      [
        'REFERENCES memory_candidate(tenant_id, id)\n    ON UPDATE NO ACTION\n    ON DELETE RESTRICT',
        'REFERENCES memory_candidate(tenant_id, id)\n    ON UPDATE CASCADE\n    ON DELETE SET NULL',
      ],
      [
        'FOREIGN KEY (tenant_id, superseded_by_id)\n    REFERENCES memory_candidate(tenant_id, id)',
        'FOREIGN KEY (superseded_by_id)\n    REFERENCES memory_candidate(id)',
      ],
    ] as const) {
      expectContractFailure({
        ...target,
        revisionMigration: target.revisionMigration.replace(current, unsafe),
      });
    }
  });

  it('fails if production code attempts a Prisma delegate lineage mutation', () => {
    expectContractFailure({
      ...target,
      revisionService: `${target.revisionService}\nvoid prisma.memoryCandidate.update({ data: { revisionNumber: 9 } });`,
    });
  });

  it('fails if the SQL function becomes SECURITY DEFINER', () => {
    expectContractFailure({
      ...target,
      revisionMigration: `${target.revisionMigration}\nSECURITY DEFINER;`,
    });
  });

  it('fails when tenant, actor, or system-bypass guards are removed', () => {
    for (const guard of [
      "current_setting('app.current_tenant', true)",
      "current_setting('app.current_user', true)",
      "current_setting('app.bypass_rls', true)",
    ]) {
      expectContractFailure({
        ...target,
        revisionMigration: target.revisionMigration.replace(guard, 'removed_guard'),
      });
    }
  });

  it('fails when either concurrency uniqueness boundary is removed', () => {
    for (const indexName of [
      'memory_candidate_one_successor_per_predecessor',
      'memory_candidate_root_revision_unique',
    ]) {
      expectContractFailure({
        ...target,
        revisionMigration: target.revisionMigration.replace(indexName, 'removed_index'),
      });
    }
  });
});
