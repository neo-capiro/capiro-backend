import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { currentQuotaMonth, LEGISCAN_HARD_CAP, monthToDateQueries } from './legiscan-quota.util.js';

/** One bounded provider request through the existing cursor/transaction lock.
 * Reserve every possible attempt before network; failure/retry attempts count,
 * and only unused attempts are refunded. This is shared with document fallback. */
export async function reservedLegiscanQuery<T>(
  prisma: PrismaClient,
  request: {
    state: string;
    cursorId: string;
    operation: string;
    providerId?: number;
    billKey?: string;
  },
  call: (onRetry: () => void) => Promise<T>,
) {
  const month = currentQuotaMonth(),
    reservationId = randomUUID();
  const budget = Math.min(
    27000,
    30000,
    LEGISCAN_HARD_CAP,
    Number(process.env.LEGISCAN_MONTHLY_BUDGET ?? 27000),
  );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('legiscan-research-quota',0))`;
    const used = monthToDateQueries(
      await tx.stateSyncCursor.findMany({ select: { queriesUsed: true, quotaMonth: true } }),
      month,
    );
    if (!Number.isFinite(budget) || budget <= 0 || used + 4 > budget)
      throw Error('EXISTING_PROVIDER_BUDGET_HOLD');
    const changed =
      await tx.$executeRaw`UPDATE state_sync_cursor SET queries_used=CASE WHEN quota_month=${month} THEN queries_used+4 ELSE 4 END,quota_month=${month} WHERE id=${request.cursorId}`;
    if (changed !== 1) throw Error('EXISTING_PROVIDER_CURSOR_REQUIRED');
    await tx.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete)
      VALUES(${reservationId},'legiscan-research-query-reservation',${JSON.stringify({ jurisdiction: request.state, billId: request.billKey })}::jsonb,
      ${JSON.stringify({ providerId: request.providerId, operation: request.operation, reservedQueries: 4, quotaMonth: month })}::jsonb,false)`;
  });
  let attempts = 1;
  try {
    const value = await call(() => {
      if (attempts >= 4) throw Error('PROVIDER_RESERVED_ATTEMPTS_EXCEEDED');
      attempts++;
    });
    return { value, attempts };
  } finally {
    if (attempts < 4)
      await prisma.$executeRaw`UPDATE state_sync_cursor SET queries_used=greatest(0,queries_used-${4 - attempts}) WHERE id=${request.cursorId} AND quota_month=${month}`;
  }
}
