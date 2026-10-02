import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import type { PrismaService } from '../prisma/prisma.service.js';

// One shared execution budget for count, page, and coverage. Prisma's 5-second
// interactive transaction expiry alone does not cancel an in-flight SQL query.
const MAIL_READ_BUDGET_MS = 3_500;
const unavailable = () => new ServiceUnavailableException('Mail search is temporarily busy. Please retry.');

export async function withMailQueryDeadline<T>(
  prisma: PrismaService,
  tenantId: string,
  read: (query: <R>(sql: Prisma.Sql) => Promise<R>) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.withTenant(tenantId, async (tx) => {
      const deadline = performance.now() + MAIL_READ_BUDGET_MS;
      return read(async <R>(sql: Prisma.Sql): Promise<R> => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw unavailable();
        // LOCAL cannot leak a short timeout onto the next pooled caller. The
        // remaining ceiling also bounds lock waits and prevents three scans
        // from each receiving a fresh full budget.
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${remaining}ms`}, true)`;
        return tx.$queryRaw<R>(sql);
      });
    });
  } catch (error) {
    const failure = error as { code?: unknown; meta?: { code?: unknown } } | null;
    if (failure?.code === 'P2010' && failure.meta?.code === '57014') throw unavailable();
    throw error;
  }
}
