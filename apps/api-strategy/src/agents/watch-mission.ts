import { Prisma } from '../../generated/prisma-client/index.js';

/** Keep custom Watch names working by recognizing scheduled/check-run linkage.
 * Execution has no mission-kind column, so its recorded intent must win over
 * a name (including old missions that accidentally received a Watch check).
 */
export const WATCH_MISSION_NAME = 'Keep this strategy on track';
export const WATCH_MISSION_WHERE: Prisma.SpAgentMissionWhereInput = {
  state: { in: ['draft', 'active', 'paused'] },
  name: { not: 'Execute this strategy' },
  NOT: { runs: { some: { findings: { path: ['execution'], not: Prisma.AnyNull } } } },
  OR: [
    { purpose: 'watch' },
    { name: WATCH_MISSION_NAME },
    { cadence: { not: null } },
    { runs: { some: { findings: { path: ['checkedOn'], not: Prisma.AnyNull } } } },
  ],
};

/** Active monitoring wins over older paused history; every caller uses this ordering. */
export async function findWatchMission(tx: Prisma.TransactionClient, strategyId: string) {
  const orderBy: Prisma.SpAgentMissionOrderByWithRelationInput[] = [{ createdAt: 'asc' }, { id: 'asc' }];
  return await tx.spAgentMission.findFirst({ where: { strategyId, ...WATCH_MISSION_WHERE, state: 'active' }, orderBy })
    ?? await tx.spAgentMission.findFirst({ where: { strategyId, ...WATCH_MISSION_WHERE }, orderBy });
}
