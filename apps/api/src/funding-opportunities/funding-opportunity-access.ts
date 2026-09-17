import { Prisma } from '@prisma/client';
import { OPPORTUNITY_SOURCES } from './funding-opportunities.types.js';

/** Inbox source vocabulary: catalog rails plus non-catalog inbox rails. */
export const INBOX_SOURCES = [
  ...OPPORTUNITY_SOURCES,
  'agency_forecast',
  'dibbs',
  'sbir_sttr',
] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

export const FORECAST_INBOX_SOURCE = 'agency_forecast' as const;
export const DIBBS_INBOX_SOURCE = 'dibbs' as const;
export const SBIR_INBOX_SOURCE = 'sbir_sttr' as const;

/**
 * Return the tenant/user allow-list for client-scoped reads. Walled clients
 * require an explicit grant; archived or inactive profiles are excluded.
 */
export async function readVisibleClientIds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorUserId: string,
): Promise<string[]> {
  const [clients, grants] = await Promise.all([
    tx.client.findMany({
      where: { tenantId, status: { not: 'archived' }, profileStatus: 'ACTIVE' },
      select: { id: true, memoryWall: true },
    }),
    tx.clientMemoryAccess.findMany({
      where: { tenantId, userId: actorUserId },
      select: { clientId: true },
    }),
  ]);
  const granted = new Set(grants.map((grant) => grant.clientId));
  return clients.filter((client) => !client.memoryWall || granted.has(client.id)).map((client) => client.id);
}
