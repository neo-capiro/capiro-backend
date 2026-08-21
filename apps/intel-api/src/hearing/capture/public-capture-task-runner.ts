import { hostname } from 'node:os';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SourceDataRepository } from '../../sourcedata/source-data.repository.js';
import { StreamResolverService } from '../stream-resolver.service.js';
import { FfmpegDeepgramCaptureRuntime } from './ffmpeg-deepgram-capture.runtime.js';
import { PublicCaptureAutomaticResolverAdapter } from './public-capture-automatic-resolver.adapter.js';
import { PublicCaptureCredentialsAdapter } from './public-capture-credentials.adapter.js';
import {
  PublicCaptureOrchestrator,
  PublicCaptureWorkerCoordinator,
} from './public-capture.orchestrator.js';
import {
  PublicCapturePersistentQueueAdapter,
  type PublicCaptureJob,
} from './public-capture-persistent-queue.adapter.js';
import { PublicHearingCaptureAttemptStore } from './public-hearing-capture-attempt.store.js';
import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';
import { PublicHearingTranscriptStore } from './public-hearing-transcript.store.js';

export type PublicCaptureTaskMode = 'preflight' | 'worker' | 'status';

export interface PublicCaptureTaskResult {
  mode: PublicCaptureTaskMode;
  discovered: number;
  claimed: number;
  completed: number;
  requeued: number;
  failed: number;
  results: Array<Record<string, unknown>>;
}

interface TaskDependencies {
  prisma: PrismaService;
  now?: () => Date;
  log?: (message: string) => void;
  workerId?: string;
}

interface CaptureWorkItem {
  hearingId: string;
  captureId: string;
  job?: PublicCaptureJob;
}

const WORKER_JOB_LEASE_MS = 5 * 60_000;
const WORKER_JOB_HEARTBEAT_MS = 60_000;

/**
 * Run one bounded durable capture task invocation.
 *
 * EventBridge/ECS may invoke this runner every minute. Preflight scans canonical
 * demand and drains due preflight jobs. Worker mode leases durable capture jobs
 * with SKIP LOCKED. A process crash merely lets the lease expire; it does not
 * lose the job or create another capture row.
 */
export async function runPublicCaptureTask(
  mode: PublicCaptureTaskMode,
  args: string[],
  dependencies: TaskDependencies,
): Promise<PublicCaptureTaskResult> {
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? (() => undefined);
  const flags = parseFlags(args);
  const workerId =
    dependencies.workerId ??
    `public-capture:${mode}:${bounded(hostname(), 80)}:${process.pid}`;
  const queue = new PublicCapturePersistentQueueAdapter(dependencies.prisma);

  if (mode === 'status') {
    const counts = await queue.pendingCounts(now());
    const result: PublicCaptureTaskResult = {
      mode,
      discovered: counts.preflight + counts.capture,
      claimed: 0,
      completed: 0,
      requeued: 0,
      failed: counts.failed,
      results: [{ ...counts }],
    };
    log(`PUBLIC_CAPTURE_STATUS ${JSON.stringify(result)}`);
    return result;
  }

  const limit = boundedPositiveInteger(Number(flags['limit'] ?? 25), 200, 'limit');
  const store = new PublicHearingCaptureStore(dependencies.prisma);
  const resolver = buildResolver(dependencies.prisma);

  if (mode === 'preflight') {
    const orchestrator = new PublicCaptureOrchestrator(store, resolver, queue);
    const claimed = await queue.claimDue({
      jobType: 'preflight',
      workerId,
      now: now(),
      limit,
      leaseDurationMs: 5 * 60_000,
    });
    const explicit = flags['hearingId']?.trim();
    const due = explicit ? [explicit] : await store.listDueHearingIds(now());
    const ids = [...new Set([...claimed.map((job) => job.hearingId), ...due])].slice(0, limit);
    const claimedByHearing = new Map(claimed.map((job) => [job.hearingId, job]));
    const result: PublicCaptureTaskResult = {
      mode,
      discovered: ids.length,
      claimed: claimed.length,
      completed: 0,
      requeued: 0,
      failed: 0,
      results: [],
    };

    for (const hearingId of ids) {
      const job = claimedByHearing.get(hearingId);
      try {
        const outcome = await orchestrator.reconcile(hearingId);
        result.results.push({ hearingId, outcome });
        result.completed += 1;
        if (job) await queue.complete({ jobId: job.id, workerId, now: now() });
        log(`PUBLIC_CAPTURE_PREFLIGHT hearing=${hearingId} ${JSON.stringify(outcome)}`);
      } catch (error) {
        result.failed += 1;
        result.results.push({ hearingId, error: boundedError(error) });
        if (job) {
          const state = await queue.fail({
            jobId: job.id,
            workerId,
            now: now(),
            error,
            retryAt: new Date(now().getTime() + retryDelayMs(job.attempts)),
          });
          if (state === 'REQUEUED') result.requeued += 1;
        }
        log(`PUBLIC_CAPTURE_PREFLIGHT_ERROR hearing=${hearingId} ${boundedError(error)}`);
      }
    }
    return result;
  }

  const explicitHearingId = flags['hearingId']?.trim();
  const explicitCaptureId = flags['captureId']?.trim();
  if (Boolean(explicitHearingId) !== Boolean(explicitCaptureId)) {
    throw new Error('worker requires both --hearingId= and --captureId= when either is supplied');
  }

  const claimed = explicitHearingId
    ? []
    : await queue.claimDue({
        jobType: 'capture',
        workerId,
        now: now(),
        limit,
        leaseDurationMs: WORKER_JOB_LEASE_MS,
      });
  const result: PublicCaptureTaskResult = {
    mode,
    discovered: explicitHearingId ? 1 : claimed.length,
    claimed: claimed.length,
    completed: 0,
    requeued: 0,
    failed: 0,
    results: [],
  };
  const jobs: CaptureWorkItem[] = [];

  if (explicitHearingId && explicitCaptureId) {
    jobs.push({ hearingId: explicitHearingId, captureId: explicitCaptureId });
  } else {
    for (const job of claimed) {
      if (job.jobType !== 'capture' || !job.captureId) {
        const error = new Error(`durable capture job has invalid shape: ${job.id}`);
        result.failed += 1;
        result.results.push({ jobId: job.id, hearingId: job.hearingId, error: error.message });
        await queue.fail({ jobId: job.id, workerId, now: now(), error });
        continue;
      }
      jobs.push({ hearingId: job.hearingId, captureId: job.captureId, job });
    }
  }
  if (jobs.length === 0) return result;

  let coordinator: PublicCaptureWorkerCoordinator;
  try {
    const credential = await new PublicCaptureCredentialsAdapter().resolve();
    const runtime = new FfmpegDeepgramCaptureRuntime(
      credential.apiKey,
      new PublicHearingTranscriptStore(dependencies.prisma),
    );
    coordinator = new PublicCaptureWorkerCoordinator(store, resolver, runtime, {
      attempts: new PublicHearingCaptureAttemptStore(dependencies.prisma),
      retryQueue: queue,
    });
  } catch (error) {
    for (const work of jobs) {
      if (!work.job) continue;
      const state = await queue.fail({
        jobId: work.job.id,
        workerId,
        now: now(),
        error,
        retryAt: new Date(now().getTime() + retryDelayMs(work.job.attempts)),
      });
      if (state === 'REQUEUED') result.requeued += 1;
      else result.failed += 1;
    }
    if (explicitHearingId) throw error;
    result.results.push({ error: boundedError(error), stage: 'runtime_initialization' });
    return result;
  }

  for (const work of jobs) {
    const stopHeartbeat = work.job
      ? startQueueLeaseHeartbeat(queue, work.job, workerId, now, log)
      : () => undefined;
    try {
      const outcome = await coordinator.run({
        captureId: work.captureId,
        hearingId: work.hearingId,
        workerId,
      });
      stopHeartbeat();
      result.results.push({
        hearingId: work.hearingId,
        captureId: work.captureId,
        outcome,
      });
      result.completed += 1;
      if (work.job) {
        await queue.complete({ jobId: work.job.id, workerId, now: now() });
      }
      log(
        `PUBLIC_CAPTURE_WORKER hearing=${work.hearingId} capture=${work.captureId} ${JSON.stringify(outcome)}`,
      );
    } catch (error) {
      stopHeartbeat();
      result.failed += 1;
      result.results.push({
        hearingId: work.hearingId,
        captureId: work.captureId,
        error: boundedError(error),
      });
      if (work.job) {
        try {
          const state = await queue.fail({
            jobId: work.job.id,
            workerId,
            now: now(),
            error,
            retryAt: new Date(now().getTime() + retryDelayMs(work.job.attempts)),
          });
          if (state === 'REQUEUED') result.requeued += 1;
        } catch (queueError) {
          result.results.push({
            jobId: work.job.id,
            stage: 'queue_failure_record',
            error: boundedError(queueError),
          });
        }
      }
      log(
        `PUBLIC_CAPTURE_WORKER_ERROR hearing=${work.hearingId} capture=${work.captureId} ${boundedError(error)}`,
      );
    }
  }
  return result;
}

function startQueueLeaseHeartbeat(
  queue: PublicCapturePersistentQueueAdapter,
  job: PublicCaptureJob,
  workerId: string,
  now: () => Date,
  log: (message: string) => void,
): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void queue
      .renewLease({
        jobId: job.id,
        workerId,
        now: now(),
        leaseDurationMs: WORKER_JOB_LEASE_MS,
      })
      .catch((error) => {
        log(`PUBLIC_CAPTURE_JOB_HEARTBEAT_ERROR job=${job.id} ${boundedError(error)}`);
      });
  }, WORKER_JOB_HEARTBEAT_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function buildResolver(prisma: PrismaService): PublicCaptureAutomaticResolverAdapter {
  const resolver = new StreamResolverService(
    new ConfigService(),
    new SourceDataRepository(prisma),
  );
  return new PublicCaptureAutomaticResolverAdapter(prisma, resolver);
}

function parseFlags(args: string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const value of args) {
    const match = /^--([^=]+)=(.*)$/.exec(value);
    if (match?.[1]) output[match[1]] = match[2] ?? '';
  }
  return output;
}

function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

function bounded(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function boundedError(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), 1_000);
}

function boundedPositiveInteger(value: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`);
  const integer = Math.floor(value);
  if (integer > max) throw new Error(`${field} must be at most ${max}`);
  return integer;
}

async function main(): Promise<void> {
  const [rawMode, ...args] = process.argv.slice(2);
  if (!['preflight', 'worker', 'status'].includes(rawMode ?? '')) {
    throw new Error('usage: public-capture-task-runner <preflight|worker|status> [--key=value]');
  }
  const prisma = new PrismaService();
  try {
    const result = await runPublicCaptureTask(rawMode as PublicCaptureTaskMode, args, {
      prisma,
      log: (message) => console.log(message),
    });
    console.log(`PUBLIC_CAPTURE_TASK_DONE ${JSON.stringify(result)}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(`PUBLIC_CAPTURE_TASK_ERROR ${boundedError(error)}`);
    process.exitCode = 1;
  });
}
