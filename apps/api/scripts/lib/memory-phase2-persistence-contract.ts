export interface PrismaModeledLineageColumn {
  prismaField: string;
  databaseColumn: string;
  prismaType: string;
  migrationSqlType: string;
}

export const MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS = [
  { prismaField: 'revisionRootId', databaseColumn: 'revision_root_id', prismaType: 'String?', migrationSqlType: 'uuid' },
  { prismaField: 'predecessorCandidateId', databaseColumn: 'predecessor_candidate_id', prismaType: 'String?', migrationSqlType: 'uuid' },
  { prismaField: 'revisionNumber', databaseColumn: 'revision_number', prismaType: 'Int', migrationSqlType: 'integer' },
  { prismaField: 'supersededById', databaseColumn: 'superseded_by_id', prismaType: 'String?', migrationSqlType: 'uuid' },
] as const satisfies readonly PrismaModeledLineageColumn[];

const TENANT_BOUND_LINEAGE_REFERENCES = [
  {
    prismaField: 'revisionRootId',
    databaseColumn: 'revision_root_id',
    relation: 'MemoryCandidateRevisionRoot',
    constraint: 'memory_candidate_revision_root_fk',
  },
  {
    prismaField: 'predecessorCandidateId',
    databaseColumn: 'predecessor_candidate_id',
    relation: 'MemoryCandidatePredecessor',
    constraint: 'memory_candidate_predecessor_fk',
  },
  {
    prismaField: 'supersededById',
    databaseColumn: 'superseded_by_id',
    relation: 'MemoryCandidateSupersession',
    constraint: 'memory_candidate_superseded_by_fk',
  },
] as const;

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
const FIELD_REPLACEMENT = `${FIELD_ANCHOR}
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
const RELATION_REPLACEMENT = `${RELATION_ANCHOR}
  revisionRoot MemoryCandidate?  @relation("MemoryCandidateRevisionRoot", fields: [tenantId, revisionRootId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction, map: "memory_candidate_revision_root_fk")
  revisions    MemoryCandidate[] @relation("MemoryCandidateRevisionRoot")
  predecessor  MemoryCandidate?  @relation("MemoryCandidatePredecessor", fields: [tenantId, predecessorCandidateId], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction, map: "memory_candidate_predecessor_fk")
  successors   MemoryCandidate[] @relation("MemoryCandidatePredecessor")
  supersededBy MemoryCandidate?  @relation("MemoryCandidateSupersession", fields: [tenantId, supersededById], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction, map: "memory_candidate_superseded_by_fk")
  supersedes   MemoryCandidate[] @relation("MemoryCandidateSupersession")
`;

const INDEX_ANCHOR = `  @@index([tenantId, status], map: "memory_candidate_tenant_status_idx")
`;
const INDEX_REPLACEMENT = `  @@unique([tenantId, id], map: "memory_candidate_tenant_id_id_unique")
${INDEX_ANCHOR}`;

export function assertMemoryPhase2PersistenceContract(sources: MemoryPhase2PersistenceSources): void {
  const model = extractPrismaModel(sources.prismaSchema, 'MemoryCandidate');
  for (const column of MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS) {
    required(
      new RegExp(`\\b${escapeRegex(column.prismaField)}\\s+${escapeRegex(column.prismaType)}[\\s\\S]{0,100}@map\\("${escapeRegex(column.databaseColumn)}"\\)`).test(model),
      `Prisma MemoryCandidate must model ${column.prismaField} -> ${column.databaseColumn}.`,
    );
    required(
      new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${escapeRegex(column.databaseColumn)}\\s+${escapeRegex(column.migrationSqlType)}`, 'i').test(sources.revisionMigration),
      `Revision migration must own ${column.databaseColumn}.`,
    );
  }
  required(model.includes('@@unique([tenantId, id], map: "memory_candidate_tenant_id_id_unique")'), 'Prisma MemoryCandidate must model the tenant/id composite key.');
  required(
    /CREATE UNIQUE INDEX IF NOT EXISTS\s+memory_candidate_tenant_id_id_unique\s+ON memory_candidate\s*\(\s*tenant_id\s*,\s*id\s*\)/i.test(sources.revisionMigration),
    'Migration must retain the tenant/id composite key.',
  );
  for (const reference of TENANT_BOUND_LINEAGE_REFERENCES) {
    const prismaRelation = `@relation("${reference.relation}", fields: [tenantId, ${reference.prismaField}], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction, map: "${reference.constraint}")`;
    required(model.includes(prismaRelation), `Prisma MemoryCandidate is missing exact relation ${prismaRelation}.`);
    required(
      new RegExp(
        `ADD CONSTRAINT\\s+${escapeRegex(reference.constraint)}[\\s\\S]{0,160}FOREIGN KEY\\s*\\(\\s*tenant_id\\s*,\\s*${escapeRegex(reference.databaseColumn)}\\s*\\)\\s*REFERENCES\\s+memory_candidate\\s*\\(\\s*tenant_id\\s*,\\s*id\\s*\\)[\\s\\S]{0,80}ON UPDATE NO ACTION[\\s\\S]{0,80}ON DELETE RESTRICT`,
        'i',
      ).test(sources.revisionMigration),
      `Migration must match Prisma relation ${reference.relation}, including constraint name and referential actions.`,
    );
    required(
      !new RegExp(
        `FOREIGN KEY\\s*\\(\\s*${escapeRegex(reference.databaseColumn)}\\s*\\)\\s*REFERENCES\\s+memory_candidate`,
        'i',
      ).test(sources.revisionMigration),
      `Migration must not use a UUID-only FK for ${reference.databaseColumn}.`,
    );
  }
  required(sources.revisionMigration.includes('PRISMA-MODELED, SQL-ENFORCED LINEAGE CONTRACT'), 'Revision migration must document the ownership boundary.');
  required(sources.revisionMigration.includes('create_memory_candidate_revision'), 'Atomic revision function is required.');
  required(!/SECURITY\s+DEFINER/i.test(sources.revisionMigration), 'Revision function must remain SECURITY INVOKER.');
  required(/SET\s+search_path\s*=\s*public,\s*pg_temp/i.test(sources.revisionMigration), 'Revision function must pin search_path.');

  const contextCodes = [
    'MEMORY_REVISION_TENANT_CONTEXT_REQUIRED',
    'MEMORY_REVISION_ACTOR_CONTEXT_REQUIRED',
    'MEMORY_REVISION_SYSTEM_BYPASS_DENIED',
  ];
  for (const guard of [
    "current_setting('app.current_tenant', true)",
    "current_setting('app.current_user', true)",
    "current_setting('app.bypass_rls', true)",
    ...contextCodes,
  ]) required(sources.revisionMigration.includes(guard), `Missing database guard ${guard}.`);
  for (const code of contextCodes) required(sources.revisionService.includes(code), `Service must translate ${code}.`);

  required(/FROM\s+create_memory_candidate_revision\s*\(/i.test(sources.revisionService), 'Service must call atomic SQL function.');
  for (const column of MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS) {
    required(
      !new RegExp(`memoryCandidate\\.(?:create|update|upsert|createMany|updateMany)[\\s\\S]{0,500}\\b${escapeRegex(column.prismaField)}\\b`).test(sources.revisionService),
      `Service must not mutate ${column.prismaField} through Prisma.`,
    );
  }
  for (const invariant of [
    'review_request_memory_candidate_unique',
    'memory_candidate_enforce_review_assignment',
    'memory_candidate_one_successor_per_predecessor',
    'memory_candidate_root_revision_unique',
  ]) required(`${sources.workflowMigration}\n${sources.revisionMigration}`.includes(invariant), `Missing invariant ${invariant}.`);
}

export function applyMemoryPhase2PrismaLineageModel(schema: string): string {
  const model = extractPrismaModel(schema, 'MemoryCandidate');
  const present = MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS.filter((column) => new RegExp(`\\b${escapeRegex(column.prismaField)}\\b`).test(model));
  if (present.length === MEMORY_PHASE2_PRISMA_MODELED_LINEAGE_COLUMNS.length) {
    assertTransformedModel(model);
    return schema;
  }
  if (present.length > 0) throw new MemoryPhase2PersistenceContractError('MemoryCandidate contains a partially applied Phase 2 lineage model.');
  for (const [anchor, label] of [[FIELD_ANCHOR, 'field'], [RELATION_ANCHOR, 'relation'], [INDEX_ANCHOR, 'index']] as const) {
    if (count(schema, anchor) !== 1) throw new MemoryPhase2PersistenceContractError(`Expected one MemoryCandidate ${label} anchor; found ${count(schema, anchor)}.`);
  }
  const transformed = schema.replace(FIELD_ANCHOR, FIELD_REPLACEMENT).replace(RELATION_ANCHOR, RELATION_REPLACEMENT).replace(INDEX_ANCHOR, INDEX_REPLACEMENT);
  assertTransformedModel(extractPrismaModel(transformed, 'MemoryCandidate'));
  return transformed;
}

export function extractPrismaModel(schema: string, modelName: string): string {
  const start = schema.indexOf(`model ${modelName} {`);
  if (start < 0) throw new MemoryPhase2PersistenceContractError(`Prisma model ${modelName} was not found.`);
  let depth = 0;
  for (let index = start; index < schema.length; index += 1) {
    if (schema[index] === '{') depth += 1;
    if (schema[index] === '}' && --depth === 0) return schema.slice(start, index + 1);
  }
  throw new MemoryPhase2PersistenceContractError(`Prisma model ${modelName} is unterminated.`);
}

function assertTransformedModel(model: string): void {
  required(model.includes('@@unique([tenantId, id], map: "memory_candidate_tenant_id_id_unique")'), 'Transformed MemoryCandidate is missing the tenant/id composite key.');
  for (const reference of TENANT_BOUND_LINEAGE_REFERENCES) {
    const expected = `@relation("${reference.relation}", fields: [tenantId, ${reference.prismaField}], references: [tenantId, id], onDelete: Restrict, onUpdate: NoAction, map: "${reference.constraint}")`;
    required(model.includes(expected), `Transformed MemoryCandidate relation ${reference.relation} does not exactly match the migration.`);
  }
}

function count(value: string, search: string): number { return value.split(search).length - 1; }
function required(condition: boolean, message: string): asserts condition { if (!condition) throw new MemoryPhase2PersistenceContractError(message); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
