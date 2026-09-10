/**
 * Upcoming-signal eligibility and presentation for Federal Market / District Nexus.
 *
 * Past and inactive agency forecasts must not occupy the Upcoming preview.
 * Unknown dates stay eligible and are ranked after dated signals so they do
 * not crowd out nearer opportunities. Titles may carry provider HTML and must
 * render as plain text.
 */

/** Maximum valid Unicode code point (U+10FFFF). */
const MAX_CODE_POINT = 0x10ffff;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * The single plain-text conversion boundary for market signal titles.
 *
 * The API converts provider markup to plain text exactly once, here. Panels
 * render the returned string verbatim — never decoding again, never stripping
 * what look like tags, because literal angle brackets in already-decoded
 * titles are content (e.g. "Budget <2028> funding"), not markup.
 *
 * Safety rules:
 * - Named entities resolve by OWN property only, so prototype keys like
 *   `constructor` can never be interpolated.
 * - Numeric/hex entities decode only within the valid Unicode range;
 *   out-of-range or unparsable values pass through untouched.
 * - Anything that is not a well-formed, recognized entity stays exactly as
 *   typed.
 */
export function readableMarketTitle(title: string): string {
  return title
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, token: string) => {
      const key = token.toLowerCase();
      // Own-property lookup only: `constructor` and other prototype keys must
      // never resolve, or the function itself gets interpolated into titles.
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) {
        return NAMED_ENTITIES[key]!;
      }
      if (key.startsWith('#x')) {
        const code = Number.parseInt(key.slice(2), 16);
        // Validate the full Unicode range — String.fromCodePoint throws a
        // RangeError above 0x10FFFF, and a decoded title must never throw.
        if (Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT) {
          return String.fromCodePoint(code);
        }
        return match;
      }
      if (key.startsWith('#')) {
        const code = Number.parseInt(key.slice(1), 10);
        if (Number.isFinite(code) && code >= 0 && code <= MAX_CODE_POINT) {
          return String.fromCodePoint(code);
        }
        return match;
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
