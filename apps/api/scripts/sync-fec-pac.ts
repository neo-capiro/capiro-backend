/**
 * Reconcile confirmed clients' PAC contributions from processed FEC Schedule B.
 * pnpm --filter @capiro/api sync:fec-pac · FEC_API_KEY required.
 * Each committee/cycle is published atomically after cursor exhaustion.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { fecCycles } from '../src/intelligence/fec-cycles.js';
import { createFecFetcher } from './fec-api.js';
import { syncPacCycle } from './fec-pac-sync.js';
dotenvConfig();

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-fec-pac.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const key = process.env.FEC_API_KEY;
  if (!key) throw new Error('FEC_API_KEY env var is required');
  const prisma = new PrismaClient();
  const fetchFec = createFecFetcher(key);
  try {
    await runWithSyncRun(prisma, 'sync-fec-pac', async () => {
      // Global sync may enumerate all tenants' confirmed PAC mappings. Scope is
      // still explicit; discovering a similarly named committee never imports it.
      const mappings = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        return tx.clientIntelMapping.findMany({
          where: { source: 'fec_committee', confirmed: true },
          select: { externalId: true },
        });
      });
      const committeeIds = [...new Set(mappings.map((m) => m.externalId.trim()).filter(Boolean))];
      let inserted = 0;
      let errors = 0;
      for (const committeeId of committeeIds) {
        for (const cycle of fecCycles()) {
          try {
            const result = await syncPacCycle(prisma, fetchFec, committeeId, cycle);
            inserted += result.contributionCount;
            console.log(
              `[fec-pac-sync] ${committeeId}/${cycle}: ${result.contributionCount} contributions; complete`,
            );
          } catch (error) {
            errors++;
            console.warn(
              `[fec-pac-sync] ${committeeId}/${cycle} failed: ${(error as Error).message}`,
            );
          }
        }
      }
      return { inserted, updated: 0, skipped: 0, errors, complete: errors === 0 };
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((error) => {
  console.error('[fec-pac-sync] FAILED', error);
  process.exit(1);
});
}
