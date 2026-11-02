import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import type { PrismaService } from '../prisma/prisma.service.js';

export const RECORDED_ACTIVITY_BUDGET_MS = 10_000;
export const recordedActivityUnavailable = () =>
  new ServiceUnavailableException({
    code: 'RECORDED_ACTIVITY_UNAVAILABLE',
    message: 'Recorded activity is temporarily unavailable.',
  });

/** A single elapsed budget, including authority queries and both observations.
 * Serialize SQL and its LOCAL timeout together: canonical guards can issue
 * Promise.all, and a later timeout must not replace an earlier query's budget.
 * Await every operation/rollback; never race and abandon database work.
 */
export class RecordedActivityBudget {
  private readonly deadline: number;
  constructor(
    private readonly signal?: AbortSignal,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.deadline = clock() + RECORDED_ACTIVITY_BUDGET_MS;
  }

  remaining() {
    const remaining = Math.floor(this.deadline - this.clock());
    if (this.signal?.aborted || remaining <= 0) throw recordedActivityUnavailable();
    return remaining;
  }

  async transaction<T>(
    prisma: Pick<PrismaService, 'withTenant'>,
    tenantId: string,
    read: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.remaining();
    const result = await prisma.withTenant(
      tenantId,
      async (raw) => {
        let pending: Promise<unknown> = Promise.resolve();
        let failed = false;
        const execute = (
          target: object,
          method: (...args: unknown[]) => unknown,
          args: unknown[],
        ) => {
          const operation = pending.then(async () => {
            if (failed) throw recordedActivityUnavailable();
            // Also bound disconnect cleanup latency for an in-flight statement.
            const ms = Math.min(1_000, this.remaining());
            await raw.$executeRaw`SELECT set_config('statement_timeout', ${`${ms}ms`}, true),
            set_config('lock_timeout', ${`${ms}ms`}, true)`;
            this.remaining();
            const value = await Reflect.apply(method, target, args);
            this.remaining();
            return value;
          });
          pending = operation.catch(() => {
            failed = true;
          });
          return operation;
        };
        const delegates = new Map<PropertyKey, object>();
        const tx = new Proxy(raw, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (typeof value === 'function')
              return (...args: unknown[]) => execute(target, value, args);
            if (!value || typeof value !== 'object') return value;
            if (!delegates.has(key))
              delegates.set(
                key,
                new Proxy(value, {
                  get(delegate, operation) {
                    const fn = Reflect.get(delegate, operation);
                    return typeof fn === 'function'
                      ? (...args: unknown[]) => execute(delegate, fn, args)
                      : fn;
                  },
                }),
              );
            return delegates.get(key);
          },
        });
        try {
          return await read(tx);
        } finally {
          await pending;
        }
      },
      { timeoutMs, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    this.remaining();
    return result;
  }
}
