/**
 * Upcoming-signal eligibility and presentation for Federal Market / District Nexus.
 *
 * Past and inactive agency forecasts must not occupy the Upcoming preview.
 * Unknown dates stay eligible and are ranked after dated signals so they do
 * not crowd out nearer opportunities. Titles may carry provider HTML and must
 * render as plain text.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Strip common provider markup so drawer copy is readable. */
export function readableMarketTitle(title: string): string {
  return title
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, token: string) => {
      const key = token.toLowerCase();
      if (key in NAMED_ENTITIES) return NAMED_ENTITIES[key]!;
      if (key.startsWith('#x')) {
        const code = Number.parseInt(key.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (key.startsWith('#')) {
        const code = Number.parseInt(key.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

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
