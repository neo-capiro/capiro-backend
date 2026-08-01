#!/usr/bin/env tsx
/**
 * Reversible Memory Governance v2 backfill. PREPARE/DRY-RUN by default.
 *
 * Prepare a durable tenant-scoped snapshot without changing memory_items:
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
 *     --tenant-id <uuid>
 *
 * Execute only the exact prepared job after two explicit confirmations:
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
 *     --tenant-id <uuid> --execute --job-id <uuid> \
 *     --confirm-tenant <uuid> --confirm-job <uuid>
 *
 * Roll back only rows that still exactly match that job's expected post-state:
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
 *     --tenant-id <uuid> --rollback --job-id <uuid> \
 *     --confirm-tenant <uuid> --confirm-job <uuid>
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { parseMemoryGovernanceBackfillArgs } from './lib/memory-governance-backfill';
import {
  executeGovernanceBackfill,
  prepareGovernanceBackfill,
  requireGovernanceBackfillMigration,
  rollbackGovernanceBackfill,
} from './lib/memory-governance-backfill-store';

dotenvConfig();

async function main(): Promise<void> {
  const args = parseMemoryGovernanceBackfillArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    await requireGovernanceBackfillMigration(prisma);
    const result =
      args.action === 'prepare'
        ? await prepareGovernanceBackfill(prisma, args.tenantId)
        : args.action === 'execute'
          ? await executeGovernanceBackfill(prisma, args.tenantId, args.jobId!)
          : await rollbackGovernanceBackfill(prisma, args.tenantId, args.jobId!);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if ('ok' in result && result.ok === false) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      job: 'backfill-memory-governance-v2',
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
    }),
  );
  process.exitCode = 1;
});
