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

export type PublicCaptureTaskMode =
  | 'preflight'
  | 'worker'
  | 'status'
  | 'disposition'
  | 'disposition-backfill';

export interface PublicCaptureTaskResult {
  mode: PublicCaptureTaskMode;
  discovered: number;
  claimed: number;
  completed: number;
  requeued: number;
  failed: number;
  results: Array<Record<string, unknown>>;
}

export interface DispositionBackfillSummary {
  mode: 'disposition-backfill';
  lookbackDays: number;
  limit: number;
  scanned: number;
  attempted: number;
  terminallyDispositioned: number;
  noPublicStream: number;
  policyBlocked: number;
  sourceErrors: number;
  stillUnresolved: number;
  skippedAlreadyExplicit: number;
  errors: Array<{ hearingId: string; error: string }>;
  results: Array<{
    hearingId: string;
    effectiveStart: string;
    state: string;
    reasonCode: string;
    terminal: boolean;
  }>;
  nextCursor: { effectiveStart: string; hearingId: string } | null;
}

/// Hard operator-safety ceiling on a single backfill invocation. This is a
/// manual, bounded-batch path — an unbounded run is explicitly forbidden by
/// the runbook, so the ceiling is enforced here regardless of what --limit
/// the caller passes.
const DISPOSITION_BACKFILL_HARD_MAX = 500;

/// A hearing-level coverage_status that already represents a TERMINAL,
/// explicit disposition (mirrors legiwatch-phase9-readiness.service.ts's
/// TERMINAL_HEARING_COVERAGE_STATUSES exactly — kept as a literal copy here
/// rather than a cross-app import because apps/api and apps/intel-api are
/// separate deployable services with no shared runtime dependency; the
/// disposable-Postgres readiness-gate test is what keeps these two
/// definitions from silently drifting apart).
const TERMINAL_HEARING_COVERAGE_STATUSES_MIRROR = new Set(['no_public_stream', 'blocked']);
const BACKFILL_ELIGIBLE_EVENT_STATUSES = new Set(['scheduled', 'in_progress', 'completed']);

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

  if (mode === 'disposition') {
    // Demand-free path: determine and persist a canonical hearing-level
    // stream disposition WITHOUT creating capture demand. Unlike preflight
    // and worker, this mode:
    //   - NEVER calls PublicCaptureOrchestrator.reconcile() (which gates on
    //     hearing_subscription / captureAllPublicEvents BEFORE resolution)
    //   - NEVER creates a hearing_subscription row
    //   - NEVER creates/updates a public_hearing_capture row
    //   - NEVER enqueues a capture job
    // It reuses the SAME resolver/policy (PublicCaptureAutomaticResolverAdapter
    // -> classifyStreamResolution) captures already use, so a hearing that
    // genuinely HAS a discoverable stream is never mis-classified as having
    // none; it just doesn't create any demand-side side effect either way.
    //
    // Required to be explicit + operator-invoked: an empty hearingId is
    // rejected rather than silently scanning all due hearings, and callers
    // are expected to pass --manual (enforced by the CLI entrypoint, not
    // here, so this function stays usable from tests without the flag).
    const explicitHearingId = flags['hearingId']?.trim();
    if (!explicitHearingId) {
      throw new Error('disposition mode requires --hearingId=<id>');
    }
    const resolverForDisposition = buildResolver(dependencies.prisma);
    const result: PublicCaptureTaskResult = {
      mode,
      discovered: 1,
      claimed: 0,
      completed: 0,
      requeued: 0,
      failed: 0,
      results: [],
    };
    try {
      const resolved = await resolverForDisposition.resolve({ hearingId: explicitHearingId });
      result.completed = 1;
      result.results.push({ hearingId: explicitHearingId, resolved });
      log(`PUBLIC_CAPTURE_DISPOSITION hearing=${explicitHearingId} ${JSON.stringify(resolved)}`);
    } catch (error) {
      result.failed = 1;
      result.results.push({ hearingId: explicitHearingId, error: boundedError(error) });
      log(`PUBLIC_CAPTURE_DISPOSITION_ERROR hearing=${explicitHearingId} ${boundedError(error)}`);
    }
    return result;
  }

  if (mode === 'disposition-backfill') {
    const summary = await runDispositionBackfill(dependencies, flags, log);
    return {
      mode,
      discovered: summary.scanned,
      claimed: 0,
      completed: summary.terminallyDispositioned,
      requeued: 0,
      failed: summary.errors.length,
      results: [summary as unknown as Record<string, unknown>],
    };
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
        // A capture can run for hours. Claim only the job this standalone task
        // can start now; queued siblings must remain claimable by other tasks.
        limit: 1,
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

interface BackfillCandidateRow {
  hearingId: string;
  effectiveStart: Date;
}

interface BackfillHearingCheckRow {
  candidateCount: number;
  hasCaptureOutcome: boolean;
  coverageStatus: string;
}

/**
 * Manual-only historical stream-disposition backfill (Phase 9 shadow-hardening
 * readiness gap). Selects due public hearings that the readiness gate's
 * STREAM_PATH_EXPLICIT check would still count as unresolved — no
 * hearing_stream_candidate, no capture terminal/failure disposition, no
 * terminal hearing-level coverage_status — and calls the SAME resolver used
 * by `disposition` (PublicCaptureAutomaticResolverAdapter.resolve()) for
 * each one, in bounded batches, ordered deterministically for safe resume.
 *
 * Never calls PublicCaptureOrchestrator.reconcile() and never creates a
 * hearing_subscription / public_hearing_capture / public_hearing_capture_job
 * / hearing_stream_candidate row — it is a pure disposition-persistence path
 * identical in blast radius to the single-hearing `disposition` mode it
 * loops over.
 */
async function runDispositionBackfill(
  dependencies: TaskDependencies,
  flags: Record<string, string>,
  log: (message: string) => void,
): Promise<DispositionBackfillSummary> {
  const now = (dependencies.now ?? (() => new Date()))();
  const lookbackDays = boundedPositiveInteger(
    Number(flags['lookback-days'] ?? flags['lookbackDays'] ?? 60),
    3_650,
    'lookback-days',
  );
  const limit = boundedPositiveInteger(
    Number(flags['limit'] ?? 25),
    DISPOSITION_BACKFILL_HARD_MAX,
    'limit',
  );
  const windowStart = new Date(now.getTime() - lookbackDays * 86_400_000);
  const rawCursor = flags['cursor']?.trim();
  let cursor: { effectiveStart: Date; hearingId: string } | null = null;
  if (rawCursor) {
    const [rawTimestamp, rawId] = rawCursor.split('|');
    const parsed = rawTimestamp ? new Date(rawTimestamp) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || !rawId) {
      throw new Error('disposition-backfill --cursor must be "<ISO timestamp>|<hearingId>"');
    }
    cursor = { effectiveStart: parsed, hearingId: rawId };
  }

  const prisma = dependencies.prisma;
  const eligibleStatuses = [...BACKFILL_ELIGIBLE_EVENT_STATUSES];
  const candidates = await prisma.$queryRawUnsafe<BackfillCandidateRow[]>(
    `SELECT h.id AS "hearingId",
            COALESCE(h.starts_at, h.date::timestamp) AS "effectiveStart"
     FROM committee_hearing h
     LEFT JOIN hearing_stream_candidate sc ON sc.hearing_id = h.id
     LEFT JOIN public_hearing_capture phc ON phc.hearing_id = h.id
     WHERE h.visibility = 'public'
       AND h.event_status = ANY($1::text[])
       AND COALESCE(h.starts_at, h.date::timestamp) BETWEEN $2 AND $3
       AND h.coverage_status NOT IN ('no_public_stream','blocked')
       AND ($4::timestamptz IS NULL OR (COALESCE(h.starts_at, h.date::timestamp), h.id) > ($4::timestamptz, $5))
     GROUP BY h.id, h.starts_at, h.date
     HAVING COUNT(DISTINCT sc.id) = 0
        AND COALESCE(
              bool_or(COALESCE(phc.terminal_reason_code, '') <> '' OR COALESCE(phc.failure_code, '') <> ''),
              false
            ) = false
     ORDER BY COALESCE(h.starts_at, h.date::timestamp) ASC, h.id ASC
     LIMIT $6`,
    eligibleStatuses,
    windowStart,
    now,
    cursor?.effectiveStart ?? null,
    cursor?.hearingId ?? null,
    limit,
  );

  const resolver = buildResolver(prisma);
  const summary: DispositionBackfillSummary = {
    mode: 'disposition-backfill',
    lookbackDays,
    limit,
    scanned: candidates.length,
    attempted: 0,
    terminallyDispositioned: 0,
    noPublicStream: 0,
    policyBlocked: 0,
    sourceErrors: 0,
    stillUnresolved: 0,
    skippedAlreadyExplicit: 0,
    errors: [],
    results: [],
    nextCursor: null,
  };

  for (const candidate of candidates) {
    // Idempotency re-check immediately before resolving: a hearing already
    // made explicit since the selection query ran (e.g. an earlier row in
    // this same batch touched a shared upstream source, or a concurrent
    // manual `disposition` call landed) is skipped rather than re-resolved,
    // so repeated backfill runs never duplicate evidence or thrash a
    // hearing's audit trail.
    const fresh = await prisma.$queryRawUnsafe<BackfillHearingCheckRow[]>(
      `SELECT COUNT(DISTINCT sc.id)::int AS "candidateCount",
              COALESCE(
                bool_or(COALESCE(phc.terminal_reason_code, '') <> '' OR COALESCE(phc.failure_code, '') <> ''),
                false
              ) AS "hasCaptureOutcome",
              MIN(h.coverage_status) AS "coverageStatus"
       FROM committee_hearing h
       LEFT JOIN hearing_stream_candidate sc ON sc.hearing_id = h.id
       LEFT JOIN public_hearing_capture phc ON phc.hearing_id = h.id
       WHERE h.id = $1
       GROUP BY h.id`,
      candidate.hearingId,
    );
    const check = fresh[0];
    const alreadyExplicit =
      Boolean(check) &&
      (check!.candidateCount > 0 ||
        check!.hasCaptureOutcome ||
        TERMINAL_HEARING_COVERAGE_STATUSES_MIRROR.has(check!.coverageStatus));
    if (alreadyExplicit) {
      summary.skippedAlreadyExplicit += 1;
      log(`DISPOSITION_BACKFILL_SKIP_ALREADY_EXPLICIT hearing=${candidate.hearingId}`);
      continue;
    }

    summary.attempted += 1;
    try {
      const resolved = await resolver.resolveClassified({ hearingId: candidate.hearingId });
      const state = resolved.selected.state;
      const reasonCode = resolved.selected.reasonCode;
      summary.results.push({
        hearingId: candidate.hearingId,
        effectiveStart: candidate.effectiveStart.toISOString(),
        state,
        reasonCode,
        terminal: resolved.selected.terminal,
      });
      if (state === 'NO_PUBLIC_STREAM') {
        summary.noPublicStream += 1;
        summary.terminallyDispositioned += 1;
      } else if (
        state === 'BROWSER_CAPTURE_ONLY' ||
        state === 'POLICY_BLOCKED' ||
        state === 'CANCELED'
      ) {
        summary.policyBlocked += 1;
        summary.terminallyDispositioned += 1;
      } else if (state === 'SOURCE_ERROR') {
        // Explicitly preserved as non-terminal review evidence — never
        // coerced into NO_PUBLIC_STREAM just to close out the backlog.
        summary.sourceErrors += 1;
      }
      log(
        `DISPOSITION_BACKFILL hearing=${candidate.hearingId} state=${state} reasonCode=${reasonCode}`,
      );
    } catch (error) {
      summary.errors.push({ hearingId: candidate.hearingId, error: boundedError(error) });
      log(`DISPOSITION_BACKFILL_ERROR hearing=${candidate.hearingId} ${boundedError(error)}`);
    }
  }

  summary.stillUnresolved = summary.attempted - summary.terminallyDispositioned;
  const last = candidates[candidates.length - 1];
  summary.nextCursor =
    last && candidates.length >= limit
      ? { effectiveStart: last.effectiveStart.toISOString(), hearingId: last.hearingId }
      : null;
  return summary;
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
  if (!['preflight', 'worker', 'status', 'disposition', 'disposition-backfill'].includes(rawMode ?? '')) {
    throw new Error(
      'usage: public-capture-task-runner <preflight|worker|status|disposition|disposition-backfill> [--key=value]',
    );
  }
  if ((rawMode === 'disposition' || rawMode === 'disposition-backfill') && !args.includes('--manual')) {
    // Demand-free disposition (single hearing or bounded backfill) is an
    // operator/manual path, never part of the recurring capture-worker
    // cadence — require the same --manual flag the other manual invocations
    // use, so it can't be silently added to a schedule without an explicit,
    // reviewable change.
    throw new Error(`${rawMode} mode requires --manual (explicit operator invocation only)`);
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
