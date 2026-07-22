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

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function formatTime(iso: string): string {
  return TIME_FMT.format(new Date(iso));
}

/** "2:00 PM–2:45 PM" */
export function formatTimeRange(startIso: string, endIso: string): string {
  return `${formatTime(startIso)}–${formatTime(endIso)}`;
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
