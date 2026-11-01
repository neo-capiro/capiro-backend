import type { Prisma } from '../../generated/prisma-client/index.js';
import type { PrismaService } from './prisma.service.js';

/** Request-local execution policy, only enabled by the saved-work observation.
 * Canonical helpers still own the SQL and authorization. Every statement gets
 * the remaining budget, not a fresh timeout. Await rollback before returning;
 * racing a timer would leave the server query and its connection running. */
export class WorkspaceReadBudget {
  constructor(private readonly remaining: () => number) {}

  async transaction<T>(prisma: PrismaService, read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const initial = this.remaining();
    return prisma.$transaction(async tx => {
      const query = async (operation: () => Promise<unknown>) => {
        const milliseconds = this.remaining();
        // LOCAL resets on commit/rollback. Never send zero (unlimited in PG).
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${milliseconds}ms`}, true)`;
        this.remaining();
        const value = await operation();
        this.remaining();
        return value;
      };
      // Shared client/prospect authorities use raw statements; role/population
      // reads use these two ORM delegates. Keep both on this same transaction.
      const timed = new Proxy(tx, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'].includes(String(key)))
            return (...args: unknown[]) => query(() => Reflect.apply(value, target, args));
          if (key === 'wsDraft' || key === 'wsCollaborator')
            return new Proxy(value, { get(delegate, operation) {
              const method = Reflect.get(delegate, operation);
              if (operation === 'findMany' || operation === 'findFirst')
                return (...args: unknown[]) => query(() => Reflect.apply(method, delegate, args));
              return method;
            } });
          return value;
        },
      });
      this.remaining(); // Acquisition consumed part of the same budget.
      return read(timed);
    }, { maxWait: Math.min(1_000, initial), timeout: initial + 1_000 });
  }
}

export function workspaceReadTimedOut(error: unknown): boolean {
  const failure = error as { code?: unknown; meta?: { code?: unknown } } | null;
  return failure?.code === 'P2024' || failure?.code === 'P2028' ||
    (failure?.code === 'P2010' && failure.meta?.code === '57014');
}
