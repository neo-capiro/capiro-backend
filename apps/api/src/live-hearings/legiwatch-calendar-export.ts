/**
 * LegiWatch V2 Wave 1 (W1-8) — calendar export.
 *
 * Produces RFC 5545 iCalendar text for one canonical hearing, plus the
 * standards-compliant Google/Outlook web-calendar URLs for the same event.
 *
 * This module is PURE: it takes an already-authorized canonical hearing row
 * and returns text. It performs no I/O and reads no tenant state, so the
 * exported event carries public-record facts only.
 *
 * ── The date/time contract (the regression this must not reintroduce) ──
 *
 * The 2026-09-02 QA found every proceeding rendering as "8:00 PM" on the
 * PREVIOUS day, because a date-only `YYYY-MM-DD` was parsed as midnight UTC
 * and then converted into a west-of-UTC zone. The same trap exists in ICS: a
 * date-only hearing emitted as `DTSTART:20260910T000000Z` shifts a day for
 * every viewer west of UTC.
 *
 * The rules enforced here mirror the web contract in
 * `apps/web/src/vnext/pages/legiwatch/lib/hearing-datetime.ts`:
 *
 *  1. A known instant (`startsAt`) is emitted as a UTC `DATE-TIME`
 *     (`...Z`). That is the true instant; every client renders it in the
 *     viewer's own zone, so Eastern/Pacific/DST are all correct by
 *     construction with no VTIMEZONE table to keep in sync.
 *  2. A hearing with NO announced time is emitted as an all-day `VALUE=DATE`
 *     event. A DATE has no zone and cannot shift; no time is invented.
 *  3. The calendar day is never routed through a zone conversion as though it
 *     were midnight UTC.
 *  4. The event's official zone is reported in the description rather than
 *     being silently dropped, so a reader can see the source's own wall clock.
 */

/** The canonical public facts an export needs. All tenant state excluded. */
export interface CalendarExportHearing {
  /** Canonical `committee_hearing.id`. */
  id: string;
  /** Retained ID of a previously exported alias; facts/detail links stay canonical. */
  uidHearingId?: string;
  title: string;
  /** Official Eastern calendar day `YYYY-MM-DD` (canonical `date`). */
  date: string;
  /** True UTC instant when the official time is known; null for date-only. */
  startsAt?: string | Date | null;
  /** Official end instant when known. */
  actualEnd?: string | Date | null;
  scheduledEnd?: string | Date | null;
  calendarRevision?: number;
  timePrecision?: string | null;
  /** Official wall-clock string from the source, e.g. "10:00 AM". */
  time?: string | null;
  /** IANA zone recorded for the event. */
  timezone?: string | null;
  location?: string | null;
  committeeName?: string | null;
  subcommitteeName?: string | null;
  chamber?: string | null;
  /** Official event page (committee site / congress.gov listing). */
  url?: string | null;
  /**
   * 'scheduled' | 'postponed' | 'canceled' | 'in_progress' | 'completed'.
   * Drives VEVENT STATUS and the cancellation SEQUENCE bump.
   */
  eventStatus?: string | null;
}

export interface CalendarExportOptions {
  /**
   * Absolute origin of the app the canonical Hearing Detail link points at,
   * e.g. `https://os.capiro.ai`. No trailing slash.
   */
  appOrigin: string;
  /** Injected for deterministic tests; defaults to now. */
  now?: Date;
  /** Explicitly chosen date-only reminder for a source with uncertain time. */
  dateOnlyReminder?: boolean;
}

export interface CalendarExportResult {
  ics: string;
  filename: string;
  googleUrl: string;
  outlookUrl: string;
  /** The canonical in-app destination for this proceeding. */
  detailUrl: string;
  /** Stable RFC 5545 UID for this hearing. */
  uid: string;
  /** True when the export is an all-day event because no time is announced. */
  allDay: boolean;
}

/** RFC 5545 requires CRLF line endings. */
const CRLF = '\r\n';

/**
 * The UID domain. A UID must be globally unique and STABLE for the life of the
 * event, so it is derived only from the canonical hearing id — never from the
 * export time, the requesting user, or any mutable hearing field.
 */
const UID_DOMAIN = 'legiwatch.capiro.ai';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Zone short labels, matching the web contract's display vocabulary. */
const ZONE_LABEL: Record<string, string> = {
  'America/New_York': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Phoenix': 'MST',
  'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AKT',
  'Pacific/Honolulu': 'HT',
};

/**
 * `YYYY-MM-DD` (or an ISO prefix) → validated calendar parts, or null.
 *
 * Never parses to a Date for validation. The check is a calendar ROUND-TRIP so
 * a structurally valid but impossible day (2026-02-31) is rejected rather than
 * silently normalized into the next month.
 */
export function calendarDayParts(
  value: string | null | undefined,
): { y: number; m: number; d: number } | null {
  const m = value ? DAY_RE.exec(value.trim()) : null;
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const roundTrip = new Date(Date.UTC(y, mo - 1, d));
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== mo - 1 ||
    roundTrip.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m: mo, d };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** A parsed instant, or null when the value is absent/unparseable. */
function toInstant(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** ICS UTC DATE-TIME: `YYYYMMDDTHHMMSSZ`. */
export function icsInstant(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/** ICS DATE value: `YYYYMMDD`. Carries no zone and therefore cannot shift. */
export function icsDate(parts: { y: number; m: number; d: number }): string {
  return `${parts.y}${pad2(parts.m)}${pad2(parts.d)}`;
}

/** The day after `parts`, for an all-day event's exclusive DTEND. */
function nextDay(parts: { y: number; m: number; d: number }): {
  y: number;
  m: number;
  d: number;
} {
  const t = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Escape a TEXT value per RFC 5545 §3.3.11.
 *
 * Backslash MUST be escaped first: escaping it after the others would double
 * the backslashes those substitutions just introduced. Real newlines become
 * the literal two-character sequence `\n`, which is how a multi-line
 * description is carried in ICS.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one content line to 75 OCTETS per RFC 5545 §3.1.
 *
 * The limit is octets, not characters, so folding counts UTF-8 byte length and
 * never splits a multi-byte character across a fold. Continuation lines begin
 * with a single space.
 */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let start = 0; // byte offset of the current chunk
  let limit = 75; // first line takes 75 octets; continuations take 74 + the space

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off to a UTF-8 character boundary: 0b10xxxxxx is a continuation byte.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }

  return out.join(`${CRLF} `);
}

/** VEVENT STATUS for a committee-event lifecycle value. */
function icsStatus(
  eventStatus: string | null | undefined,
): 'CANCELLED' | 'TENTATIVE' | 'CONFIRMED' {
  switch ((eventStatus ?? '').toLowerCase()) {
    case 'canceled':
    case 'cancelled':
      return 'CANCELLED';
    case 'postponed':
      return 'TENTATIVE';
    default:
      return 'CONFIRMED';
  }
}

/** Stable UID for a canonical hearing. */
export function calendarUid(hearingId: string): string {
  return `legiwatch-hearing-${hearingId}@${UID_DOMAIN}`;
}

/**
 * Human-readable description body. Built as real newlines and escaped once, so
 * the multi-line case is exercised by the same path as the single-line case.
 */
function buildDescription(h: CalendarExportHearing, detailUrl: string, allDay: boolean): string {
  const zone = h.timezone?.trim() || 'America/New_York';
  const zoneLabel = ZONE_LABEL[zone] ?? zone;
  const lines: string[] = [];

  const committee = [h.committeeName, h.subcommitteeName]
    .filter((v): v is string => Boolean(v && v.trim()))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(' — ');
  if (committee) lines.push(`Committee: ${committee}`);
  if (h.chamber) lines.push(`Chamber: ${h.chamber}`);

  if (allDay) {
    // Rule 2/3: no time is announced, so none is invented. Saying so is the
    // honest export — an all-day block with no explanation reads as an error.
    lines.push('Time: not announced by the committee.');
  } else if (h.time) {
    // The source's own wall clock, with its zone, alongside the true instant
    // the DTSTART already carries.
    lines.push(`Scheduled: ${h.time} ${zoneLabel}`);
  }

  const status = (h.eventStatus ?? '').toLowerCase();
  if (status === 'canceled' || status === 'cancelled') {
    lines.push('This proceeding was CANCELED by the committee.');
  } else if (status === 'postponed') {
    lines.push('This proceeding was POSTPONED by the committee.');
  }

  lines.push(`View in Capiro: ${detailUrl}`);
  // The official page is included only when the source actually published one.
  if (h.url && h.url.trim()) lines.push(`Official source: ${h.url.trim()}`);

  return lines.join('\n');
}

/**
 * Build the calendar export for one canonical hearing.
 *
 * Throws only when the hearing has no usable calendar day — a row that cannot
 * be placed on a calendar must fail loudly rather than export as "today".
 */
/** One hearing's `BEGIN:VEVENT`…`END:VEVENT` block. Shared by the single-hearing
 *  and bulk exports so the date/time contract above has exactly one implementation. */
function buildVEventProps(
  h: CalendarExportHearing,
  options: CalendarExportOptions,
): {
  props: string[];
  dayParts: NonNullable<ReturnType<typeof calendarDayParts>>;
  start: Date | null;
  end: Date | null;
  detailUrl: string;
  uid: string;
} {
  const dayParts = calendarDayParts(h.date ?? (typeof h.startsAt === 'string' ? h.startsAt : null));
  if (!dayParts) {
    throw new Error(`hearing ${h.id} has no usable calendar date`);
  }

  const start = toInstant(h.startsAt);
  // Rule 1/2: an instant only when the official time is actually known.
  const allDay = start === null;
  if (allDay && h.timePrecision && !options.dateOnlyReminder)
    throw new Error('Time not announced: choose a date-only reminder to export this event');
  const uid = calendarUid(h.uidHearingId ?? h.id);
  const origin = options.appOrigin.replace(/\/+$/, '');
  const detailUrl = `${origin}/legiwatch/hearings/${encodeURIComponent(h.id)}`;
  const status = icsStatus(h.eventStatus);
  const now = options.now ?? new Date();

  // Congressional hearings publish a start, rarely an end. Two hours is the
  // committee-hearing convention when no end is known; it is a display
  // duration, never presented as an official fact.
  const observedEnd = toInstant(h.scheduledEnd) ?? toInstant(h.actualEnd);
  const end = start && observedEnd && observedEnd > start ? observedEnd : null;

  const props: string[] = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsInstant(now)}`,
    // A CANCELLED event must supersede the copy already in the invitee's
    // calendar; SEQUENCE 1 makes the update win over the original SEQUENCE 0.
    `SEQUENCE:${h.calendarRevision ?? (status === 'CANCELLED' ? 1 : 0)}`,
  ];

  if (allDay) {
    // VALUE=DATE — zoneless, so it cannot shift a day for any viewer. DTEND is
    // exclusive per RFC 5545, hence the following day.
    props.push(`DTSTART;VALUE=DATE:${icsDate(dayParts)}`);
    props.push(`DTEND;VALUE=DATE:${icsDate(nextDay(dayParts))}`);
  } else {
    props.push(`DTSTART:${icsInstant(start)}`);
    if (end) props.push(`DTEND:${icsInstant(end)}`);
  }

  const summary = status === 'CANCELLED' ? `CANCELED: ${h.title}` : h.title;
  props.push(`SUMMARY:${escapeIcsText(summary)}`);
  props.push(`DESCRIPTION:${escapeIcsText(buildDescription(h, detailUrl, allDay))}`);
  if (h.location && h.location.trim()) {
    props.push(`LOCATION:${escapeIcsText(h.location.trim())}`);
  }
  // URL points at the canonical in-app record, which is the destination the
  // whole module funnels to. The official source stays in the description.
  props.push(`URL:${detailUrl}`);
  props.push(`STATUS:${status}`);
  props.push('TRANSP:OPAQUE');
  props.push('END:VEVENT');

  return { props, dayParts, start, end, detailUrl, uid };
}

export function buildCalendarExport(
  h: CalendarExportHearing,
  options: CalendarExportOptions,
): CalendarExportResult {
  const { props, dayParts, start, end, detailUrl, uid } = buildVEventProps(h, options);
  const allDay = start === null;

  const calendar: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Capiro//LegiWatch//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...props,
    'END:VCALENDAR',
  ];

  // Trailing CRLF: RFC 5545 content lines are terminated, not separated.
  const ics = calendar.map(foldIcsLine).join(CRLF) + CRLF;

  return {
    ics,
    filename: `legiwatch-hearing-${h.id}.ics`,
    googleUrl: buildGoogleUrl(h, dayParts, start, end, detailUrl, allDay),
    outlookUrl: buildOutlookUrl(h, dayParts, start, end, detailUrl, allDay),
    detailUrl,
    uid,
    allDay,
  };
}

/** Multi-hearing export (LEGIWATCH-V2-HANDOFF §2 header action, §5.1 primary
 *  action) — one VCALENDAR, one VEVENT per hearing, same date/time contract as
 *  the single-hearing export. A hearing whose date cannot be resolved is
 *  skipped (never a thrown 500 for the whole batch) and named in `skipped`. */
export function buildBulkCalendarExport(
  hearings: CalendarExportHearing[],
  options: CalendarExportOptions & { calendarName?: string },
): {
  ics: string;
  filename: string;
  includedCount: number;
  skipped: Array<{ id: string; reason: string }>;
} {
  const skipped: Array<{ id: string; reason: string }> = [];
  const allProps: string[] = [];
  for (const h of hearings) {
    try {
      allProps.push(...buildVEventProps(h, options).props);
    } catch (err) {
      skipped.push({ id: h.id, reason: err instanceof Error ? err.message : 'unresolvable date' });
    }
  }

  const calendar: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Capiro//LegiWatch//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(options.calendarName ?? 'LegiWatch hearings')}`,
    ...allProps,
    'END:VCALENDAR',
  ];
  const ics = calendar.map(foldIcsLine).join(CRLF) + CRLF;

  return {
    ics,
    filename: 'legiwatch-hearings.ics',
    includedCount: hearings.length - skipped.length,
    skipped,
  };
}

/** Google Calendar template URL. Dates use the same zoneless/UTC split. */
function buildGoogleUrl(
  h: CalendarExportHearing,
  dayParts: { y: number; m: number; d: number },
  start: Date | null,
  end: Date | null,
  detailUrl: string,
  allDay: boolean,
): string {
  const dates = allDay
    ? `${icsDate(dayParts)}/${icsDate(nextDay(dayParts))}`
    : `${icsInstant(start!)}/${icsInstant(end ?? start!)}`;
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: icsStatus(h.eventStatus) === 'CANCELLED' ? `CANCELED: ${h.title}` : h.title,
    dates,
    // Newlines are legal in a query value once encoded; Google renders them.
    details: buildDescription(h, detailUrl, allDay),
  });
  if (h.location && h.location.trim()) q.set('location', h.location.trim());
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** Outlook (web) compose-event URL. */
function buildOutlookUrl(
  h: CalendarExportHearing,
  dayParts: { y: number; m: number; d: number },
  start: Date | null,
  end: Date | null,
  detailUrl: string,
  allDay: boolean,
): string {
  const q = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: icsStatus(h.eventStatus) === 'CANCELLED' ? `CANCELED: ${h.title}` : h.title,
    body: buildDescription(h, detailUrl, allDay),
  });
  if (allDay) {
    // Outlook takes a plain date for an all-day event; sending an instant here
    // is what reintroduces the midnight-UTC day shift.
    q.set('allday', 'true');
    q.set('startdt', `${dayParts.y}-${pad2(dayParts.m)}-${pad2(dayParts.d)}`);
    const nd = nextDay(dayParts);
    q.set('enddt', `${nd.y}-${pad2(nd.m)}-${pad2(nd.d)}`);
  } else {
    q.set('startdt', start!.toISOString());
    if (end) q.set('enddt', end.toISOString());
  }
  if (h.location && h.location.trim()) q.set('location', h.location.trim());
  return `https://outlook.office.com/calendar/0/deeplink/compose?${q.toString()}`;
}
