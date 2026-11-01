import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from './prisma.service.js';

const OBSERVATION_MS = 10_000;
const unavailable = () => new ServiceUnavailableException('Metrics unavailable: observation timed out. Please retry.');

/** Only the fixed Classic/Research metrics use this adapter. Canonical domain
 * readers retain their ordinary transactions and authority checks, including
 * prep-source locks. No new authorization or alternate database client. */
export function createMetricsDatabaseBudget(
  source: Pick<PrismaService, 'withTenant'>, started: number, now: () => number,
) {
  const monotonicStart = performance.now();
  const deadline = Object.freeze({ at: started + OBSERVATION_MS, now });
  function remaining() {
    const at = now(), elapsed = performance.now() - monotonicStart;
    if (!Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(at) ||
        at < started || at > 8640000000000000 || !Number.isFinite(elapsed) || elapsed < 0)
      throw unavailable();
    const ms = OBSERVATION_MS - Math.max(at - started, elapsed);
    if (ms <= 0) throw unavailable();
    return Math.ceil(ms);
  }
  const assertActive = () => { remaining(); };
  const prisma: Pick<PrismaService, 'withTenant'> = {
    async withTenant<T>(tenantId: string, run: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: Parameters<PrismaService['withTenant']>[2]) {
      const timeoutMs = Math.min(options?.timeoutMs ?? OBSERVATION_MS, remaining());
      // The shared transaction boundary owns acquisition and setup. Keep the same absolute request
      // deadline across every phase; timeoutMs also caps monotonic consumption.
      const transactionOptions = { ...options, timeoutMs, deadline };
      try {
        const value = await source.withTenant(tenantId, async tx => {
          // Recompute after pool acquisition. A late transaction cannot dispatch
          // domain work, even when its initial timeout was calculated earlier.
          remaining();
          let tail: Promise<void> = Promise.resolve();
          const invoke = (owner: object, method: Function, args: unknown[]) => {
            const operation = tail.then(async () => {
              const ms = `${remaining()}ms`;
              await tx.$executeRaw`SELECT set_config('statement_timeout', ${ms}, true), set_config('lock_timeout', ${ms}, true)`;
              remaining();
              const result: unknown = await Reflect.apply(method, owner, args);
              remaining();
              return result;
            });
            // Canonical source checks may use Promise.all. Serialize each
            // settings/query pair so queued work receives its actual remaining
            // budget. After a failure the queue rejects without more dispatch.
            tail = operation.then(() => undefined);
            void tail.catch(() => undefined);
            return operation;
          };
          const delegates = new Map<PropertyKey, object>();
          const bounded = new Proxy(tx, {
            get(target, key) {
              const value: unknown = Reflect.get(target, key);
              if (typeof value === 'function') return (...args: unknown[]) => invoke(target, value, args);
              if (typeof value !== 'object' || value === null) return value;
              if (!delegates.has(key)) delegates.set(key, new Proxy(value, {
                get(owner, methodKey) {
                  const method: unknown = Reflect.get(owner, methodKey);
                  return typeof method === 'function' ? (...args: unknown[]) => invoke(owner, method, args) : method;
                },
              }));
              return delegates.get(key);
            },
          });
          try { return await run(bounded); }
          finally {
            // Never return/rollback while already dispatched work is abandoned.
            // Failed queued work still causes the transaction to roll back.
            await tail;
          }
        }, transactionOptions);
        remaining();
        return value;
      } catch (error) {
        // withTenant has settled its transaction cleanup before this boundary.
        if (error instanceof HttpException && [403, 404].includes(error.getStatus())) throw error;
        remaining();
        if (error && typeof error === 'object' && 'code' in error) {
          const code = String(error.code);
          if (['P2028', 'PRISMA_TRANSACTION_DEADLINE_EXCEEDED', '57014', '55P03'].includes(code)) throw unavailable();
          // Raw SQL cancellation can be wrapped by Prisma. Match the SQLSTATE,
          // not error-message text or every raw-query failure.
          if (code === 'P2010' && 'meta' in error && error.meta && typeof error.meta === 'object' &&
              'code' in error.meta && ['57014', '55P03'].includes(String(error.meta.code))) throw unavailable();
        }
        throw error;
      }
    },
  };
  return { prisma, assertActive };
}
