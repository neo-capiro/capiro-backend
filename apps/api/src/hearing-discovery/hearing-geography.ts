import type { Prisma } from '@prisma/client';

/** Compatibility boundary for federal consumers. Null is retained for legacy
 * imports; every state writer must publish its geographic jurisdiction. */
export function federalHearingWhere(
  where: Prisma.CommitteeHearingWhereInput = {},
): Prisma.CommitteeHearingWhereInput {
  return {
    AND: [{ OR: [{ geographicJurisdiction: 'US' }, { geographicJurisdiction: null }] }, where],
  };
}
