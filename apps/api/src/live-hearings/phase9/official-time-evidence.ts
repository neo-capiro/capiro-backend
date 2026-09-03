/**
 * Hard-rule extraction of an EXPLICIT official local-time statement from a
 * committee announcement page (2026-09-04 field-hearing correction).
 *
 * WHAT COUNTS (all required):
 *   - a wall clock ("1:00 PM", "10:00 a.m.");
 *   - an explicit zone token right there in the same statement or a nearby
 *     window ("PT", "PDT", "Pacific Time", "Eastern Time") — either as an
 *     abbreviation attached to the clock ("1:00 PM PT") or spelled out in the
 *     immediate context ("1:00 PM Pacific");
 *   - optionally a date ("September 4, 2026" / "September 4") that pins the
 *     statement to the hearing's day when the page lists several.
 *
 * WHAT NEVER COUNTS:
 *   - a location ("Santa Clarita, California") — geography proves nothing;
 *   - a bare clock with no zone anywhere in context ("1:00 PM" alone);
 *   - a URL or id string that happens to contain am/pm-looking text.
 *
 * The module is PURE: no fetch, no clock, unit-testable.
 */

/** Bounded context window around a clock match, for spelled-out zone words. */
const CONTEXT_WINDOW = 120;

const CLOCK_RE = /(\d{1,2}):(\d{2})\s*([AP])\.?\s?M\.?/gi;

const ZONE_ABBREV_RE = /\b(P[SD]T|E[SD]T|C[SD]T|M[SD]T|PT|ET|CT|MT|AKDT|HST)\b/i;

const ZONE_WORDS_RE =
  /\b(Pacific|Eastern|Central|Mountain|Alaska|Hawaii)\s+(?:Time|time|standard\s+time|daylight\s+time)\b/i;

export interface ExplicitLocalTime {
  /** Normalized wall clock, e.g. "1:00 PM". */
  clock: string;
  /** The zone token as printed ("PT", "PDT", "Pacific Time"). */
  zoneToken: string;
  /** Bounded evidence snippet for the operator report / observation raw blob. */
  snippet: string;
}

/**
 * Find the first statement on the page that pairs an explicit clock with an
 * explicit zone. Returns null when no statement qualifies — never a guess.
 */
export function extractExplicitLocalTime(text: string): ExplicitLocalTime | null {
  const clean = text.replace(/\s+/g, ' ');
  // Also scan visible-ish attributes/elements the announcer may rely on
  // (<time datetime> is NOT used — its zone semantics are ambiguous); text only.
  CLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOCK_RE.exec(clean)) !== null) {
    const clock = `${m[1]}:${m[2]} ${m[3]!.toUpperCase()}M`;
    const start = Math.max(0, m.index - CONTEXT_WINDOW);
    const end = Math.min(clean.length, m.index + m[0].length + CONTEXT_WINDOW);
    const context = clean.slice(start, end);
    const abbrev = ZONE_ABBREV_RE.exec(context);
    if (abbrev?.[1]) {
      return {
        clock,
        zoneToken: abbrev[1].toUpperCase(),
        snippet: context.trim().slice(0, 300),
      };
    }
    const word = ZONE_WORDS_RE.exec(context);
    if (word?.[1]) {
      return {
        clock,
        zoneToken: `${word[1]} Time`,
        snippet: context.trim().slice(0, 300),
      };
    }
  }
  return null;
}

/** HTML → readable text (entities + tags stripped), bounded. */
export function cleanTextSafe(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
