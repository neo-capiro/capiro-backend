import { hostname } from 'node:os';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Phase9RuntimeHeartbeat, scalarMetrics } from '../phase9-runtime-heartbeat.js';
import {
  runPublicCaptureTask,
  type PublicCaptureTaskMode,
  type PublicCaptureTaskResult,
} from './public-capture-task-runner.js';

const MODES = ['preflight', 'worker', 'both', 'status', 'disposition', 'disposition-backfill'] as const;
type Phase9CaptureMode = (typeof MODES)[number];

async function main(): Promise<void> {
  const rawMode = process.argv[2] ?? 'both';
  if (!MODES.includes(rawMode as Phase9CaptureMode)) {
    throw new Error(`usage: run-phase9-public-capture <${MODES.join('|')}> [--manual] [--limit=N] [--hearingId=ID] [--lookback-days=N] [--cursor=ISO|hearingId]`);
  }
  const mode = rawMode as Phase9CaptureMode;
  const manual = process.argv.includes('--manual');
  if ((mode === 'disposition' || mode === 'disposition-backfill') && !manual) {
    // Demand-free disposition (Step 5/9) and the bounded historical
    // disposition-backfill (Phase 9 shadow-hardening readiness gap): both
    // determine and persist a canonical hearing-level stream disposition
    // WITHOUT creating capture demand (no hearing_subscription, no
    // public_hearing_capture row, no capture job). These are explicit
    // operator paths, never part of the recurring scheduled capture-worker
    // cadence — the scheduled `both`/`worker`/`preflight` verbs never pass
    // --manual and can never select either mode without one, so an
    // accidental schedule change can't silently start running either mode
    // on a cadence.
    throw new Error(`${mode} mode requires --manual (explicit operator invocation only)`);
  }
  const args = process.argv.slice(3).filter((value) => value !== '--manual');
  const prisma = new PrismaService();
  const workerId =
    process.env.LEGIWATCH_WORKER_ID ??
    `phase9-capture:${hostname()}:${process.pid}:${mode}`;
  const heartbeat = new Phase9RuntimeHeartbeat(prisma, {
    jobKey: 'capture-worker',
    workerId,
    manual,
    log: console.log,
  });

  await prisma.$connect();
  await heartbeat.begin();
  const results: PublicCaptureTaskResult[] = [];
  try {
    if (mode === 'status') {
      results.push(await run('status', args, prisma, workerId));
    } else if (mode === 'disposition') {
      results.push(await run('disposition', args, prisma, workerId));
    } else if (mode === 'disposition-backfill') {
      results.push(await run('disposition-backfill', args, prisma, workerId));
    } else {
      if (mode === 'preflight' || mode === 'both') {
        results.push(await run('preflight', args, prisma, workerId));
        await heartbeat.beat({ stage: 'preflight_complete' });
      }
      if (mode === 'worker' || mode === 'both') {
        results.push(await run('worker', args, prisma, workerId));
      }
    }
    const summary = combine(results);
    await heartbeat.succeed(scalarMetrics(summary));
    console.log(`PHASE9_PUBLIC_CAPTURE_DONE ${JSON.stringify({ workerId, mode, summary, results })}`);
  } catch (error) {
    await heartbeat.fail(error, { mode });
    throw error;
  } finally {
    heartbeat.stopTimer();
    await prisma.$disconnect();
  }
}

function run(
  mode: PublicCaptureTaskMode,
  args: string[],
  prisma: PrismaService,
  workerId: string,
): Promise<PublicCaptureTaskResult> {
  return runPublicCaptureTask(mode, args, {
    prisma,
    workerId: `${workerId}:${mode}`,
    log: console.log,
  });
}

function combine(results: readonly PublicCaptureTaskResult[]): Record<string, number> {
  return results.reduce(
    (summary, result) => ({
      discovered: summary.discovered + result.discovered,
      claimed: summary.claimed + result.claimed,
      completed: summary.completed + result.completed,
      requeued: summary.requeued + result.requeued,
      failed: summary.failed + result.failed,
    }),
    { discovered: 0, claimed: 0, completed: 0, requeued: 0, failed: 0 },
  );
}

void main().catch((error: unknown) => {
  console.error(
    `PHASE9_PUBLIC_CAPTURE_ERROR ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
