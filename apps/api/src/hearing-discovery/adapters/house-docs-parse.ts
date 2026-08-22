/**
 * Pure docs.house.gov (House Committee Repository) parsing helpers.
 *
 * Extracted verbatim from `apps/api/scripts/sync-hearings.ts` so the Phase 3
 * `house-repository` adapter and the pre-existing daily sync share ONE parser.
 * The original's findings are preserved here because they are the whole reason
 * this source works: the per-day view (`ByDay.aspx?DayID=MMDDYYYY`) is a plain
 * GET, while the week view is an ASP.NET postback; and each row carries the
 * House `EventID`, which is the SAME id Congress.gov uses for `house-event` —
 * which is why the two sources merge onto one canonical row instead of
 * duplicating.
 */
import { cleanText } from './source-http.js';

export const HOUSE_DOCS_BASE = 'https://docs.house.gov/Committee/Calendar';

export interface HouseDocsMeeting {
  eventId: string;
  committee: string;
  title: string;
  time: string | null;
  location: string | null;
}

// One ByDay GridView row: EventID + title (link) + committee (span.text-tiny) + time + location.
const BYDAY_ROW =
  /<a href="ByEvent\.aspx\?EventID=(\d+)"\s+title="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<span class="text-tiny" title="([^"]*)"[^>]*>[\s\S]*?<\/span>[\s\S]*?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;

export function parseByDay(html: string): HouseDocsMeeting[] {
  const out: HouseDocsMeeting[] = [];
  BYDAY_ROW.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BYDAY_ROW.exec(html)) !== null) {
    const eventId = m[1] ?? '';
    const title = cleanText(m[2] || m[3] || '');
    const committee = cleanText(m[4] ?? '');
    const time = cleanText(m[5] ?? '') || null;
    const location = cleanText(m[6] ?? '') || null;
    if (eventId && committee) out.push({ eventId, committee, title, time, location });
  }
  return out;
}

export function inferHouseType(title: string, committee: string): string {
  const t = `${title} ${committee}`.toLowerCase();
  if (/\bmark[- ]?up\b|marking up/.test(t)) return 'markup';
  if (/\bbusiness meeting\b|organizational meeting|\bmeeting\b/.test(t)) return 'meeting';
  return 'hearing';
}

/** MMDDYYYY for a Date's UTC calendar day (matches docs.house.gov DayID + our DATE column). */
export function houseDayId(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}${dd}${d.getUTCFullYear()}`;
}

/** The ByDay URL for one calendar day. */
export function byDayUrl(day: Date): string {
  return `${HOUSE_DOCS_BASE}/ByDay.aspx?DayID=${houseDayId(day)}`;
}
