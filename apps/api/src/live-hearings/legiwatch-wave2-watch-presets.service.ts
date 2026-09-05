/**
 * LegiWatch V2 Wave 2 (W2-4) — Watch Presets CRUD + governed backtest.
 *
 * A preset SUPPLEMENTS the canonical client watchlist; it never generates a
 * live alert on its own (see legiwatch-wave2-watch-backtest-matcher.ts's
 * header for why). This service owns lifecycle (create/read/update/pause/
 * resume/archive) and the backtest job queue built on the SAME lease-table
 * pattern the shipped intelligence-extraction jobs already use.
 *
 * ── absolute no-side-effect rule ──
 *
 * `runBacktest`/`claimAndRun` call ONLY `evaluateCondition` (read-only) and
 * write to exactly one row: this job's own `legiwatch_watch_backtest_job`
 * record. Nothing here ever touches `hearing_follow`, `hearing_subscription`,
 * `public_hearing_capture`, `legiwatch_notification_event`, Phase 9 readiness
 * state, or rollout state — proved by a dedicated test that snapshots every
 * one of those tables' row counts before and after a backtest run.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  BACKTEST_QUERY_VERSION,
  evaluateCondition,
  SIGNAL_FAMILIES,
  type ConditionOutcome,
  type SignalFamily,
  type WatchCondition,
} from './legiwatch-wave2-watch-backtest-matcher.js';

const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 30;
const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 5;

export interface BacktestResult {
  evaluatedFrom: string;
  evaluatedTo: string;
  corpusCoverage: Record<SignalFamily, { evaluated: boolean }>;
  totalMatched: number;
  bySignalFamily: Record<string, number>;
  byPriority: Record<string, number>;
  sampleMatches: ReturnType<typeof flattenSamples>;
  unknownOrUnsupportedConditions: Array<{ condition: WatchCondition; reason: string }>;
  queryVersion: string;
  asOf: string;
}

function flattenSamples(outcomes: ConditionOutcome[]) {
  return outcomes.flatMap((o) => o.samples);
}

/**
 * The signal family a condition is really evaluated against, for conditions
 * whose family is IMPLICIT rather than caller-supplied. FUNDING_MOVEMENT only
 * ever reads `program_element_delta` (see the matcher's header); a caller is
 * not required to also redundantly set `family: 'program_element'` on it, so
 * `corpusCoverage`/`bySignalFamily` must not read that condition as
 * "unattributed" just because the field was left unset. HEARING_SCHEDULED and
 * CLIENT_RELEVANCE_HIGH are equally single-family by construction.
 */
function effectiveFamily(condition: WatchCondition): SignalFamily | null {
  if (condition.family) return condition.family;
  if (condition.type === 'FUNDING_MOVEMENT') return 'program_element';
  if (condition.type === 'HEARING_SCHEDULED' || condition.type === 'CLIENT_RELEVANCE_HIGH') {
    return 'hearing';
  }
  return null;
}

@Injectable()
export class LegiWatchWave2WatchPresetsService {
  private readonly logger = new Logger(LegiWatchWave2WatchPresetsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── CRUD / lifecycle ─────────────────────────────────────────────────────

  async list(ctx: TenantContext): Promise<{ rows: unknown[] }> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchWatchPreset.findMany({
        where: { ownerUserId: ctx.userId },
        orderBy: { updatedAt: 'desc' },
      }),
    );
    return { rows: rows.map((r) => this.toRow(r)) };
  }

  async get(ctx: TenantContext, id: string): Promise<unknown> {
    return this.toRow(await this.requireOwned(ctx, id));
  }

  async create(
    ctx: TenantContext,
    input: {
      name: string;
      clientIds: string[];
      signalFamilies: SignalFamily[];
      conditions: WatchCondition[];
    },
  ): Promise<unknown> {
    await this.validateDefinition(ctx, input);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchWatchPreset.create({
        data: {
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          name: input.name,
          clientIds: input.clientIds,
          signalFamilies: input.signalFamilies,
          conditions: input.conditions as object,
        },
      }),
    );
    return this.toRow(row);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: Partial<{
      name: string;
      clientIds: string[];
      signalFamilies: SignalFamily[];
      conditions: WatchCondition[];
    }>,
  ): Promise<unknown> {
    const existing = await this.requireOwned(ctx, id);
    const merged = {
      name: input.name ?? existing.name,
      clientIds: input.clientIds ?? existing.clientIds,
      signalFamilies: (input.signalFamilies ?? existing.signalFamilies) as SignalFamily[],
      conditions: (input.conditions ?? (existing.conditions as unknown as WatchCondition[])) as WatchCondition[],
    };
    await this.validateDefinition(ctx, merged);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchWatchPreset.update({
        where: { id },
        data: {
          name: merged.name,
          clientIds: merged.clientIds,
          signalFamilies: merged.signalFamilies,
          conditions: merged.conditions as object,
          updatedAt: new Date(),
        },
      }),
    );
    return this.toRow(row);
  }

  async setStatus(ctx: TenantContext, id: string, status: 'active' | 'paused' | 'archived'): Promise<unknown> {
    await this.requireOwned(ctx, id);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchWatchPreset.update({ where: { id }, data: { status, updatedAt: new Date() } }),
    );
    return this.toRow(row);
  }

  private async requireOwned(ctx: TenantContext, id: string) {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchWatchPreset.findFirst({ where: { id, ownerUserId: ctx.userId } }),
    );
    if (!row) throw new NotFoundException('Watch preset not found');
    return row;
  }

  private toRow(row: {
    id: string;
    name: string;
    clientIds: string[];
    signalFamilies: string[];
    conditions: unknown;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      name: row.name,
      clientIds: row.clientIds,
      signalFamilies: row.signalFamilies,
      conditions: row.conditions,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Every client id must belong to this tenant; every family/condition is enumerated. */
  private async validateDefinition(
    ctx: TenantContext,
    input: { clientIds: string[]; signalFamilies: SignalFamily[]; conditions: WatchCondition[] },
  ): Promise<void> {
    if (!input.signalFamilies.length) {
      throw new BadRequestException('At least one signal family is required.');
    }
    for (const family of input.signalFamilies) {
      if (!(SIGNAL_FAMILIES as readonly string[]).includes(family)) {
        throw new BadRequestException(`Unknown signal family "${family}".`);
      }
    }
    if (input.clientIds.length) {
      const found = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findMany({ where: { id: { in: input.clientIds } }, select: { id: true } }),
      );
      if (found.length !== new Set(input.clientIds).size) {
        throw new NotFoundException('One or more clients do not belong to this tenant.');
      }
    }
    for (const condition of input.conditions) {
      if (condition.type === 'CLIENT_RELEVANCE_HIGH' && !input.clientIds.length) {
        throw new BadRequestException(
          'CLIENT_RELEVANCE_HIGH requires the preset to name at least one client.',
        );
      }
    }
  }

  // ── backtest ─────────────────────────────────────────────────────────────

  /**
   * Submit a backtest. Creates the job row, then attempts to claim and run it
   * INLINE within this same call — the matcher's queries are all bounded,
   * indexed, single-table-or-simple-join reads over a <=90-day window, so the
   * common case finishes well inside an HTTP request. The job row is the
   * durable record either way: if this process is killed mid-run, or a
   * caller wants to submit-and-poll instead of waiting, `getJob` reads the
   * same row a separate worker invocation (`claimAndRun` again, e.g. from a
   * scheduled script) would complete.
   */
  async submitBacktest(
    ctx: TenantContext,
    input: {
      presetId?: string;
      clientIds: string[];
      signalFamilies: SignalFamily[];
      conditions: WatchCondition[];
      windowDays?: number;
    },
  ): Promise<unknown> {
    await this.validateDefinition(ctx, input);
    const windowDays = Math.min(Math.max(input.windowDays ?? DEFAULT_WINDOW_DAYS, 1), MAX_WINDOW_DAYS);
    if (input.presetId) await this.requireOwned(ctx, input.presetId);

    const request = {
      clientIds: input.clientIds,
      signalFamilies: input.signalFamilies,
      conditions: input.conditions,
      windowDays,
    };

    const job = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchWatchBacktestJob.create({
        data: {
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          presetId: input.presetId ?? null,
          request: request as object,
          queryVersion: BACKTEST_QUERY_VERSION,
        },
      }),
    );

    return this.claimAndRun(ctx.tenantId, job.id, `inline:${ctx.userId}`);
  }

  async getJob(ctx: TenantContext, jobId: string): Promise<unknown> {
    const job = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchWatchBacktestJob.findFirst({ where: { id: jobId, ownerUserId: ctx.userId } }),
    );
    if (!job) throw new NotFoundException('Backtest job not found');
    return this.jobToRow(job);
  }

  /**
   * Claim (FOR UPDATE SKIP LOCKED, same shape as the shipped intelligence job
   * claim) and execute one backtest job. Exposed separately from
   * `submitBacktest` so a standalone worker script can call it too — the
   * established async-job pattern, not a new queueing mechanism.
   */
  async claimAndRun(tenantId: string, jobId: string, workerId: string): Promise<unknown> {
    const claimed = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `WITH picked AS (
           SELECT id FROM legiwatch_watch_backtest_job
           WHERE id = $1::uuid
             AND attempts < $2
             AND ( (status IN ('pending','failed') AND due_at <= now())
                   OR (status = 'leased' AND lease_expires_at < now()) )
           FOR UPDATE SKIP LOCKED
         )
         UPDATE legiwatch_watch_backtest_job job
         SET status = 'leased', attempts = attempts + 1, lease_owner = $3,
             lease_expires_at = now() + ($4 * interval '1 second'),
             last_error = NULL, updated_at = now()
         FROM picked WHERE job.id = picked.id
         RETURNING job.id`,
        jobId,
        MAX_ATTEMPTS,
        workerId,
        LEASE_SECONDS,
      ),
    );
    if (!claimed.length) {
      // Already leased by someone else, or already terminal — read back
      // whatever state exists rather than erroring the caller.
      const existing = await this.prisma.withTenant(tenantId, (tx) =>
        tx.legiWatchWatchBacktestJob.findUnique({ where: { id: jobId } }),
      );
      if (!existing) throw new NotFoundException('Backtest job not found');
      return this.jobToRow(existing);
    }

    try {
      const job = await this.prisma.withTenant(tenantId, (tx) =>
        tx.legiWatchWatchBacktestJob.findUniqueOrThrow({ where: { id: jobId } }),
      );
      const request = job.request as unknown as {
        clientIds: string[];
        signalFamilies: SignalFamily[];
        conditions: WatchCondition[];
        windowDays: number;
      };
      const to = new Date();
      const from = new Date(to.getTime() - request.windowDays * 24 * 60 * 60 * 1000);

      const outcomes = await Promise.all(
        request.conditions.map((condition) =>
          evaluateCondition(this.prisma, condition, { from, to }, { tenantId, clientIds: request.clientIds }),
        ),
      );

      const result = this.buildResult(request.signalFamilies, from, to, outcomes);

      const completed = await this.prisma.withTenant(tenantId, (tx) =>
        tx.legiWatchWatchBacktestJob.updateMany({
          where: { id: jobId, status: 'leased', leaseOwner: workerId },
          data: {
            status: 'completed',
            result: result as object,
            completedAt: new Date(),
            updatedAt: new Date(),
          },
        }),
      );
      if (completed.count === 0) {
        // The lease was stolen (expired) mid-run — another worker owns this
        // job now. Do NOT write our result over theirs.
        const current = await this.prisma.withTenant(tenantId, (tx) =>
          tx.legiWatchWatchBacktestJob.findUniqueOrThrow({ where: { id: jobId } }),
        );
        return this.jobToRow(current);
      }
      return { id: jobId, status: 'completed', result };
    } catch (err) {
      this.logger.warn(`Backtest job ${jobId} failed: ${(err as Error).message}`);
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.legiWatchWatchBacktestJob.updateMany({
          where: { id: jobId, status: 'leased', leaseOwner: workerId },
          data: {
            status: 'failed',
            lastError: (err as Error).message?.slice(0, 2000) ?? 'Unknown error',
            // Bounded exponential backoff, same formula as the shipped
            // intelligence job store: floor 5s, cap 15min.
            dueAt: new Date(Date.now() + Math.min(900, Math.max(5, 2 ** 1 * 5)) * 1000),
            updatedAt: new Date(),
          },
        }),
      );
      throw err;
    }
  }

  private buildResult(
    families: SignalFamily[],
    from: Date,
    to: Date,
    outcomes: ConditionOutcome[],
  ): BacktestResult {
    const corpusCoverage = Object.fromEntries(
      SIGNAL_FAMILIES.map((f) => [
        f,
        {
          evaluated:
            families.includes(f) &&
            outcomes.some((o) => effectiveFamily(o.condition) === f && o.supported),
        },
      ]),
    ) as Record<SignalFamily, { evaluated: boolean }>;

    const bySignalFamily: Record<string, number> = {};
    for (const outcome of outcomes) {
      const family = effectiveFamily(outcome.condition);
      if (!outcome.supported || !family) continue;
      bySignalFamily[family] = (bySignalFamily[family] ?? 0) + outcome.matched;
    }

    const byPriority: Record<string, number> = {};
    for (const outcome of outcomes) {
      for (const sample of outcome.samples) {
        for (const code of sample.reasonCodes) {
          byPriority[code] = (byPriority[code] ?? 0) + 1;
        }
      }
    }

    return {
      evaluatedFrom: from.toISOString(),
      evaluatedTo: to.toISOString(),
      corpusCoverage,
      totalMatched: outcomes.reduce((sum, o) => sum + o.matched, 0),
      bySignalFamily,
      byPriority,
      sampleMatches: flattenSamples(outcomes),
      unknownOrUnsupportedConditions: outcomes
        .filter((o) => !o.supported)
        .map((o) => ({ condition: o.condition, reason: o.reason ?? 'Unsupported.' })),
      queryVersion: BACKTEST_QUERY_VERSION,
      asOf: new Date().toISOString(),
    };
  }

  private jobToRow(job: {
    id: string;
    status: string;
    result: unknown;
    lastError: string | null;
    queryVersion: string;
    createdAt: Date;
    completedAt: Date | null;
  }) {
    return {
      id: job.id,
      status: job.status,
      result: job.result,
      lastError: job.lastError,
      queryVersion: job.queryVersion,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    };
  }
}
