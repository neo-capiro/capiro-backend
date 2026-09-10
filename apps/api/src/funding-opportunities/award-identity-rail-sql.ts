import { Prisma } from '@prisma/client';
import type { AwardIdentityRail } from './award-history-identity.js';

/**
 * SQL predicate for one award-identity rail.
 *
 * Rail exclusivity matches District Nexus / award-history-identity:
 * exact UEI never OR's a reviewed name, and name fallback matches the name
 * itself (not only source rows whose UEI is missing). Client-profile totals
 * that intentionally recover historical missing-UEI rows keep using
 * `clientAwardScopeSql` instead.
 */
export function awardIdentityRailSql(
  rail: AwardIdentityRail,
  ueiColumn: Prisma.Sql = Prisma.sql`recipient_uei`,
  nameColumn: Prisma.Sql = Prisma.sql`contractor_name`,
): Prisma.Sql | null {
  if (rail.basis === 'exact_uei' && rail.ueis.length > 0) {
    return Prisma.sql`${ueiColumn} = ANY(${rail.ueis}::text[])`;
  }
  if (rail.basis === 'reviewed_name_fallback' && rail.fallbackNames.length > 0) {
    return Prisma.sql`lower(${nameColumn}) = ANY(${rail.fallbackNames}::text[])`;
  }
  return null;
}
