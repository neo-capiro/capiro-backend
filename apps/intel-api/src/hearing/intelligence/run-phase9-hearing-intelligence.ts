import { hostname } from 'node:os';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Phase9RuntimeHeartbeat, scalarMetrics } from '../phase9-runtime-heartbeat.js';
import {
  HearingIntelligenceWorker,
  type HearingIntelligenceDrainResult,
} from './hearing-intelligence.worker.js';

async function main(): Promise<void> {
  const prisma = new PrismaService();
  const manual = process.argv.includes('--manual');
  const backfill = process.argv.includes('--backfill');
  const relevanceBackfill = process.argv.includes('--relevance-backfill');
  const maxPasses = integer(argumentValue('--max-passes'), 20);
  const workerId =
    process.env.HEARING_INTELLIGENCE_WORKER_ID ??
    `phase9-intelligence:${hostname()}:${process.pid}`;
  const heartbeat = new Phase9RuntimeHeartbeat(prisma, {
    jobKey: 'intelligence-worker',
    workerId,
    manual,
    log: console.log,
  });
  const worker = new HearingIntelligenceWorker(prisma, workerId, {
    publicBatchSize: integer(process.env.HEARING_INTELLIGENCE_PUBLIC_BATCH, 25),
    tenantBatchSize: integer(process.env.HEARING_INTELLIGENCE_TENANT_BATCH, 25),
    log: console.log,
  });

  await prisma.$connect();
  await heartbeat.begin();
  try {
    const summary: Record<string, unknown> = {
      passes: 0,
      backfillInserted: 0,
      relevanceBackfillJobs: 0,
      publicClaimed: 0,
      publicCompleted: 0,
      publicRequeued: 0,
      publicFailed: 0,
      publicInsightsPersisted: 0,
      tenantJobsEnqueued: 0,
      tenantClaimed: 0,
      tenantCompleted: 0,
      tenantFailed: 0,
      tenantMatchesPersisted: 0,
    };
    if (backfill) {
      summary.backfillInserted = await worker.backfill(
        integer(process.env.HEARING_INTELLIGENCE_BACKFILL_LIMIT, 100_000),
      );
    }
    if (relevanceBackfill) {
      const rebuilt = await worker.backfillTenantRelevance(
        integer(process.env.HEARING_RELEVANCE_BACKFILL_HEARINGS, 1_000),
      );
      summary.relevanceBackfill = rebuilt;
      summary.relevanceBackfillJobs = rebuilt.jobs;
    }

    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const result = await worker.drainOnce();
      aggregate(summary, result);
      summary.passes = pass;
      await heartbeat.beat({
        pass,
        publicClaimed: result.publicClaimed,
        tenantClaimed: result.tenantClaimed,
      });
      console.log(`PHASE9_HEARING_INTELLIGENCE_PASS ${JSON.stringify({ workerId, pass, result })}`);
      if (result.publicClaimed === 0 && result.tenantClaimed === 0) break;
    }
    await heartbeat.succeed(scalarMetrics(summary));
    console.log(`PHASE9_HEARING_INTELLIGENCE_DONE ${JSON.stringify({ workerId, summary })}`);
  } catch (error) {
    await heartbeat.fail(error);
    throw error;
  } finally {
    heartbeat.stopTimer();
    await prisma.$disconnect();
  }
}

function aggregate(
  summary: Record<string, unknown>,
  result: HearingIntelligenceDrainResult,
): void {
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'number') continue;
    const current = typeof summary[key] === 'number' ? (summary[key] as number) : 0;
    summary[key] = current + value;
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

void main().catch((error: unknown) => {
  console.error(
    `PHASE9_HEARING_INTELLIGENCE_ERROR ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
