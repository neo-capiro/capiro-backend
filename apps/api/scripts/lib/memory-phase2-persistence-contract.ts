export interface SqlOwnedLineageColumn {
  prismaField: string;
  databaseColumn: string;
  sqlType: string;
}

export const MEMORY_PHASE2_SQL_OWNED_LINEAGE_COLUMNS = [
  {
    prismaField: 'revisionRootId',
    databaseColumn: 'revision_root_id',
    sqlType: 'uuid',
  },
  {
    prismaField: 'predecessorCandidateId',
    databaseColumn: 'predecessor_candidate_id',
    sqlType: 'uuid',
  },
  {
    prismaField: 'revisionNumber',
    databaseColumn: 'revision_number',
    sqlType: 'integer',
  },
  {
    prismaField: 'supersededById',
    databaseColumn: 'superseded_by_id',
    sqlType: 'uuid',
  },
] as const satisfies readonly SqlOwnedLineageColumn[];

export interface MemoryPhase2PersistenceSources {
  prismaSchema: string;
  workflowMigration: string;
  revisionMigration: string;
  revisionService: string;
}

export class MemoryPhase2PersistenceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryPhase2PersistenceContractError';
  }
}

/**
 * The Phase 2 lineage columns are deliberately SQL-owned for this release.
 *
 * The revision service accesses them only through locked raw SQL and the
 * create_memory_candidate_revision function. Leaving them out of Prisma's DMMF
 * prevents generated delegates from offering unsafe partial updates to immutable
 * lineage while Prisma remains free to ignore additive database columns.
 */
export function assertMemoryPhase2PersistenceContract(
  sources: MemoryPhase2PersistenceSources,
): void {
  const candidateModel = extractPrismaModel(sources.prismaSchema, 'MemoryCandidate');

  for (const column of MEMORY_PHASE2_SQL_OWNED_LINEAGE_COLUMNS) {
    assert(
      !new RegExp(`\\b${escapeRegex(column.prismaField)}\\b`).test(candidateModel),
      `Prisma field ${column.prismaField} must remain absent while lineage is SQL-owned.`,
    );
    assert(
      new RegExp(
        `ADD COLUMN IF NOT EXISTS\\s+${escapeRegex(column.databaseColumn)}\\s+${escapeRegex(column.sqlType)}`,
        'i',
      ).test(sources.revisionMigration),
      `Revision migration must own ${column.databaseColumn} as ${column.sqlType}.`,
    );
  }

  assert(
    sources.revisionMigration.includes('SQL-OWNED LINEAGE CONTRACT'),
    'Revision migration must document the SQL-owned lineage boundary.',
  );
  assert(
    sources.revisionMigration.includes('create_memory_candidate_revision'),
    'Revision migration must provide the atomic revision function.',
  );
  assert(
    !/SECURITY\s+DEFINER/i.test(sources.revisionMigration),
    'Memory revision functions must remain SECURITY INVOKER.',
  );
  assert(
    /SET\s+search_path\s*=\s*public,\s*pg_temp/i.test(sources.revisionMigration),
    'Memory revision functions must pin a safe search_path.',
  );

  const contextCodes = [
    'MEMORY_REVISION_TENANT_CONTEXT_REQUIRED',
    'MEMORY_REVISION_ACTOR_CONTEXT_REQUIRED',
    'MEMORY_REVISION_SYSTEM_BYPASS_DENIED',
  ] as const;
  for (const guard of [
    "current_setting('app.current_tenant', true)",
    "current_setting('app.current_user', true)",
    "current_setting('app.bypass_rls', true)",
    ...contextCodes,
  ]) {
    assert(
      sources.revisionMigration.includes(guard),
      `Revision migration is missing database-boundary guard: ${guard}.`,
    );
  }
  for (const code of contextCodes) {
    assert(
      sources.revisionService.includes(code),
      `Revision service must translate database-boundary denial ${code}.`,
    );
  }

  assert(
    /FROM\s+create_memory_candidate_revision\s*\(/i.test(sources.revisionService),
    'Revision service must call the atomic SQL revision function.',
  );
  for (const column of MEMORY_PHASE2_SQL_OWNED_LINEAGE_COLUMNS) {
    assert(
      !new RegExp(`memoryCandidate\\.[\\s\\S]{0,120}\\b${escapeRegex(column.prismaField)}\\b`).test(
        sources.revisionService,
      ),
      `Revision service must not access SQL-owned ${column.prismaField} through a Prisma delegate.`,
    );
  }

  assert(
    sources.workflowMigration.includes('review_request_memory_candidate_unique'),
    'Workflow migration must retain one workflow row per candidate.',
  );
  assert(
    sources.workflowMigration.includes('memory_candidate_enforce_review_assignment'),
    'Workflow migration must retain assigned-reviewer decision enforcement.',
  );
  assert(
    sources.revisionMigration.includes('memory_candidate_one_successor_per_predecessor'),
    'Revision migration must retain one-successor uniqueness.',
  );
  assert(
    sources.revisionMigration.includes('memory_candidate_root_revision_unique'),
    'Revision migration must retain root/revision uniqueness.',
  );
}

export function extractPrismaModel(schema: string, modelName: string): string {
  const marker = `model ${modelName} {`;
  const start = schema.indexOf(marker);
  if (start < 0) {
    throw new MemoryPhase2PersistenceContractError(`Prisma model ${modelName} was not found.`);
  }

  let depth = 0;
  let opened = false;
  for (let index = start; index < schema.length; index += 1) {
    const char = schema[index];
    if (char === '{') {
      depth += 1;
      opened = true;
    } else if (char === '}') {
      depth -= 1;
      if (opened && depth === 0) return schema.slice(start, index + 1);
    }
  }

  throw new MemoryPhase2PersistenceContractError(`Prisma model ${modelName} is unterminated.`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new MemoryPhase2PersistenceContractError(message);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
