import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

export type CalendarItemOutcome = 'matched' | 'skipped' | 'removed';
export type CalendarItemCommit = (
  tx: Prisma.TransactionClient,
  outcome: CalendarItemOutcome,
) => Promise<void>;
export type CalendarCheckpoint = (
  tx?: Prisma.TransactionClient,
  verifyOnly?: boolean,
) => Promise<void>;

export async function commitCalendarSkip(
  prisma: PrismaService,
  tenantId: string,
  commit?: CalendarItemCommit,
): Promise<'skipped'> {
  if (commit) await prisma.withTenant(tenantId, (tx) => commit(tx, 'skipped'));
  return 'skipped';
}
