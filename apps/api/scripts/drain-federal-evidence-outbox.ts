/** Federal legislative evidence outbox drainer. Dry-run is the default. */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { drainFederalEvidenceOutbox } from '../src/program-element/federal-evidence/outbox.js';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { assertFederalEvidenceOutboxDrainEnabled } from './lib/federal-legislative-sync-safety.js';

dotenvConfig();

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/drain-federal-evidence-outbox.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const commit = process.argv.includes('--commit');
  assertFederalEvidenceOutboxDrainEnabled({
    commit,
    featureEnabled: process.env.FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED,
  });
  const limit = Number(arg('limit') ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error('--limit must be an integer from 1 to 500');
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const pending = await prisma.federalEvidenceChangeOutbox.count({
      where: { status: { in: ['pending', 'failed'] }, availableAt: { lte: new Date() } },
    });
    console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', pending, limit }, null, 2));
    if (!commit) return;
    const drained = await runWithSyncRun(prisma, 'drain-federal-evidence-outbox', async () => {
      const result = await drainFederalEvidenceOutbox(prisma, limit);
      return {
        inserted: result.alertsInserted,
        updated: result.processed,
        skipped: result.suppressedHistorical,
        errors: result.failed,
      };
    });
    console.log(JSON.stringify({ status: 'complete', drained }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((error) => {
  console.error('[drain-federal-evidence-outbox] FAILED', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
}
