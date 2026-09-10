/**
 * Upcoming-signal eligibility and ranking for Federal Market / District Nexus.
 *
 * The plain-text title decoder now lives in @capiro/shared (market-title.ts)
 * so both the API and the web contract tests import the SAME implementation
 * through a workspace dependency — not a cross-package relative path that
 * breaks the web Docker build (apps/api is excluded from its build context).
 */
export { readableMarketTitle } from '@capiro/shared/market-title';

/** Inactive is out; null/undefined active is treated as not proven inactive. */
export function isActiveForecastFlag(active: boolean | null | undefined): boolean {
  return active !== false;
}

/**
 * Calendar-day eligibility for an anticipated award date.
 * Unknown dates remain eligible and are ranked explicitly later.
 */
export function isUpcomingForecastDate(
  date: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (date == null || date === '') return true;
  const value = typeof date === 'string' ? new Date(`${date.slice(0, 10)}T00:00:00.000Z`) : date;
  if (Number.isNaN(value.getTime())) return true;
  const day = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return day >= today;
}

/** Rank dated signals soonest-first; unknown dates after all dated ones. */
export function rankFutureSignalsByDate<T extends { date: string | null }>(signals: T[]): T[] {
  return [...signals].sort((a, b) => {
    if (a.date == null && b.date == null) return 0;
    if (a.date == null) return 1;
    if (b.date == null) return -1;
    return a.date.localeCompare(b.date);
  });
}
