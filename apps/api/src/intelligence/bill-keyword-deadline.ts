import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

export const BILL_KEYWORD_SQL_BUDGET_MS = 5_000;
export const BILL_KEYWORD_PROFILE_BUDGET_MS = 15_000;
const scope = new AsyncLocalStorage<number>();

export class BillKeywordDeadlineExceeded extends Error {
  constructor() {
    super('Bill keyword query budget exceeded');
    this.name = 'BillKeywordDeadlineExceeded';
  }
}

function duration(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum)
    throw new RangeError('Invalid bill keyword query budget');
  return value;
}

/** Only bill keyword reads inherit this deadline; other profile sources are unchanged. */
export function withBillKeywordProfileDeadline<T>(
  work: () => Promise<T>,
  budgetMs = BILL_KEYWORD_PROFILE_BUDGET_MS,
): Promise<T> {
  const deadline = performance.now() + duration(budgetMs, BILL_KEYWORD_PROFILE_BUDGET_MS);
  return scope.run(Math.min(scope.getStore() ?? Infinity, deadline), work);
}

type BillQuery = <T>(sql: Prisma.Sql) => Promise<T>;

/**
 * COUNT and rows share one real server-side deadline. Await transaction rollback
 * on error; Promise.race alone would abandon a still-running database query.
 * These two catalogs were global reads before this wrapper and remain so.
 */
export async function withBillKeywordSqlDeadline<T>(
  prisma: Pick<PrismaService, '$transaction'>,
  work: (query: BillQuery) => Promise<T>,
  budgetMs = BILL_KEYWORD_SQL_BUDGET_MS,
): Promise<T> {
  const deadline = Math.min(
    scope.getStore() ?? Infinity,
    performance.now() + duration(budgetMs, BILL_KEYWORD_SQL_BUDGET_MS),
  );
  const remaining = () => {
    const value = Math.floor(deadline - performance.now());
    if (value < 1) throw new BillKeywordDeadlineExceeded();
    return value;
  };
  const initial = remaining(); // An expired parent must not acquire a connection.
  return prisma.$transaction(
    async (tx) => {
      const query: BillQuery = async <R>(sql: Prisma.Sql): Promise<R> => {
        const milliseconds = remaining();
        // LOCAL is reset by commit/rollback. Binding the numeric string is safe,
        // and never emit 0: PostgreSQL interprets that as an unlimited timeout.
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${milliseconds}ms`}, true)`;
        remaining();
        return tx.$queryRaw<R>(sql);
      };
      return work(query);
    },
    { maxWait: Math.min(1_000, initial), timeout: initial + 1_000 },
  );
}
