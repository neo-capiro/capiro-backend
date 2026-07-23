import { Prisma } from '../../generated/prisma-client/index.js';

/**
 * The editor payload shape returned by every strategy read + mutation: meta +
 * nodes (chronological) + artifact back-links. Tenant-scoped via the query hook
 * (findFirstOrThrow is where-bearing). Callers that mutate return this so the
 * web can replace its cache with authoritative post-write state.
 */
export function loadStrategyDetail(tx: Prisma.TransactionClient, strategyId: string) {
  return tx.spStrategy.findFirstOrThrow({
    where: { id: strategyId },
    include: {
      nodes: { orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }] },
      artifacts: true,
    },
  });
}
