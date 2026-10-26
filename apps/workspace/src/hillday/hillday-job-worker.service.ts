import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { PrismaService } from '../prisma/prisma.service.js';
import { HillDayGenerationService } from './hillday-generation.service.js';
import type { JobClaim } from './hillday-job-state.js';
import type { JobStatus } from './hillday.types.js';

/**
 * Durable Hill Day job worker (WS-10).
 *
 * Reuses the accepted generation-run worker pattern rather than adding a queue
 * or scheduler: a `ws_hillday_job` row is claimed by one conditional
 * `UPDATE … WHERE … RETURNING`, an expired (or legacy null) lease lets any
 * worker re-claim, and the heavy work stays in {@link HillDayGenerationService}
 * so there is exactly one owner of the unit loop.
 *
 * The lease plus the claim generation (`attempt_count`) is the single authority
 * on "who is running this job": every write the run loop makes is fenced by
 * both, so a superseded holder — another process or a later claim in this same
 * process — cannot publish a late result.
 *
 * Binding: `HillDayModule.onModuleInit -> startPoller`, teardown via
 * `onModuleDestroy`.
 */
@Injectable()
export class HillDayJobWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(HillDayJobWorkerService.name);
  /** Stable per-process worker id, written into `lease_holder` on claim. */
  private readonly workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Single-flight guard: one poll at a time bounds the real in-flight lanes. */
  private pollInFlight = false;
  /** Set by teardown: no new discovery or claim may start after this. */
  private stopping = false;

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
    this.stopping = false;
    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        this.logger.error(`Hill Day job poll error: ${error instanceof Error ? error.message : 'unknown'}`);
      });
    }, intervalMs);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    this.logger.log(`Hill Day job worker poller started (id=${this.workerId})`);
  }

  stopPoller(): void {
    this.stopping = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Nest teardown. Clears the timer this worker owns AND refuses further
   * discovery/claims, so a destroying process takes on no new work.
   */
  onModuleDestroy(): void {
    this.stopPoller();
  }

  // ─── claim ──────────────────────────────────────────────────────────────

  /**
   * One poll tick: claim and process up to MAX_CONCURRENT discovered jobs.
   *
   * Single-flight: a tick that fires while a poll is still running is skipped,
   * so the process's real in-flight lane count is bounded by MAX_CONCURRENT
   * instead of growing by two lanes on every interval.
   */
  async poll(): Promise<void> {
    if (this.stopping || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
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
            if (this.stopping) return;
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
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Claim and run a single job by id. Returns the terminal lifecycle, or
   * `'busy'` when another worker holds an unexpired lease. This is the atomic
   * claim entry point.
   */
  async claim(jobId: string): Promise<JobStatus['status'] | 'busy'> {
    if (this.stopping) return 'busy';
    const claim = await this.tryClaim(jobId);
    if (!claim) return 'busy';
    try {
      return await this.generation.runClaimedJob(jobId, claim, () => this.renewLease(jobId, claim));
    } catch (e) {
      // The lease is left to expire; another worker (or the next tick) resumes.
      this.logger.error(`Hill Day job ${jobId} claim failed: ${e instanceof Error ? e.message : 'unknown'}`);
      return 'failed';
    }
  }

  /**
   * Jobs that are freshly queued, whose lease has genuinely lapsed, or that
   * predate this migration (`running` with a null lease). Those legacy rows are
   * exactly the ones the removed in-process Set used to "recover" by failing
   * them; they are now claimable so their in-flight units can be parked
   * `unknown` instead of being stranded or replayed.
   *
   * Discovery never claims: the atomic {@link tryClaim} UPDATE decides the winner.
   */
  private async findClaimableJobs(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM ws_hillday_job
      WHERE status = 'queued'
         OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  }

  /**
   * Atomically claim a job for this worker and return the claim identity.
   *
   * The WHERE clause makes the claim race-free: only a `queued` job, one whose
   * lease has truly expired, or a legacy `running` row with no lease can be
   * taken. `attempt_count` is bumped inside the same statement and returned, so
   * the caller gets the generation of THIS claim and every later write can be
   * fenced by it.
   *
   * The lease interval is a bound numeric expression multiplied by a literal
   * interval. Interpolating a parameter INSIDE a quoted literal
   * (`INTERVAL '${…} seconds'`) is not valid SQL — Prisma binds it as a
   * placeholder instead of substituting the number into the text.
   */
  private async tryClaim(jobId: string): Promise<JobClaim | null> {
    const rows = await this.prisma.$queryRaw<Array<{ attempt_count: number }>>`
      UPDATE ws_hillday_job
      SET lease_holder     = ${this.workerId},
          lease_expires_at = NOW() + (${HillDayJobWorkerService.LEASE_SECONDS} * INTERVAL '1 second'),
          status           = 'running',
          attempt_count    = attempt_count + 1,
          started_at       = COALESCE(started_at, NOW())
      WHERE id = ${jobId}::uuid
        AND (
          status = 'queued'
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
        )
      RETURNING attempt_count
    `;
    const attempt = rows[0]?.attempt_count;
    return typeof attempt === 'number' ? { holder: this.workerId, attempt } : null;
  }

  /**
   * Extend this claim's lease. False means the claim is no longer ours (another
   * worker took over, or this holder was superseded), and the run loop must stop
   * instead of publishing.
   */
  private async renewLease(jobId: string, claim: JobClaim): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE ws_hillday_job
      SET lease_expires_at = NOW() + (${HillDayJobWorkerService.LEASE_SECONDS} * INTERVAL '1 second')
      WHERE id = ${jobId}::uuid
        AND lease_holder = ${claim.holder}
        AND attempt_count = ${claim.attempt}
    `;
    return affected === 1;
  }
}
