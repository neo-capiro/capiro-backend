import { Prisma } from '../../generated/prisma-client/index.js';
import { ATTACHED_ARTIFACT_WHERE, LIVE_NODE_WHERE } from './live-node.js';

/**
 * The editor payload shape returned by every strategy read + mutation: meta +
 * nodes (chronological) + artifact back-links. Tenant-scoped via the query hook
 * (findFirstOrThrow is where-bearing). Callers that mutate return this so the
 * web can replace its cache with authoritative post-write state.
 *
 * P0-1: nodes ARCHIVED by a non-destructive restore, and artifact links DETACHED
 * with them, are excluded — this payload is the LIVE plan. They are not gone:
 * VersionService.listDetached() surfaces them (the audit's "detached artifacts
 * remain discoverable"), which is also why the editor can keep filtering
 * artifacts by node id without rendering links to nodes it no longer has.
 */
export function loadStrategyDetail(tx: Prisma.TransactionClient, strategyId: string) {
  return tx.spStrategy.findFirstOrThrow({
    where: { id: strategyId },
    include: {
      nodes: {
        where: { ...LIVE_NODE_WHERE },
        orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }],
      },
      artifacts: { where: { ...ATTACHED_ARTIFACT_WHERE } },
    },
  });
}
