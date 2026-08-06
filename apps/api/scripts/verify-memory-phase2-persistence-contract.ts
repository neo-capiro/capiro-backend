import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMemoryPhase2PersistenceContract } from './lib/memory-phase2-persistence-contract.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');

function read(relativePath: string): string {
  return readFileSync(join(apiRoot, relativePath), 'utf8');
}

assertMemoryPhase2PersistenceContract({
  prismaSchema: read('prisma/schema.prisma'),
  workflowMigration: read(
    'prisma/migrations/20260818010000_memory_phase2_review_workflow_foundation/migration.sql',
  ),
  revisionMigration: read(
    'prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql',
  ),
  revisionService: read('src/memory/memory-review-revision.service.ts'),
});

process.stdout.write('MEMORY_PHASE2_PERSISTENCE_CONTRACT_COMPLETE\n');
