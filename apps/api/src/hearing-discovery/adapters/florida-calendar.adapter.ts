import { load } from 'cheerio';
import { contentHash } from '../hearing-identity.js';
import { houseStartsAt } from '../hearing-time.js';
import { calendarDayParts } from '../../live-hearings/legiwatch-calendar-export.js';
import type {
  AgendaItem,
  CalendarDocument,
  CalendarTime,
  LegislativeObservation,
} from '../legislative-calendar.js';

export const FL_SENATE = 'https://www.flsenate.gov';
export const FL_HOUSE = 'https://www.flhouse.gov';
export const FL_CALENDAR_PARSER = 'fl-calendar/2026-09-14.1';

/** Florida LegiScan bill labels use H/S plus four digits; notices use HB/SB. */
export function floridaBillNumberAliases(raw: string): string[] {
  const number = raw
    .replace(/^(?:CS\/)+/i, '')
    .replace(/\s+/g, '')
    .toUpperCase();
  const bill = /^(H|S)B0*(\d+)$/.exec(number);
  if (!bill) return [number];
  const digits = bill[2]!;
  return [
    ...new Set([
      `${bill[1]}B${digits}`,
      `${bill[1]}${digits}`,
      `${bill[1]}B${digits.padStart(4, '0')}`,
      `${bill[1]}${digits.padStart(4, '0')}`,
    ]),
  ];
}
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
export type SenateNoticeRef = {
  id: string;
  bodyCode: string;
  bodyName: string;
  date: string;
  rawTime: string;
  sourceUrl: string;
  documents: CalendarDocument[];
  watchUrl: string | null;
  canceled: boolean;
};

export function floridaDate(raw: string): string | null {
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw.trim());
  const day = slash
    ? `${slash[3]}-${slash[1]!.padStart(2, '0')}-${slash[2]!.padStart(2, '0')}`
    : raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && calendarDayParts(day) ? day : null;
}
/** A publisher calendar heading identifies a day, not a local-midnight instant. */
function headingDate(raw: string): string | null {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const match =
    /^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(
      raw,
    );
  if (!match) return null;
  const month = months.findIndex((name) => name.toLowerCase() === match[1]!.toLowerCase()) + 1;
  if (!month) return null;
  return floridaDate(`${match[3]}-${String(month).padStart(2, '0')}-${match[2]!.padStart(2, '0')}`);
}
function localTime(date: string, rawTime: string, end: string | null = null): CalendarTime {
  const clock = rawTime
    .replace(/\bnoon\b/gi, 'PM')
    .replace(/\bmidnight\b/gi, 'AM')
    .replace(/\./g, '')
    .trim();
  const startsAt = houseStartsAt(new Date(`${date}T00:00:00Z`), clock);
  const endsAt = end ? houseStartsAt(new Date(`${date}T00:00:00Z`), end.replace(/\./g, '')) : null;
  return {
    date,
    rawTime: rawTime || null,
    timezone: 'America/New_York',
    precision: startsAt ? 'instant' : /upon|after|adjourn/i.test(rawTime) ? 'relative' : 'date',
    startsAt: startsAt?.toISOString() ?? null,
    endsAt: startsAt && endsAt && endsAt > startsAt ? endsAt.toISOString() : null,
  };
}
export function senateCommitteeLinks(
  html: string,
  session: string,
): Array<{ code: string; name: string; url: string }> {
  const $ = load(html),
    found = new Map<string, { code: string; name: string; url: string }>();
  $('a[href*="/Committees/Show/"]').each((_, a) => {
    const code = /\/Committees\/Show\/([A-Za-z]+)(?:\/|$)/.exec($(a).attr('href') ?? '')?.[1];
    if (code)
      found.set(code.toUpperCase(), {
        code: code.toUpperCase(),
        name: clean($(a).text()),
        url: `${FL_SENATE}/Committees/Show/${code.toUpperCase()}/${session}`,
      });
  });
  if (!found.size) throw new Error('Senate committee directory did not expose its source links');
  return [...found.values()];
}

export function senateNoticeRefs(
  html: string,
  bodyCode: string,
  bodyName: string,
  window?: { from: string; to: string },
): { notices: SenateNoticeRef[]; issues: string[] } {
  const $ = load(html),
    notices: SenateNoticeRef[] = [],
    issues: string[] = [];
  if (!$('#meetingsTbl').length) {
    if (/no meetings|no meeting records/i.test($('#tabBodyMeetings').text()))
      return { notices, issues };
    // An unreadable layout is a source failure, unlike a readable row whose
    // event identity still needs qualification. Never assert empty coverage.
    throw new Error('Senate meeting table unavailable');
  }
  $('#meetingsTbl tbody tr').each((_, tr) => {
    const tds = $(tr).find('td'),
      date = floridaDate(clean(tds.eq(0).text()));
    if (date && window && (date < window.from || date > window.to)) return;
    const href = $(tr).find('a.mtgrecord_notice').attr('href');
    const noticeId = /\/MeetingNotice\/(\d+)/i.exec(href ?? '')?.[1];
    if (!date || !noticeId || !href) {
      issues.push(`Unresolved Senate notice row: ${clean(tds.eq(0).text())}`);
      return;
    }
    const sourceUrl = new URL(href, FL_SENATE).href;
    const documents: CalendarDocument[] = [];
    $(tr)
      .find('a[href]')
      .each((__, a) => {
        const url = new URL($(a).attr('href')!, FL_SENATE).href;
        if (/MeetingNotice|DownloadMeetingDocument|ExpandedAgenda|AttendanceReport/i.test(url))
          documents.push({
            key: url,
            title: clean($(a).text()),
            url,
            kind: /MeetingNotice/.test(url)
              ? 'notice'
              : /ExpandedAgenda/.test(url)
                ? 'expanded_agenda'
                : /AttendanceReport/.test(url)
                  ? 'attendance'
                  : 'packet',
            publishedAt: null,
          });
      });
    const watch = $(tr).find('a.mtgrecord_video').attr('href');
    notices.push({
      id: noticeId,
      bodyCode,
      bodyName,
      date,
      rawTime: clean(tds.eq(1).text()),
      sourceUrl,
      documents,
      watchUrl: watch ? new URL(watch, FL_SENATE).href : null,
      canceled: /cancelled|canceled|not meeting/i.test(tds.eq(2).text()),
    });
  });
  return { notices, issues };
}

/** The daily page includes bodies (notably SOCG) absent from the committee directory. */
export function senateDailyCalendar(html: string, date: string, session: string) {
  const $ = load(html),
    notices: SenateNoticeRef[] = [],
    floors: LegislativeObservation[] = [],
    issues: string[] = [];
  const header = clean($('.calHeader h2').text())
    .replace(/Open Calendar.*$/, '')
    .trim();
  if (headingDate(header) !== date) throw new Error('Senate daily calendar date mismatch');
  if (!$('#CalendarContents').length) {
    if (/No events scheduled for this day\./i.test($('#tabCalendar').text()))
      return { notices, floors, issues, unresolved: 0 };
    throw new Error('Senate daily calendar unavailable');
  }
  let unresolved = 0;
  $('#CalendarContents .event').each((_, el) => {
    const event = $(el),
      bodyName = clean(event.find('.eventtitle').text());
    const rawTime = clean(event.closest('.eventGroupContainer').find('h4').first().text());
    const href = event.find('a[href*="/MeetingNotice/"]').attr('href');
    const match = /\/Committees\/Show\/([A-Za-z]+)\/MeetingNotice\/(\d+)/.exec(href ?? '');
    const documents: CalendarDocument[] = [];
    event.find('.MeetingRecords a[href]').each((__, a) => {
      const url = new URL($(a).attr('href')!, FL_SENATE).href;
      if (/MeetingNotice|DownloadMeetingDocument|ExpandedAgenda|\/Session\/Calendar\//i.test(url))
        documents.push({
          key: url,
          title: clean($(a).text()),
          url,
          kind: /MeetingNotice/.test(url) ? 'notice' : 'packet',
          publishedAt: null,
        });
    });
    const watch = event.find('a[href*="/VideoPlayer/"]').attr('href');
    const watchUrl = watch ? new URL(watch, FL_SENATE).href : null;
    const canceled = /cancelled|canceled|not meeting/i.test(event.find('.location').text());
    if (match) {
      notices.push({
        id: match[2]!,
        bodyCode: match[1]!.toUpperCase(),
        bodyName,
        date,
        rawTime,
        sourceUrl: new URL(href!, FL_SENATE).href,
        documents,
        watchUrl,
        canceled,
      });
      return;
    }
    const floorHref = event.find('.FLOORBILLS a[href]').attr('href');
    if (floorHref && /^SESSION$/i.test(bodyName)) {
      // The publisher identifies a floor DAY by this URL. Do not infer that a
      // different day's sitting is a reschedule or a separate committee event.
      const floorDate = /\/Home\/(\d{1,2})-(\d{1,2})-(\d{4})/.exec(floorHref);
      const publishedSession = documents
        .map((d) => /\/Session\/Calendar\/(\d{4})\//.exec(d.url)?.[1])
        .find(Boolean);
      if (
        !floorDate ||
        floridaDate(`${floorDate[1]}/${floorDate[2]}/${floorDate[3]}`) !== date ||
        publishedSession !== session ||
        floors.length
      ) {
        unresolved++;
        issues.push(`${date}: floor day/session identity requires review`);
        return;
      }
      const range = rawTime.match(/^(.*?)\s+[—–-]\s+(.*?)$/);
      const time = range ? localTime(date, range[1]!, range[2]!) : localTime(date, rawTime);
      time.rawTime = rawTime;
      const sourceUrl = `${FL_SENATE}/Home/${Number(floorDate[1])}-${Number(floorDate[2])}-${floorDate[3]}?Tab=SenateFloor`;
      floors.push({
        jurisdiction: 'FL',
        session,
        chamber: 'senate',
        officialIdentity: `fl:senate:floor-day:${date}`,
        bodySourceKey: 'fl:senate:floor',
        bodyName: 'Florida Senate',
        stateCommitteeId: null,
        eventType: 'floor',
        sourceUrl,
        publishedAt: null,
        completeness: 'partial',
        issues: [
          'Floor schedule qualified; ordered floor agenda is not yet qualified. Open the published daily calendar.',
        ],
        completeFields: ['title', 'status', 'time', 'location', 'documents', 'watchUrl'],
        fields: {
          title: 'Florida Senate floor sitting',
          status: canceled ? 'canceled' : 'scheduled',
          time,
          location: clean(event.find('.location').text()).replace(/^Location:\s*/i, '') || null,
          documents,
          watchUrl,
        },
      });
      return;
    }
    unresolved++;
    issues.push(`${date}: unresolved calendar entry: ${bodyName || 'unnamed event'}`);
  });
  return { notices, floors, issues, unresolved };
}

export function houseDailyCalendar(html: string, date: string, session: string) {
  const $ = load(html),
    issues: string[] = [],
    floors: LegislativeObservation[] = [];
  let unresolved = 0;
  if (!$('.schedule-list').length) {
    // On quiet days the publisher omits the list and supplies an explicit
    // empty state. Qualify it only for the day in its own dated heading.
    const heading = $('h1,h2,h3')
      .toArray()
      .map((el) => clean($(el).text()))
      .find((value) => /^House Schedule for /i.test(value));
    const published = heading ? headingDate(heading.replace(/^House Schedule for /i, '')) : null;
    if (
      published === date &&
      /No scheduled events before the house\./i.test(clean($.root().text()))
    )
      return { floors, issues, unresolved };
    throw new Error('House schedule list unavailable or its dated empty state does not match');
  }
  $('.schedule-list .schedule-event').each((_, el) => {
    const event = $(el);
    if (event.find('a[href*="MeetingId="]').length) return;
    const title = clean(event.find('.scheduled-event-title').text());
    const day = /^House\s*-\s*(\d+)(?:st|nd|rd|th) Day of Regular Session$/i.exec(title);
    const info = event.find('.meeting-info span');
    const publishedDate = floridaDate(clean(info.eq(0).text()));
    if (
      !day ||
      publishedDate !== date ||
      date.slice(0, 4) !== session ||
      floors.some((o) => o.officialIdentity.endsWith(`:day:${day[1]}`))
    ) {
      unresolved++;
      issues.push(`${date}: unresolved schedule entry: ${title || 'unnamed event'}`);
      return;
    }
    const rawTime = clean(info.eq(1).text()),
      range = rawTime.match(/^(.*?)\s+[—–-]\s+(.*?)$/);
    const time = range ? localTime(date, range[1]!, range[2]!) : localTime(date, rawTime);
    time.rawTime = rawTime;
    const sourceUrl = `${FL_HOUSE}/Sections/HouseSchedule/houseschedule.aspx?date=${Number(date.slice(5, 7))}-${Number(date.slice(8, 10))}-${session}`;
    const watch = event.find('a[href*="VideoPlayer.aspx"]').attr('href');
    floors.push({
      jurisdiction: 'FL',
      session,
      chamber: 'house',
      officialIdentity: `fl:house:regular:${session}:day:${day[1]}`,
      bodySourceKey: 'fl:house:floor',
      bodyName: 'Florida House',
      stateCommitteeId: null,
      eventType: 'floor',
      sourceUrl,
      publishedAt: null,
      completeness: 'partial',
      issues: [
        'Floor schedule qualified; ordered floor agenda is not yet qualified. Open the published House calendar.',
      ],
      completeFields: ['title', 'status', 'time', 'location', 'documents', 'watchUrl'],
      fields: {
        title,
        status: /cancelled|canceled|not meeting/i.test(event.find('.meeting-info').text())
          ? 'canceled'
          : 'scheduled',
        time,
        location: clean(info.eq(2).text()) || null,
        documents: [
          {
            key: sourceUrl,
            title: 'Published House daily schedule',
            url: sourceUrl,
            kind: 'schedule',
            publishedAt: null,
            publishedText: clean(event.text()),
          },
        ],
        watchUrl: watch ? new URL(watch, FL_HOUSE).href : null,
      },
    });
  });
  return { floors, issues, unresolved };
}

/** Parse all pages of the published notice, not the aggregator's partial bill list. */
export function senateNoticeObservation(
  ref: SenateNoticeRef,
  text: string,
  session: string,
): LegislativeObservation {
  if (!/(?:COMMITTEE\s+)?MEETING\s+NOTICE/i.test(text))
    throw new Error('Unrecognized Senate meeting notice');
  const issues: string[] = [];
  const place = /PLACE:\s*([^\n]+)/i.exec(text)?.[1];
  const printedTime = /\bTIME:\s*([^\n]+)/i.exec(text)?.[1]?.trim();
  const range = printedTime
    ?.replace(/\bnoon\b/gi, 'p.m.')
    .replace(/\bmidnight\b/gi, 'a.m.')
    .match(
      /(\d{1,2}:\d{2})\s*(a\.?m\.?|p\.?m\.?)?\s*[–—\-�]\s*(\d{1,2}:\d{2})\s*(a\.?m\.?|p\.?m\.?)/i,
    );
  const time = range
    ? localTime(ref.date, `${range[1]} ${range[2] ?? range[4]}`, `${range[3]} ${range[4]}`)
    : localTime(ref.date, printedTime ?? ref.rawTime);
  time.rawTime = printedTime ?? ref.rawTime;
  const normalized = text.replace(/\r/g, '');
  const billLines = [
    ...normalized.matchAll(
      /^\s*((?:CS\/)*(?:SB|HB|SPB|PCB|SJR|HJR|SM|HM|SCR|HCR|SR|HR)\s+\d+)\s+by\s+([^\n]+)/gm,
    ),
  ];
  const agenda: AgendaItem[] = billLines.map((m, i) => ({
    key: `bill:${m[1]!.replace(/\s+/g, '')}`,
    position: i,
    kind: 'unresolved_bill',
    title: clean(`${m[1]} ${m[2]}`),
    sourceUrl: ref.sourceUrl,
    evidence: { identifier: m[1], source: 'Florida Senate published meeting notice' },
  }));
  // Confirmations and presentations are agenda business even without bills.
  // Preserve their published section and source text, never synthesize a bill.
  const businessOccurrences = new Map<string, number>();
  for (const m of normalized.matchAll(
    /^\s*((?:Senate Confirmation Hearing|Presentation|Discussion|Workshop|To set the Special Order Calendar|Other Business|Consideration of (?!the following bill))[^\n]*)/gim,
  )) {
    const baseKey = `business:${contentHash(clean(m[1]!)).slice(0, 24)}`;
    const occurrence = (businessOccurrences.get(baseKey) ?? 0) + 1;
    businessOccurrences.set(baseKey, occurrence);
    agenda.push({
      // Repeated headings introduce distinct business (e.g. SPB 7046/7048 in
      // notice 6890). Retain both, without changing existing unique keys.
      key: occurrence === 1 ? baseKey : `${baseKey}:${occurrence}`,
      position: agenda.length,
      kind: /presentation/i.test(m[1]!) ? 'presentation' : 'other',
      title: clean(m[1]!),
      sourceUrl: ref.sourceUrl,
      evidence: {
        publishedText: normalized.slice(m.index).slice(0, 100000),
        sourcePosition: m.index,
      },
    });
  }
  agenda.sort(
    (a, b) =>
      Number(
        a.evidence.sourcePosition ??
          billLines.find((m) => `bill:${m[1]!.replace(/\s+/g, '')}` === a.key)?.index ??
          0,
      ) -
      Number(
        b.evidence.sourcePosition ??
          billLines.find((m) => `bill:${m[1]!.replace(/\s+/g, '')}` === b.key)?.index ??
          0,
      ),
  );
  agenda.forEach((item, position) => {
    item.position = position;
  });
  if (
    !agenda.length &&
    !/presentation|discussion|workshop|confirmation|consideration|To set the Special Order Calendar|no bills|other business|not meeting|cancel/i.test(
      text,
    )
  )
    issues.push('Notice agenda could not be qualified');
  const stamp = /\b(\d{2})(\d{2})(\d{4})\.(\d{2})(\d{2})\b/.exec(text);
  const publishedTime = stamp
    ? localTime(
        `${stamp[3]}-${stamp[1]}-${stamp[2]}`,
        `${Number(stamp[4]) % 12 || 12}:${stamp[5]} ${Number(stamp[4]) >= 12 ? 'PM' : 'AM'}`,
      ).startsAt
    : null;
  const o: LegislativeObservation = {
    jurisdiction: 'FL',
    session: /\b(\d{4}) Regular Session\b/.exec(text)?.[1] ?? session,
    chamber: ref.bodyCode === 'JLBC' ? 'joint' : 'senate',
    officialIdentity: `fl:senate:meeting:${ref.id}`,
    bodySourceKey: ref.bodyCode === 'JLBC' ? 'fl:joint:lbc' : `fl:senate:${ref.bodyCode}`,
    bodyName: ref.bodyName,
    stateCommitteeId: null,
    eventType: ref.bodyCode === 'JLBC' ? 'joint' : 'committee',
    sourceUrl: ref.sourceUrl,
    publishedAt: publishedTime,
    completeFields: ['title', 'status', 'time', 'documents', 'watchUrl'],
    completeness: issues.length ? 'partial' : 'complete',
    issues,
    fields: {
      title: ref.bodyName,
      status: ref.canceled || /MEETING\s+CANCEL(?:L)?ED/i.test(text) ? 'canceled' : 'scheduled',
      time,
      documents: ref.documents,
      watchUrl: ref.watchUrl,
    },
  };
  if (place) {
    o.fields.location = clean(place);
    o.completeFields.push('location');
  }
  if (!issues.length) {
    o.fields.agenda = agenda;
    o.completeFields.push('agenda');
  }
  // Source text is preserved with the original notice, including amendment
  // deadlines; no deadline is inferred for notices that do not publish one.
  o.fields.documents = ref.documents.map((d) =>
    d.url === ref.sourceUrl
      ? {
          ...d,
          publishedAt: publishedTime,
          contentHash: contentHash(text),
          publishedText: normalized,
          deadlines: [
            ...normalized.matchAll(/AMENDMENT\s+([\s\S]*?)(?=\s+MEMBERS:|\n\s*SB\s|$)/gi),
          ].map((m) => clean(m[1]!)),
        }
      : d,
  );
  return qualifiedJointNotice(o);
}

/** Exact first-party crosswalk reviewed September 11, 2026. Both notices name
 * the same joint body, co-chairs, 11–2 sitting in 110 Senate Building and budget
 * amendment agenda. This is one observed pair, never a name/date merge rule.
 * The Senate PDF says 2027 Regular Session; the House breadcrumb says 2026.
 * Preserve that conflict instead of assigning a regular session to this joint sitting.
 */
function qualifiedJointNotice(o: LegislativeObservation): LegislativeObservation {
  const senate = `${FL_SENATE}/Committees/Show/JLBC/MeetingNotice/6914`;
  const house = `${FL_HOUSE}/Sections/Committees/meetingnotice.aspx?MeetingId=15223`;
  if (o.bodySourceKey !== 'fl:joint:lbc' || ![senate, house].includes(o.sourceUrl)) return o;
  if (o.session !== null && !['2026', '2027'].includes(o.session)) {
    o.issues.push('Qualified joint notice session conflicts with its source crosswalk');
    o.completeness = 'partial';
    return o;
  }
  o.session = null;
  o.completeness = 'partial';
  o.issues.push(
    'Joint notice publisher session conflict: House 2026, Senate 2027. Canonical session remains unknown.',
  );
  o.officialIdentity = 'fl:joint:lbc:notice:6914-15223';
  for (const [url, title] of [
    [senate, 'Senate joint meeting notice'],
    [house, 'House joint meeting notice'],
  ]) {
    if (!o.fields.documents?.some((d) => d.url === url))
      o.fields.documents = [
        ...(o.fields.documents ?? []),
        { key: url!, url: url!, title: title!, kind: 'notice', publishedAt: null },
      ];
  }
  return o;
}

export function houseNoticeLinks(html: string): string[] {
  const $ = load(html),
    urls = new Set<string>();
  $('a[href*="meetingnotice.aspx"]').each((_, a) => {
    const u = new URL($(a).attr('href')!, FL_HOUSE);
    if (u.hostname === 'www.flhouse.gov' && /^\d+$/.test(u.searchParams.get('MeetingId') ?? ''))
      urls.add(u.href);
  });
  return [...urls];
}

export function houseNoticeObservation(
  html: string,
  sourceUrl: string,
  session: string | null,
): LegislativeObservation {
  const $ = load(html),
    id = new URL(sourceUrl).searchParams.get('MeetingId');
  const bodyName = clean($('h1.ribbon').text());
  if (!id || !bodyName || !$('dl[aria-label="Meeting Information"]').length)
    throw new Error('House notice layout unavailable');
  const values = new Map<string, string>();
  $('dl[aria-label="Meeting Information"] dt').each((_, dt) => {
    values.set(clean($(dt).text()), clean($(dt).next('dd').text()));
  });
  const times = $('dl[aria-label="Meeting Information"] time')
    .toArray()
    .map((t) => $(t).attr('datetime') ?? '');
  const first = times[0],
    rawStart = values.get('Start Date and Time:') ?? '';
  const printedDay =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(
      rawStart,
    );
  const printedDate = printedDay
    ? `${printedDay[3]}-${String(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(printedDay[1]!.toLowerCase()) + 1).padStart(2, '0')}-${printedDay[2]!.padStart(2, '0')}`
    : '';
  const date = (first ? floridaDate(first) : null) ?? floridaDate(printedDate);
  if (!date) throw new Error('House notice lacks a qualified calendar date');
  const uncertain = /upon|adjourn|after|to be (determined|announced)|\bTBD\b/i.test(rawStart);
  const zonedInstant = (value: string | undefined) =>
    value &&
    /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value))
      ? new Date(value).toISOString()
      : null;
  const validStart = uncertain ? null : zonedInstant(first);
  const validEnd = zonedInstant(times[1]);
  const joint = /joint legislative budget commission/i.test(bodyName);
  const committeeHref = $('a[href*="CommitteeId="]').first().attr('href');
  const committeeId = committeeHref
    ? new URL(committeeHref, FL_HOUSE).searchParams.get('CommitteeId')
    : null;
  const agenda: AgendaItem[] = [];
  // The notice's breadcrumb supplies a source session id. Resolve it using
  // the page's own session selector; the globally selected year alone is not
  // evidence for this notice (especially for special sessions).
  const sessionHref = $('nav[aria-label="Breadcrumb"] a[href*="sessionId="]').attr('href');
  const sessionId = sessionHref
    ? new URL(sessionHref, FL_HOUSE).searchParams.get('sessionId')
    : null;
  const scopedSession = sessionId
    ? clean($(`select#ddlBillFinderSession option[value="${sessionId}"]`).text())
    : '';
  if (/^\d{4}[A-Z]?$/.test(scopedSession)) session = scopedSession;
  $('.meeting-actions-bills section li').each((_, li) => {
    const line = clean($(li).text());
    const identifier = /^((?:CS\/)*(?:HB|SB|PCB|SPB|HJR|SJR|HM|SM|HCR|SCR|HR|SR)\s+\d+)\b/i.exec(
      line,
    )?.[1];
    agenda.push({
      key: identifier
        ? `bill:${identifier.replace(/\s+/g, '')}`
        : `item:${contentHash(line).slice(0, 24)}`,
      position: agenda.length,
      kind: identifier ? 'unresolved_bill' : 'other',
      title: line,
      sourceUrl,
      evidence: identifier ? { identifier, sessionId } : { publishedText: line, sessionId },
    });
  });
  const summary = $('#meeting-summary').next('div').clone();
  summary.find('br').replaceWith('\n');
  for (const line of summary.text().split(/\n+/).map(clean).filter(Boolean)) {
    const identifier = /^((?:CS\/)*(?:HB|SB|PCB|SPB|HJR|SJR|HM|SM|HCR|SCR|HR|SR)\s+\d+)\b/i.exec(
      line,
    )?.[1];
    agenda.push({
      key: `item:${contentHash(line).slice(0, 24)}:${agenda.length}`,
      position: agenda.length,
      kind: identifier ? 'unresolved_bill' : 'other',
      title: line,
      sourceUrl,
      evidence: identifier ? { identifier } : { publishedText: line },
    });
  }
  const fields: LegislativeObservation['fields'] = {
    title: bodyName,
    status: /\b(cancelled|canceled|not meeting)\b/i.test($('.cm_contents').text())
      ? 'canceled'
      : 'scheduled',
    time: {
      date,
      rawTime: values.get('Start Date and Time:') ?? null,
      timezone: 'America/New_York',
      precision: validStart
        ? 'instant'
        : /upon|adjourn|after/i.test(rawStart)
          ? 'relative'
          : 'date',
      startsAt: validStart,
      endsAt: validStart && validEnd && validEnd > validStart ? validEnd : null,
    },
    location: values.get('Location:') ?? null,
    agenda,
    documents: [
      {
        key: sourceUrl,
        title: 'Published meeting notice',
        url: sourceUrl,
        kind: 'notice',
        publishedAt: null,
        contentHash: contentHash($('.cm_contents').text()),
        publishedText: clean($('.cm_contents').text()),
      },
    ],
  };
  const issues =
    !agenda.length && !$('.meeting-actions-bills section, #meeting-summary').length
      ? ['House agenda section unavailable']
      : [];
  return qualifiedJointNotice({
    jurisdiction: 'FL',
    session,
    chamber: joint ? 'joint' : 'house',
    officialIdentity: `fl:house:meeting:${id}`,
    bodySourceKey: joint
      ? 'fl:joint:lbc'
      : committeeId
        ? `fl:house:committee:${committeeId}`
        : `fl:house:unresolved-body:${id}`,
    bodyName,
    stateCommitteeId: null,
    eventType: joint ? 'joint' : 'committee',
    sourceUrl,
    publishedAt: null,
    completeFields: [
      'title',
      'status',
      'time',
      'location',
      'documents',
      ...(!issues.length ? ['agenda' as const] : []),
    ],
    completeness: issues.length ? 'partial' : 'complete',
    issues,
    fields,
  });
}

/** Source reads are restricted to the two qualified first-party hosts, bounded
 * and checked after redirects. No provider secret appears in the URL. */
export async function fetchFloridaSource(url: string): Promise<Uint8Array> {
  const allowed = (u: string) => {
    const p = new URL(u);
    return (
      p.protocol === 'https:' &&
      [new URL(FL_SENATE).hostname, new URL(FL_HOUSE).hostname].includes(p.hostname)
    );
  };
  if (!allowed(url)) throw new Error('Unsupported Florida source URL');
  let current = url;
  for (let redirects = 0; redirects < 4; redirects++) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      if (![429, 502, 503, 504].includes(response.status) || attempt === 2) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            10000,
            Math.max(
              1000,
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 1000 * 2 ** attempt,
            ),
          ),
        ),
      );
    }
    if (!response) throw new Error('Florida source response unavailable');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      current = new URL(response.headers.get('location') ?? '', current).href;
      if (!allowed(current)) throw new Error('Florida source redirected outside qualified hosts');
      continue;
    }
    if (!response.ok) throw new Error(`Florida source HTTP ${response.status}`);
    if (Number(response.headers.get('content-length') ?? 0) > 20_000_000)
      throw new Error('Florida source too large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Florida source has no body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 20_000_000) {
        await reader.cancel();
        throw new Error('Florida source too large');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Some publisher edge filters return HTTP 200 with a denial page. Keep
    // that outcome visible as access failure, not a parser or empty-day result.
    // Inspect a bounded prefix, and do not expose support identifiers/content.
    const prefix = new TextDecoder().decode(bytes.subarray(0, 8192));
    if (
      /^\s*(?:<!doctype html[^>]*>\s*)?<html\b/i.test(prefix) &&
      (/<title>\s*(?:Request Rejected|Access Denied)\s*<\/title>/i.test(prefix) ||
        /The requested URL was rejected\. Please consult with your administrator\./i.test(prefix))
    )
      throw new Error('Florida publisher access denied (HTTP 200 rejection page)');
    return bytes;
  }
  throw new Error('Florida source redirect limit exceeded');
}
