import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * This is the same identity used by LegislativeCalendarRepository while it
 * reconciles an OpenStates event. Keep every follow-on writer on this lock so
 * an alias repair cannot commit between observation reconciliation and media
 * candidate persistence.
 */
export function floridaOpenstatesEventLockIdentity(externalEventId: string): string {
  if (!/^ocd-event\/[0-9a-f-]{36}$/i.test(externalEventId))
    throw new Error('A raw OpenStates event id is required for the Florida writer lock');
  return `FL:openstates:event:${externalEventId}`;
}

export async function lockFloridaOpenstatesEventWriter(
  tx: Tx,
  externalEventId: string,
  mode: 'wait' | 'try',
): Promise<boolean> {
  const identity = floridaOpenstatesEventLockIdentity(externalEventId);
  if (mode === 'wait') {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
    return true;
  }
  const [result] = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${identity}, 0)) AS locked`;
  return result?.locked === true;
}
