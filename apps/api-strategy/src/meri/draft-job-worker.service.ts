/**
 * DraftJobWorkerService — async draft-from-goal worker (strategy generation
 * timeout fix), mirroring apps/api's OutreachJobService / MeetingPrepJobService
 * claim-sweep shape in this app's own first job runner.
 *
 * POST /strategies/draft used to be one fully synchronous call, all the way
 * through the orchestrator's own repair/retry loop (up to ~3 attempts x up to
 * 8 rounds x 120s per call, plus retries) — a shape with no single timeout
 * that is both safe and a good client experience. DraftJobService now enqueues
 * an SpDraftJob and returns 202; THIS service's setInterval claim-sweep runs
 * the actual generation OFF the request path, past any ALB/client idle
 * ceiling, bounded only by the job's own deadline.
 *
 * Coordination is a single atomic claim per tick (`FOR UPDATE SKIP LOCKED`),
 * which is pool-safe (advisory locks don't survive pooled transactions) AND
 * multi-replica-correct — with N worker replicas running this sweep, up to N
 * jobs process concurrently, one per instance, and no two replicas can claim
 * the same row. A job stuck 'running' with no progress for
 * STRATEGY_DRAFT_JOB_STALE_MS (a pod died mid-job) is reclaimed back to
 * 'queued' — "no progress" rather than merely "claimed a while ago" because
 * `updated_at` bumps on every stage/stream-delta write MeriService.draft()'s
 * jobRuntime hooks make, so a genuinely still-running job keeps refreshing it.
 */
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriService } from './meri.service.js';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import {
  DRAFT_JOB_STAGE_TEXT,
  type DraftJobInput,
  type DraftJobRuntime,
  type DraftJobStage,
} from './draft-job.types.js';

/** Rolling cap on sp_draft_job.stream_preview so a long drafting session never
 *  grows the row unbounded — keeps only the most recent tail. */
const STREAM_PREVIEW_MAX_CHARS = 4_000;
/** Throttle DB writes for streamed text deltas — buffered in memory between
 *  writes so a chatty stream doesn't hammer Postgres on every chunk. */
const STREAM_FLUSH_INTERVAL_MS = 750;

/** One claimed row, in the shape processJob needs (mapped from the raw SQL's
 *  snake_case columns — this is NOT the Prisma model type; a raw query result
 *  is never automatically camelCased). */
interface ClaimedDraftJob {
  id: string;
  tenantId: string;
  ownerUserId: string;
  input: DraftJobInput;
  streamPreview: string | null;
  deadlineAt: Date;
}

interface RawClaimRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  input: unknown;
  stream_preview: string | null;
  deadline_at: Date;
}

@Injectable()
export class DraftJobWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DraftJobWorkerService.name);
  private readonly instanceId: string;
  private readonly sweepMs: number;
  private readonly staleMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meriService: MeriService,
    private readonly orchestrator: StrategyOrchestratorClient,
    config: ConfigService,
  ) {
    this.instanceId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.sweepMs = Number.parseInt(config.get<string>('STRATEGY_DRAFT_JOB_SWEEP_MS') ?? '', 10) || 2_000;
    this.staleMs =
      Number.parseInt(config.get<string>('STRATEGY_DRAFT_JOB_STALE_MS') ?? '', 10) || 5 * 60 * 1000;
  }

  onModuleInit(): void {
    if (!this.orchestrator.configured) {
      this.logger.log('draft-job worker disabled: Meri orchestrator is not configured');
      return;
    }
    this.timer = setInterval(() => {
      if (this.sweeping) return; // overlap-skip: a slow draft must not stack ticks
      this.sweeping = true;
      this.tick()
        .catch((err) => this.logger.error(`draft job sweep failed: ${(err as Error).message}`))
        .finally(() => {
          this.sweeping = false;
        });
    }, this.sweepMs);
    this.timer.unref?.();
    this.logger.log(
      `draft-job worker started (instance=${this.instanceId}, sweep every ${this.sweepMs}ms, stale after ${this.staleMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    await this.failExpired();
    await this.reclaimStale();
    const job = await this.claimNext();
    if (job) await this.processJob(job);
  }

  /** Deadline sweep: a job that ran out of budget while queued (a long
   *  backlog) or mid-flight (caught again below by the streaming client's own
   *  abort, but this is the belt-and-suspenders net for anything outside that
   *  single fetch — e.g. the persist transaction). */
  private async failExpired(): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.spDraftJob.updateMany({
        where: { status: { in: ['queued', 'running'] }, deadlineAt: { lte: new Date() } },
        data: {
          status: 'failed',
          stage: 'failed',
          errorMessage: DEADLINE_MESSAGE,
        },
      }),
    );
  }

  /** A 'running' job that hasn't written progress in staleMs (a dead pod) goes
   *  back to 'queued' so another instance can pick it up. Still-live jobs never
   *  match: MeriService.draft()'s jobRuntime hooks write stage/progress at
   *  every real phase transition and (throttled) on every streamed delta,
   *  which bumps updatedAt. */
  private async reclaimStale(): Promise<void> {
    const cutoff = new Date(Date.now() - this.staleMs);
    await this.prisma.withSystem((tx) =>
      tx.spDraftJob.updateMany({
        where: { status: 'running', updatedAt: { lt: cutoff }, deadlineAt: { gt: new Date() } },
        data: { status: 'queued', claimedBy: null, claimedAt: null },
      }),
    );
  }

  /** Atomically claim the oldest eligible queued job (pool + replica safe). */
  private async claimNext(): Promise<ClaimedDraftJob | null> {
    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRawUnsafe<RawClaimRow[]>(
        `UPDATE sp_draft_job SET status='running', claimed_by=$1, claimed_at=NOW(), attempt = attempt + 1, updated_at = NOW()
         WHERE id IN (
           SELECT id FROM sp_draft_job
           WHERE status = 'queued' AND deadline_at > NOW()
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, tenant_id, owner_user_id, input, stream_preview, deadline_at`,
        this.instanceId,
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        ownerUserId: row.owner_user_id,
        input: row.input as DraftJobInput,
        streamPreview: row.stream_preview,
        deadlineAt: row.deadline_at,
      };
    });
  }

  private async processJob(job: ClaimedDraftJob): Promise<void> {
    const { dto, bearer } = job.input;
    let streamBuffer = job.streamPreview ?? '';
    let lastFlushAt = 0;

    const writeProgress = (data: Partial<{ stage: string; progressText: string; streamPreview: string }>) =>
      this.prisma
        .withSystem((tx) =>
          tx.spDraftJob.updateMany({
            where: { id: job.id, claimedBy: this.instanceId, status: 'running' },
            data,
          }),
        )
        .catch((err) =>
          this.logger.warn(`draft job ${job.id} progress write failed: ${(err as Error).message}`),
        );

    const jobRuntime: DraftJobRuntime = {
      // The orchestrator call gets whatever's left of the job's own deadline —
      // NOT STRATEGY_MERI_TIMEOUT_MS. A background worker has no client
      // waiting on a fast response; the deadline is the only ceiling.
      timeoutMs: Math.max(1_000, job.deadlineAt.getTime() - Date.now()),
      onStage: (stage: DraftJobStage, progressText: string) => {
        this.logger.log(`draft job ${job.id} -> ${stage}`);
        void writeProgress({ stage, progressText });
      },
      onStreamDelta: (delta: string) => {
        if (!delta) return;
        streamBuffer = (streamBuffer + delta).slice(-STREAM_PREVIEW_MAX_CHARS);
        const now = Date.now();
        if (now - lastFlushAt < STREAM_FLUSH_INTERVAL_MS) return;
        lastFlushAt = now;
        void writeProgress({ streamPreview: streamBuffer });
      },
    };

    try {
      if (Date.now() > job.deadlineAt.getTime()) throw new Error(DEADLINE_MESSAGE);
      const detail = await this.meriService.draft(job.tenantId, job.ownerUserId, bearer ?? undefined, dto, jobRuntime);
      await this.prisma.withSystem((tx) =>
        tx.spDraftJob.updateMany({
          where: { id: job.id, claimedBy: this.instanceId, status: 'running' },
          data: {
            status: 'completed',
            stage: 'completed',
            progressText: DRAFT_JOB_STAGE_TEXT.completed,
            strategyId: (detail as { id: string }).id,
            streamPreview: streamBuffer || null,
          },
        }),
      );
    } catch (err) {
      const message = this.errorMessageFor(err, job.deadlineAt);
      this.logger.warn(`draft job ${job.id} failed: ${message}`);
      await this.prisma
        .withSystem((tx) =>
          tx.spDraftJob.updateMany({
            where: { id: job.id, claimedBy: this.instanceId, status: 'running' },
            data: { status: 'failed', stage: 'failed', errorMessage: message },
          }),
        )
        .catch((writeErr) =>
          this.logger.error(`draft job ${job.id} could not record failure: ${(writeErr as Error).message}`),
        );
    }
  }

  /** A clear, user-safe message — never a raw stack trace or provider detail
   *  (mirrors every other fail path in this module: plain copy only). */
  private errorMessageFor(err: unknown, deadlineAt: Date): string {
    if (Date.now() > deadlineAt.getTime()) return DEADLINE_MESSAGE;
    const message = err instanceof Error ? err.message : String(err);
    return message.trim() || 'Meri could not draft this strategy.';
  }
}

const DEADLINE_MESSAGE =
  'This draft took too long and was stopped. Try again, or with a narrower goal or fewer attachments.';
