import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMemoryPhase2PrismaLineageModel,
  assertMemoryPhase2PersistenceContract,
  MemoryPhase2PersistenceContractError,
} from './lib/memory-phase2-persistence-contract.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const schemaPath = join(apiRoot, 'prisma/schema.prisma');
const workflowMigrationPath = join(
  apiRoot,
  'prisma/migrations/20260818010000_memory_phase2_review_workflow_foundation/migration.sql',
);
const revisionMigrationPath = join(
  apiRoot,
  'prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql',
);
const revisionServicePath = join(apiRoot, 'src/memory/memory-review-revision.service.ts');

const schemaBefore = readFileSync(schemaPath, 'utf8');
const schemaAfter = applyMemoryPhase2PrismaLineageModel(schemaBefore);

const migrationBefore = readFileSync(revisionMigrationPath, 'utf8');
const migrationAfter = applyOwnershipComment(migrationBefore);

if (schemaAfter !== schemaBefore) writeFileSync(schemaPath, schemaAfter, 'utf8');
if (migrationAfter !== migrationBefore) writeFileSync(revisionMigrationPath, migrationAfter, 'utf8');

assertMemoryPhase2PersistenceContract({
  prismaSchema: schemaAfter,
  workflowMigration: readFileSync(workflowMigrationPath, 'utf8'),
  revisionMigration: migrationAfter,
  revisionService: readFileSync(revisionServicePath, 'utf8'),
});

process.stdout.write(
  schemaAfter === schemaBefore && migrationAfter === migrationBefore
    ? 'MEMORY_PHASE2_PRISMA_LINEAGE_ALREADY_MODELED\n'
    : 'MEMORY_PHASE2_PRISMA_LINEAGE_MODEL_APPLIED\n',
);

function applyOwnershipComment(migration: string): string {
  const oldComment = `-- SQL-OWNED LINEAGE CONTRACT
-- The four additive lineage columns remain intentionally absent from Prisma's
-- MemoryCandidate model during Phase 2. The application reads/writes them only
-- through locked raw SQL and create_memory_candidate_revision. This prevents a
-- generated Prisma delegate from offering unsafe partial lineage mutations while
-- Prisma safely ignores additive database columns during validate/generate.`;
  const newComment = `-- PRISMA-MODELED, SQL-ENFORCED LINEAGE CONTRACT
-- Prisma models the four additive columns and self-relations so future schema
-- reconciliation cannot classify them as unmanaged drift. The application
-- creates and mutates lineage only through locked raw SQL and
-- create_memory_candidate_revision; generated delegates are not a valid
-- lifecycle mutation path.`;

  if (migration.includes(newComment)) return migration;
  const occurrences = migration.split(oldComment).length - 1;
  if (occurrences !== 1) {
    throw new MemoryPhase2PersistenceContractError(
      `Expected one revision ownership comment; found ${occurrences}.`,
    );
  }
  return migration.replace(oldComment, newComment);
}
