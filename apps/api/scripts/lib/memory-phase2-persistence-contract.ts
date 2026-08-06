export interface PrismaModeledLineageColumn {
  prismaField: string;
  databaseColumn: string;
  prismaType: string;
  migrationSqlType: string;
}

export const MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS = [
  {
    prismaField: 'revisionRootId',
    databaseColumn: 'revision_root_id',
    prismaType: 'String?',
    migrationSqlType: 'uuid',
  },
  {
    prismaField: 'predecessorCandidateId',
    databaseColumn: 'predecessor_candidate_id',
    prismaType: 'String?',
    migrationSqlType: 'uuid',
  },
  {
    prismaField: 'revisionNumber',
    databaseColumn: 'revision_number',
    prismaType: 'Int',
    migrationSqlType: 'integer',
  },
  {
    prismaField: 'supersededById',
    databaseColumn: 'superseded_by_id',
    prismaType: 'String?',
    migrationSqlType: 'uuid',
  },
] as const satisfies readonly PrismaModeledLineageColumn[];

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

const FIELD_ANCHOR = `  payload           Json      @map("payload_jsonb")
  provenance        Json      @map("provenance_jsonb")
`;

const FIELD_REPLACEMENT = `  payload           Json      @map("payload_jsonb")
  provenance        Json      @map("provenance_jsonb")

  /// Phase 2 immutable revision lineage. Prisma owns the database shape,
  /// while lifecycle mutations are restricted to the locked
  /// create_memory_candidate_revision SQL function.
  revisionRootId         String? @map("revision_root_id") @db.Uuid
  predecessorCandidateId String? @map("predecessor_candidate_id") @db.Uuid
  revisionNumber         Int     @default(1) @map("revision_number")
  supersededById         String? @map("superseded_by_id") @db.Uuid
`;

const RELATION_ANCHOR = `  tenant      Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  duplicateOf MemoryCandidate?  @relation("MemoryCandidateDuplicate", fields: [duplicateOfId], references: [id], onDelete: SetNull)
  duplicates  MemoryCandidate[] @relation("MemoryCandidateDuplicate")
`;

const RELATION_REPLACEMENT = `  tenant      Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  duplicateOf MemoryCandidate?  @relation("MemoryCandidateDuplicate", fields: [duplicateOfId], references: [id], onDelete: SetNull)
  duplicates  MemoryCandidate[] @relation("MemoryCandidateDuplicate")

  revisionRoot MemoryCandidate?  @relation("MemoryCandidateRevisionRoot", fields: [revisionRootId], references: [id], onDelete: Restrict)
  revisions    MemoryCandidate[] @relation("MemoryCandidateRevisionRoot")
  predecessor  MemoryCandidate?  @relation("MemoryCandidatePredecessor", fields: [predecessorCandidateId], references: [id], onDelete: Restrict)
  successors   MemoryCandidate[] @relation("MemoryCandidatePredecessor")
  supersededBy MemoryCandidate?  @relation("MemoryCandidateSupersession", fields: [supersededById], references: [id], onDelete: SetNull)
  supersedes   MemoryCandidate[] @relation("MemoryCandidateSupersession")
`;

/**
 * Phase 2 lineage is Prisma-modeled but SQL-enforced.
 *
 * Prisma must own the four additive columns and their self-relations so future
 * schema reconciliation cannot classify them as unmanaged drift. The runtime
 * service must still create and mutate lineage only through the row-locked
 * create_memory_candidate_revision function; generated delegates are not a
 * valid lifecycle mutation path.
 */
export function assertMemoryPhase2PersistenceContract(
  sources: MemoryPhase2PersistenceSources,
): void {
  const candidateModel = extractPrismaModel(sources.prismaSchema, 'MemoryCandidate');

  for (const column of MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS) {
    assert(
      new RegExp(
        `\\b${escapeRegex(column.prismaField)}\\s+${escapeRegex(column.prismaType)}[\\s\\S]{0,100}@map\\("${escapeRegex(column.databaseColumn)}"\\)`,
      ).test(candidateModel),
      `Prisma MemoryCandidate must model ${column.prismaField} -> ${column.databaseColumn}.`,
    );
    assert(
      new RegExp(
        `ADD COLUMN IF NOT EXISTS\\s+${escapeRegex(column.databaseColumn)}\\s+${escapeRegex(column.migrationSqlType)}`,
        'i',
      ).test(sources.revisionMigration),
      `Revision migration must own ${column.databaseColumn} as ${column.migrationSqlType}.`,
    );
  }

  for (const relationName of [
    'MemoryCandidateRevisionRoot',
    'MemoryCandidatePredecessor',
    'MemoryCandidateSupersession',
  ]) {
    assert(
      candidateModel.includes(`@relation("${relationName}"`),
      `Prisma MemoryCandidate is missing ${relationName}.`,
    );
  }

  assert(
    sources.revisionMigration.includes('PRISMA-MODELED, SQL-ENFORCED LINEAGE CONTRACT'),
    'Revision migration must document the Prisma-modeled, SQL-enforced boundary.',
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
  for (const column of MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS) {
    assert(
      !new RegExp(
        `memoryCandidate\\.(?:create|update|upsert|createMany|updateMany)[\\s\\S]{0,500}\\b${escapeRegex(column.prismaField)}\\b`,
      ).test(sources.revisionService),
      `Revision service must not mutate ${column.prismaField} through a Prisma delegate.`,
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

/**
 * Guarded one-time transformation used only to reconcile the checked-in Prisma
 * model with the already additive migration. It refuses ambiguous or partially
 * applied input rather than guessing.
 */
export function applyMemoryPhase2PrismaLineageModel(schema: string): string {
  const model = extractPrismaModel(schema, 'MemoryCandidate');
  const presentFields = MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS.filter((column) =>
    new RegExp(`\\b${escapeRegex(column.prismaField)}\\b`).test(model),
  );
  if (presentFields.length === MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS.length) {
    return schema;
  }
  if (presentFields.length > 0) {
    throw new MemoryPhase2PersistenceContractError(
      'MemoryCandidate contains a partially applied Phase 2 lineage model.',
    );
  }
  if (count(schema, FIELD_ANCHOR) !== 1) {
    throw new MemoryPhase2PersistenceContractError(
      `Expected one MemoryCandidate field anchor; found ${count(schema, FIELD_ANCHOR)}.`,
    );
  }
  if (count(schema, RELATION_ANCHOR) !== 1) {
    throw new MemoryPhase2PersistenceContractError(
      `Expected one MemoryCandidate relation anchor; found ${count(schema, RELATION_ANCHOR)}.`,
    );
  }
  return schema
    .replace(FIELD_ANCHOR, FIELD_REPLACEMENT)
    .replace(RELATION_ANCHOR, RELATION_REPLACEMENT);
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

function count(value: string, search: string): number {
  return value.split(search).length - 1;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new MemoryPhase2PersistenceContractError(message);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
