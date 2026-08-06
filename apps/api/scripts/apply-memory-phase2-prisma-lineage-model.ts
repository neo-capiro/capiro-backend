import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMemoryPhase2PrismaLineageModel,
  assertMemoryPhase2PersistenceContract,
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

const before = readFileSync(schemaPath, 'utf8');
const after = applyMemoryPhase2PrismaLineageModel(before);
if (after !== before) writeFileSync(schemaPath, after, 'utf8');

assertMemoryPhase2PersistenceContract({
  prismaSchema: after,
  workflowMigration: readFileSync(workflowMigrationPath, 'utf8'),
  revisionMigration: readFileSync(revisionMigrationPath, 'utf8'),
  revisionService: readFileSync(revisionServicePath, 'utf8'),
});

process.stdout.write(
  after === before
    ? 'MEMORY_PHASE2_PRISMA_LINEAGE_ALREADY_MODELED\n'
    : 'MEMORY_PHASE2_PRISMA_LINEAGE_MODEL_APPLIED\n',
);
