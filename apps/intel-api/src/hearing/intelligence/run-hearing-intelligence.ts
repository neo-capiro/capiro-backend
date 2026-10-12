/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { hostname } from 'node:os';

const cliArgs = process.argv.slice(2);
const usage = 'Usage: run-hearing-intelligence --once|--loop|--drain|--backfill|--relevance-backfill [additional listed modes]';
const allowed = new Set(['--once', '--loop', '--drain', '--backfill', '--relevance-backfill']);
if (cliArgs.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
if (cliArgs.length === 0 || cliArgs.some((arg) => !allowed.has(arg))) {
  console.error(usage);
  process.exit(2);
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const [{ PrismaService }, { HearingIntelligenceWorker }, { maintainHearingRecords }] =
    await Promise.all([
      import('../../prisma/prisma.service.js'),
      import('./hearing-intelligence.worker.js'),
      import('../hearing-record-maintenance.js'),
    ]);
  const prisma = new PrismaService();
  const workerId =
    process.env.HEARING_INTELLIGENCE_WORKER_ID ?? `phase8:${hostname()}:${process.pid}`;
  const loop = process.argv.includes('--loop');
  const backfill = process.argv.includes('--backfill');
  const relevanceBackfill = process.argv.includes('--relevance-backfill');
  const drainUntilEmpty = process.argv.includes('--drain');
  const worker = new HearingIntelligenceWorker(prisma, workerId, {
    publicBatchSize: integer(process.env.HEARING_INTELLIGENCE_PUBLIC_BATCH, 25),
    tenantBatchSize: integer(process.env.HEARING_INTELLIGENCE_TENANT_BATCH, 25),
    log: (message) => console.log(message),
  });

  await prisma.$connect();
  try {
    if (backfill) {
      const inserted = await worker.backfill(
        integer(process.env.HEARING_INTELLIGENCE_BACKFILL_LIMIT, 100_000),
      );
      console.log(JSON.stringify({ workerId, backfillInserted: inserted }));
    }

    if (relevanceBackfill) {
      const rebuilt = await worker.backfillTenantRelevance(
        integer(process.env.HEARING_RELEVANCE_BACKFILL_HEARINGS, 1_000),
      );
      console.log(JSON.stringify({ workerId, relevanceBackfill: rebuilt }));
    }

    let recordsCheckedAt = 0;
    do {
      const result = await worker.drainOnce();
      if (Date.now() - recordsCheckedAt >= 60000) {
        recordsCheckedAt = Date.now();
        const records = await maintainHearingRecords(prisma);
        if (records.completed || records.failed)
          console.log(JSON.stringify({ workerId, event: 'published_record_work', ...records }));
      }
      console.log(JSON.stringify({ workerId, ...result }));
      const empty = result.publicClaimed === 0 && result.tenantClaimed === 0;
      if (!loop && (!drainUntilEmpty || empty)) break;
      if (loop || !empty) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            empty
              ? integer(process.env.HEARING_INTELLIGENCE_IDLE_MS, 5_000)
              : integer(process.env.HEARING_INTELLIGENCE_ACTIVE_MS, 250),
          ),
        );
      }
    } while (true);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
