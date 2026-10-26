import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { PrismaService } from '../prisma/prisma.service.js';
import { HillDayGenerationService } from './hillday-generation.service.js';
import type { JobStatus } from './hillday.types.js';

/**
 * Durable Hill Day job worker (WS-10).
 *
 * Reuses the accepted generation-run worker pattern (`GenerationRunWorkerService`)
 * rather than adding a queue or scheduler: a `ws_hillday_job` row is claimed by
 * one conditional `UPDATE … WHERE`, an expired lease lets any worker re-claim,
 * and the heavy work stays in {@link HillDayGenerationService} so there is
 * exactly one owner of the unit loop.
 *
 * The lease is the single authority on "who is running this job". A worker that
 * cannot renew its own lease stops instead of writing, and a unit another
 * worker left in flight is parked as `unknown` by the generation service rather
 * than re-run — a lost process is not evidence that a paid provider call
 * failed. Binding: `HillDayModule.onModuleInit -> startPoller`.
 */
@Injectable()
export class HillDayJobWorkerService {
  private readonly logger = new Logger(HillDayJobWorkerService.name);
  /** Stable per-process worker id, written into `lease_holder` on claim. */
  private readonly workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Same lease length and lane count as the accepted generation-run worker. */
  private static readonly LEASE_SECONDS = 5 * 60;
  private static readonly POLL_BATCH = 8;
  private static readonly MAX_CONCURRENT = 2;

  constructor(
    private readonly prisma: PrismaService,
    private readonly generation: HillDayGenerationService,
  ) {}

  // ─── lifecycle (poller) ─────────────────────────────────────────────────

  /**
   * Start the poller. Claims and processes candidate jobs every `intervalMs`.
   * Called by HillDayModule.onModuleInit; also safe to call from tests.
   */
  startPoller(intervalMs: number): void {
    if (this.pollTimer || intervalMs <= 0) return;
    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        this.logger.error(`Hill Day job poll error: ${error instanceof Error ? error.message : 'unknown'}`);
      });
    }, intervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    this.logger.log(`Hill Day job worker poller started (id=${this.workerId})`);
  }

  stopPoller(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ─── claim ──────────────────────────────────────────────────────────────

  /** One poll tick: claim and process up to MAX_CONCURRENT discovered jobs. */
  async poll(): Promise<void> {
    let candidates: string[];
    try {
      candidates = await this.findClaimableJobs(HillDayJobWorkerService.POLL_BATCH);
    } catch (e) {
      this.logger.warn(`poll: discovery failed: ${(e as Error).message}`);
      return;
    }
    if (!candidates.length) return;

    const lanes = Math.max(1, Math.min(HillDayJobWorkerService.MAX_CONCURRENT, candidates.length));
    let cursor = 0;
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (;;) {
          const id = candidates[cursor++];
          if (!id) return;
          try {
            await this.claim(id);
          } catch (e) {
            this.logger.warn(`poll: job ${id} errored: ${(e as Error).message}`);
          }
        }
      }),
    );
  }

  /**
   * Claim and run a single job by id. Returns the terminal lifecycle, or
   * `'busy'` when another worker holds an unexpired lease. This is the atomic
   * claim entry point.
   */
  async claim(jobId: string): Promise<JobStatus['status'] | 'busy'> {
    if (!(await this.tryClaim(jobId))) return 'busy';
    try {
      return await this.generation.runClaimedJob(jobId, () => this.renewLease(jobId));
    } catch (e) {
      // The lease is left to expire; another worker (or the next tick) resumes.
      this.logger.error(`Hill Day job ${jobId} claim failed: ${e instanceof Error ? e.message : 'unknown'}`);
      return 'failed';
    }
  }

  /**
   * Jobs that are freshly queued or whose lease has genuinely lapsed. Discovery
   * never claims: the atomic {@link tryClaim} UPDATE decides the winner.
   */
  private async findClaimableJobs(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ws_hillday_job
      WHERE status = 'queued'
         OR (status = 'running' AND lease_expires_at < NOW())
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  /**
   * Atomically claim a job for this worker. The WHERE clause makes the claim
   * race-free: only a `queued` job or one whose lease has truly expired can be
   * taken, and `attempt_count` increments only on a real claim.
   */
  private async tryClaim(jobId: string): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE ws_hillday_job
      SET lease_holder     = ${this.workerId},
          lease_expires_at = NOW() + INTERVAL '${HillDayJobWorkerService.LEASE_SECONDS} seconds',
          status           = 'running',
          attempt_count    = attempt_count + 1,
          started_at       = COALESCE(started_at, NOW())
      WHERE id = ${jobId}::uuid
        AND (
          status = 'queued'
          OR (status = 'running' AND lease_expires_at < NOW())
        )
    `;
    return affected === 1;
  }

  /** Extend this worker's lease. False means another worker now owns the job. */
  private async renewLease(jobId: string): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE ws_hillday_job
      SET lease_expires_at = NOW() + INTERVAL '${HillDayJobWorkerService.LEASE_SECONDS} seconds'
      WHERE id = ${jobId}::uuid
        AND lease_holder = ${this.workerId}
    `;
    return affected === 1;
  }
}
