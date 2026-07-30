/**
 * Program Element canonical-change outbox drainer.
 * Dry-run is the default; --commit is required to deliver pending rows.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementChangeOutboxService } from '../src/program-element/program-element-change-outbox.service.js';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const limit = Math.max(1, Math.min(500, Number(arg('limit') ?? 50)));
  if (!Number.isSafeInteger(limit)) throw new Error('--limit must be an integer between 1 and 500');

  const client = new PrismaClient();
  await client.$connect();
  try {
    const pending = await client.programElementChangeOutbox.count({
      where: { status: { in: ['pending', 'failed'] } },
    });
    console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY-RUN', pending, limit }, null, 2));
    if (!commit) return;

    const prisma = client as unknown as PrismaService;
    const service = new ProgramElementChangeOutboxService(prisma);
    const result = await runWithSyncRun(client, 'drain-pe-change-outbox', async () => {
      const drained = await service.drain(limit);
      return {
        inserted: 0,
        updated: drained.processed,
        skipped: Math.max(0, pending - drained.processed - drained.failed),
        errors: drained.failed,
      };
    });
    console.log(JSON.stringify({ status: 'complete', result }, null, 2));
  } finally {
    await client.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[drain-pe-change-outbox] FAILED', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
