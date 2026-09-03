// Date/label helpers for the Meetings module. All day-bucketing uses LOCAL
// dates (YYYY-MM-DD keys parsed as local, never UTC — the Meetings-tab gotcha).

export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD key as a LOCAL date (midnight local), not UTC. */
export function localDateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** True when an ISO instant is exactly UTC midnight (all UTC time parts zero). */
function isUtcMidnight(iso: string): boolean {
  const d = new Date(iso);
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

/**
 * All-day events (Google date-only / Outlook isAllDay) are stored at UTC
 * midnight on BOTH ends. There is no isAllDay flag on the wire, so we detect
 * them by that signature — a timed meeting effectively never both starts AND
 * ends at exact UTC midnight.
 */
export function isAllDayMeeting(startsAt: string, endsAt: string): boolean {
  if (!isUtcMidnight(startsAt) || !isUtcMidnight(endsAt)) return false;
  // Also require the span to be a whole number of days (>0), so a rare timed
  // block that merely starts/ends at exact UTC midnight isn't misread as all-day.
  const span = new Date(endsAt).getTime() - new Date(startsAt).getTime();
  return span > 0 && span % 86_400_000 === 0;
}

/**
 * Day-bucket key for a meeting. Timed events bucket by the viewer's LOCAL day.
 * All-day events are date-only stored at UTC midnight; bucketing them locally
 * shifts them to the PREVIOUS day for west-of-UTC (US) users (and can drop them
 * off the leading edge of a window), so bucket them by their UTC calendar date —
 * the YYYY-MM-DD they nominally fall on.
 */
export function meetingDayKey(startsAt: string, endsAt: string): string {
  if (isAllDayMeeting(startsAt, endsAt)) return startsAt.slice(0, 10);
  return dayKey(new Date(startsAt));
}

export function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

/** Monday-start week containing `d`. */
export function startOfWeek(d: Date): Date {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (date.getDay() + 6) % 7; // 0 = Monday
  return addDays(date, -dow);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function isSameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

export function isToday(d: Date): boolean {
  return isSameDay(d, new Date());
}

/**
 * Clock format for the whole Meetings module (both surfaces).
 *
 * The locale is PINNED to en-US rather than left as `undefined`. With
 * `undefined` this follows the machine's default, so an en-GB/de/fr default —
 * or a CI runner whose ICU default is a 24-hour locale — renders "14:00" with
 * no meridiem: the "show a real 12-hour clock, not military time" decision
 * silently does not apply, and the test that asserts "2:00 PM" fails on that
 * machine only. This product is US-only (congressional offices, districts,
 * Hill Day) and every string beside this one is en-US copy, so a pinned en-US
 * clock is what the design specifies rather than whatever the viewer's OS
 * happens to prefer. Same pattern as zonedShortTime in
 * pages/radar/live-hearings/LiveHearingsPage.tsx, which pins en-US and guards
 * the instant too (it degrades to an empty string where this module uses an
 * em dash — a Meetings row has a visible cell to fill).
 *
 * Only the CLOCK is pinned. The weekday/month formatters below deliberately
 * keep following the viewer's locale: a localized month NAME is cosmetic,
 * whereas a localized hour cycle changes what the number means.
 *
 * Note for tests: modern ICU separates the meridiem with U+202F NARROW NO-BREAK
 * SPACE, not a plain space. Testing Library's default text normalizer collapses
 * it to " " (U+202F is in `\s`), so getByText('2:00 PM') matches; a raw string
 * comparison has to normalize the whitespace itself.
 */
const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

/**
 * "2:00 PM". An unparseable instant renders an em dash instead of throwing:
 * `Intl.DateTimeFormat.format(new Date('bad'))` raises RangeError, and this
 * runs inside the render of every meeting row and of the drawer's when-line,
 * so one bad `startsAt` off the wire would take out the whole day/week list
 * body rather than degrade a single cell.
 */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return TIME_FMT.format(d);
}

/** "2:00 PM–2:45 PM", or a single em dash when either end is unparseable. */
export function formatTimeRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return '—';
  return `${TIME_FMT.format(start)}–${TIME_FMT.format(end)}`;
}

const WEEKDAY_LONG = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const WEEKDAY_SHORT = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DATE_SHORT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const MONTH_TITLE = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const DAY_TITLE = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** "Friday, July 10", prefixed "Today — " when it's today. */
export function formatDayHeader(d: Date): string {
  const base = WEEKDAY_LONG.format(d);
  return isToday(d) ? `Today — ${base}` : base;
}

export function formatWeekdayShort(d: Date): string {
  return WEEKDAY_SHORT.format(d).toUpperCase();
}

export function formatDateShort(iso: string): string {
  return DATE_SHORT.format(new Date(iso));
}

export function formatMonthTitle(d: Date): string {
  return MONTH_TITLE.format(d);
}

export function formatDayTitle(d: Date): string {
  return DAY_TITLE.format(d);
}

const WEEK_RANGE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/**
 * Week/range label with the month on BOTH ends: "Jul 10 – Jul 16", and across a
 * month boundary "Jul 25 – Aug 1". (The end previously rendered as a bare
 * day-of-month, so a same-month range read "Jul 10 – 16" — month on one side.)
 */
export function formatWeekRange(start: Date, end: Date): string {
  return `${WEEK_RANGE.format(start)} – ${WEEK_RANGE.format(end)}`;
}

const PROVIDER_LABELS: Record<string, string> = {
  teams: 'Teams',
  zoom: 'Zoom',
  meet: 'Google Meet',
  webex: 'Webex',
  goto: 'GoTo',
  slack: 'Slack',
};

export function providerLabel(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return PROVIDER_LABELS[provider] ?? provider;
}
