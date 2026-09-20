/**
 * S-4 — bounded database and tool usage for the Hermes runtime.
 *
 * THE MECHANISM, stated plainly (decisions.md §4 row "Hermes-attributable DB
 * connections ≤ 20 % of the API pool"):
 *
 *   1. A counting semaphore with a FIFO waiter queue caps how many
 *      Hermes-attributable database operations may be in flight in this
 *      process at once. The cap is `floor(pool × share)`, where `pool` is the
 *      `connection_limit` in DATABASE_URL (the same number Prisma sizes its
 *      pool from) and `share` defaults to the declared 0.2. On this host's
 *      fixture URL (`connection_limit=33`) that resolves to **6 of 33**,
 *      leaving 27 connections of application headroom.
 *   2. A waiter that cannot get a slot within `dbAcquireTimeoutMs` is REFUSED
 *      with an actionable `hermes_db_capacity_exhausted`, not left to queue
 *      without bound. An unbounded wait queue is just a slower outage.
 *   3. Every Hermes-attributable transaction opened through `withTenantTx` /
 *      `withSystemTx` sets `SET LOCAL statement_timeout`, so the database
 *      itself — not only the caller's patience — bounds the work. This is the
 *      part that makes the slot cap real: without it a hung query would hold a
 *      slot until the process died.
 *   4. `withDeadline` bounds a single broker TOOL call. It bounds the caller's
 *      wait; the underlying operation is bounded by (3). Stated honestly
 *      because a JS promise cannot be cancelled: on a deadline the caller gets
 *      `hermes_tool_deadline_exceeded` and the slot is released when the
 *      underlying operation actually settles, which `statement_timeout`
 *      guarantees will happen.
 *
 * SCOPE, stated honestly: this is a PER-PROCESS bound. N replicas each bound
 * themselves to 20 % of their own pool, which is the correct shape — each
 * replica has its own pool — but it is not a global count of Hermes
 * connections across the fleet. The cross-replica controls in this phase are
 * the ones that had to be cross-replica (budgets, concurrency, profile
 * writers); connection-pool headroom is a property of one process's own pool
 * and is bounded where that pool lives.
 */
import { Injectable, Logger, RequestTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
// Value import, not `import type`: Nest reads `design:paramtypes` for
// constructor injection, and a type-only import erases to `Object`.
import { PrismaService } from '../../prisma/prisma.service.js';
import { meriHermesScalingLimits, type MeriHermesScalingLimits } from './meri-hermes-scaling.config.js';

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  label: string;
  enqueuedAt: number;
}

export interface MeriHermesDbGovernorStats {
  maxConcurrency: number;
  poolSize: number;
  poolShare: number;
  inFlight: number;
  waiting: number;
  peakInFlight: number;
  admitted: number;
  queued: number;
  refused: number;
  deadlineExceeded: number;
}

@Injectable()
export class MeriHermesDbGovernor {
  private readonly logger = new Logger(MeriHermesDbGovernor.name);

  /** Test seam, matching the convention used by the adapter/broker. */
  env: NodeJS.ProcessEnv = process.env;

  private limitsCache: MeriHermesScalingLimits | null = null;
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];
  private peakInFlight = 0;
  private admitted = 0;
  private queuedCount = 0;
  private refused = 0;
  private deadlineExceeded = 0;

  limits(): MeriHermesScalingLimits {
    this.limitsCache ??= meriHermesScalingLimits(this.env);
    return this.limitsCache;
  }

  /** Drop the memoised envelope — used by specs that mutate `env` between cases. */
  reset(): void {
    this.limitsCache = null;
    this.inFlight = 0;
    this.peakInFlight = 0;
    this.admitted = 0;
    this.queuedCount = 0;
    this.refused = 0;
    this.deadlineExceeded = 0;
    while (this.waiters.length) {
      const w = this.waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.reject(new ServiceUnavailableException({ code: 'hermes_db_governor_reset' }));
      }
    }
  }

  stats(): MeriHermesDbGovernorStats {
    const limits = this.limits();
    return {
      maxConcurrency: limits.dbMaxConcurrency,
      poolSize: limits.dbPoolSize,
      poolShare: limits.dbPoolShare,
      inFlight: this.inFlight,
      waiting: this.waiters.length,
      peakInFlight: this.peakInFlight,
      admitted: this.admitted,
      queued: this.queuedCount,
      refused: this.refused,
      deadlineExceeded: this.deadlineExceeded,
    };
  }

  /**
   * Run `fn` holding one governor slot. Bounded wait, FIFO, and the slot is
   * always released — including when `fn` throws.
   */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(label);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(label: string): Promise<void> {
    const limits = this.limits();
    if (this.inFlight < limits.dbMaxConcurrency) {
      this.inFlight += 1;
      this.admitted += 1;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      return;
    }
    this.queuedCount += 1;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        label,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          this.refused += 1;
          reject(
            new ServiceUnavailableException({
              code: 'hermes_db_capacity_exhausted',
              message:
                `Hermes database capacity is saturated (${limits.dbMaxConcurrency} concurrent operations, ` +
                `${limits.dbPoolShare * 100}% of a ${limits.dbPoolSize}-connection pool). ` +
                'Retry in a moment; application traffic is deliberately given the remaining headroom.',
              waitedMs: limits.dbAcquireTimeoutMs,
              operation: label,
            }),
          );
        }, limits.dbAcquireTimeoutMs),
      };
      this.waiters.push(waiter);
    });
    this.inFlight += 1;
    this.admitted += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
  }

  private release(): void {
    this.inFlight -= 1;
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    }
  }

  /**
   * Bound a single tool call. Rejects with `hermes_tool_deadline_exceeded`
   * after `ms`; see the honesty note in the class doc about what a deadline on
   * an uncancellable promise does and does not do.
   */
  async withDeadline<T>(label: string, fn: () => Promise<T>, ms?: number): Promise<T> {
    const deadline = ms ?? this.limits().toolDeadlineMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.deadlineExceeded += 1;
            reject(
              new RequestTimeoutException({
                code: 'hermes_tool_deadline_exceeded',
                message: `Hermes tool call '${label}' exceeded its ${deadline} ms deadline and was abandoned.`,
                tool: label,
                deadlineMs: deadline,
              }),
            );
          }, deadline);
          // Never keep the event loop alive for a deadline alone.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A governed tool call: one bounded slot, one deadline, in that order. */
  async guard<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.withDeadline(label, () => this.run(label, fn));
  }

  /**
   * A tenant-scoped transaction that holds a governor slot and carries a
   * Postgres `statement_timeout`. Hermes-attributable database work should use
   * this rather than `prisma.withTenant` directly.
   */
  async withTenantTx<T>(
    prisma: PrismaService,
    label: string,
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const limits = this.limits();
    return this.run(label, () =>
      prisma.withTenant(
        tenantId,
        async (tx) => {
          await this.applyStatementTimeout(tx, limits.dbStatementTimeoutMs);
          return fn(tx);
        },
        { timeoutMs: limits.dbStatementTimeoutMs + 2_000 },
      ),
    );
  }

  /** The cross-tenant sibling of `withTenantTx`, for the two genuinely global operations. */
  async withSystemTx<T>(
    prisma: PrismaService,
    label: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const limits = this.limits();
    return this.run(label, () =>
      prisma.withSystem(
        async (tx) => {
          await this.applyStatementTimeout(tx, limits.dbStatementTimeoutMs);
          return fn(tx);
        },
        { timeoutMs: limits.dbStatementTimeoutMs + 2_000 },
      ),
    );
  }

  /**
   * `SET LOCAL statement_timeout` — transaction-scoped, discarded at commit.
   * Interpolated rather than bound because Postgres does not accept a bind
   * parameter in `SET`; the value is a validated integer derived from
   * configuration, never from request input.
   */
  private async applyStatementTimeout(tx: Prisma.TransactionClient, ms: number): Promise<void> {
    const safe = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 10_000;
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${safe}`);
  }
}

let sharedGovernor: MeriHermesDbGovernor | null = null;

/**
 * THE process-wide governor.
 *
 * A semaphore only bounds anything if there is exactly ONE of it. Three
 * consumers with six slots each is eighteen slots, which is not "20 % of the
 * pool" by any reading — so the adapter, the broker and the three scaling
 * services all default to this instance rather than each constructing their
 * own, and `MeriModule` binds the Nest provider to the same function so DI
 * hands out the same object.
 *
 * A module-level singleton rather than DI alone, because the two places that
 * matter most — `MeriHermesRuntimeAdapter` and `MeriHermesBrokerService` —
 * deliberately do not take this through their constructors (fourteen and seven
 * specs respectively construct them positionally), so DI cannot reach them.
 *
 * A spec that wants isolated counters constructs `new MeriHermesDbGovernor()`
 * and assigns it; nothing here is forced on a test.
 */
export function meriHermesSharedDbGovernor(): MeriHermesDbGovernor {
  sharedGovernor ??= new MeriHermesDbGovernor();
  return sharedGovernor;
}
