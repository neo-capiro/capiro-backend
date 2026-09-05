/**
 * LegiWatch V2 Wave 1 (W1-8) — calendar export tests.
 *
 * The required scenarios are Eastern, Pacific, DST, unknown time, all-day /
 * date-only, special characters, multiline description, canceled hearing,
 * stable UID, and CRLF formatting. Each has its own block below.
 *
 * The date/time cases exist because of a real shipped regression: a date-only
 * hearing rendered as "8:00 PM" on the PREVIOUS day after being parsed as
 * midnight UTC. These assert the ICS form that cannot reproduce it.
 */
import {
  buildCalendarExport,
  calendarDayParts,
  calendarUid,
  escapeIcsText,
  foldIcsLine,
  icsDate,
  icsInstant,
  type CalendarExportHearing,
} from './legiwatch-calendar-export.js';

const APP_ORIGIN = 'https://os.capiro.ai';
const NOW = new Date('2026-09-04T12:00:00.000Z');
const OPTS = { appOrigin: APP_ORIGIN, now: NOW };

function hearing(overrides: Partial<CalendarExportHearing> = {}): CalendarExportHearing {
  return {
    id: 'cm-119-900001',
    title: 'Oversight of Federal Acquisition Policy',
    date: '2026-09-10',
    startsAt: '2026-09-10T14:00:00.000Z', // 10:00 ET (EDT, UTC-4)
    time: '10:00 AM',
    timezone: 'America/New_York',
    location: 'Rayburn House Office Building 2118',
    committeeName: 'Committee on Armed Services',
    chamber: 'House',
    url: 'https://armedservices.house.gov/hearings/oversight',
    eventStatus: 'scheduled',
    ...overrides,
  };
}

/** Pull one unfolded property value out of an ICS body. */
function prop(ics: string, name: string): string | null {
  // Unfold first: RFC 5545 continuation lines start with a single space.
  const unfolded = ics.replace(/\r\n /g, '');
  for (const line of unfolded.split('\r\n')) {
    if (line === name || line.startsWith(`${name}:`) || line.startsWith(`${name};`)) {
      return line.slice(name.length).replace(/^[;:]/, '');
    }
  }
  return null;
}

function rawLine(ics: string, prefix: string): string | null {
  return ics.split('\r\n').find((l) => l.startsWith(prefix)) ?? null;
}

describe('LegiWatch calendar export — Eastern time', () => {
  it('emits the true instant as a UTC DATE-TIME', () => {
    const { ics, allDay } = buildCalendarExport(hearing(), OPTS);
    expect(allDay).toBe(false);
    // 10:00 EDT == 14:00Z. The instant is emitted as-is; the viewer's client
    // renders it in their own zone.
    expect(rawLine(ics, 'DTSTART:')).toBe('DTSTART:20260910T140000Z');
  });

  it('defaults DTEND to a two-hour block when no end is published', () => {
    const { ics } = buildCalendarExport(hearing({ actualEnd: null }), OPTS);
    expect(rawLine(ics, 'DTEND:')).toBe('DTEND:20260910T160000Z');
  });

  it('uses a published end instant when one exists', () => {
    const { ics } = buildCalendarExport(
      hearing({ actualEnd: '2026-09-10T17:30:00.000Z' }),
      OPTS,
    );
    expect(rawLine(ics, 'DTEND:')).toBe('DTEND:20260910T173000Z');
  });

  it('reports the source wall clock and zone label in the description', () => {
    const { ics } = buildCalendarExport(hearing(), OPTS);
    expect(prop(ics, 'DESCRIPTION')).toContain('Scheduled: 10:00 AM ET');
  });
});

describe('LegiWatch calendar export — Pacific time', () => {
  const pacific = hearing({
    id: 'cm-119-900002',
    // 1:00 PM PDT == 20:00Z
    startsAt: '2026-09-10T20:00:00.000Z',
    time: '1:00 PM',
    timezone: 'America/Los_Angeles',
    location: 'San Diego Field Hearing',
  });

  it('emits the correct UTC instant for a Pacific-zone event', () => {
    const { ics } = buildCalendarExport(pacific, OPTS);
    expect(rawLine(ics, 'DTSTART:')).toBe('DTSTART:20260910T200000Z');
  });

  it('labels the source zone as PT rather than dropping or Easternizing it', () => {
    const { ics } = buildCalendarExport(pacific, OPTS);
    const description = prop(ics, 'DESCRIPTION') ?? '';
    expect(description).toContain('Scheduled: 1:00 PM PT');
    expect(description).not.toContain('1:00 PM ET');
  });

  it('falls back to the raw IANA zone when there is no short label', () => {
    const { ics } = buildCalendarExport(
      { ...pacific, timezone: 'Asia/Tokyo', time: '9:00 AM' },
      OPTS,
    );
    expect(prop(ics, 'DESCRIPTION')).toContain('Scheduled: 9:00 AM Asia/Tokyo');
  });
});

describe('LegiWatch calendar export — DST', () => {
  it('keeps 10:00 ET correct on the EDT side of the boundary', () => {
    // 2026-11-01 is the US DST end date; 2026-10-30 is still EDT (UTC-4).
    const { ics } = buildCalendarExport(
      hearing({ date: '2026-10-30', startsAt: '2026-10-30T14:00:00.000Z' }),
      OPTS,
    );
    expect(rawLine(ics, 'DTSTART:')).toBe('DTSTART:20261030T140000Z');
  });

  it('keeps 10:00 ET correct on the EST side of the boundary', () => {
    // After DST ends, 10:00 ET is UTC-5, so the same wall clock is 15:00Z.
    // The stored instant differs by an hour and the export must carry that
    // through rather than applying one fixed offset.
    const { ics } = buildCalendarExport(
      hearing({ date: '2026-11-06', startsAt: '2026-11-06T15:00:00.000Z' }),
      OPTS,
    );
    expect(rawLine(ics, 'DTSTART:')).toBe('DTSTART:20261106T150000Z');
  });

  it('does not shift an all-day event across the DST boundary', () => {
    const { ics } = buildCalendarExport(
      hearing({ date: '2026-11-01', startsAt: null, time: null }),
      OPTS,
    );
    // A VALUE=DATE has no zone, so the DST transition is irrelevant to it.
    expect(rawLine(ics, 'DTSTART;VALUE=DATE:')).toBe('DTSTART;VALUE=DATE:20261101');
    expect(rawLine(ics, 'DTEND;VALUE=DATE:')).toBe('DTEND;VALUE=DATE:20261102');
  });
});

describe('LegiWatch calendar export — unknown time / date-only', () => {
  const dateOnly = hearing({ id: 'cm-119-900003', startsAt: null, time: null });

  it('emits an all-day VALUE=DATE event and never a fabricated time', () => {
    const { ics, allDay } = buildCalendarExport(dateOnly, OPTS);
    expect(allDay).toBe(true);
    expect(rawLine(ics, 'DTSTART;VALUE=DATE:')).toBe('DTSTART;VALUE=DATE:20260910');
    // The regression guard: no DATE-TIME form, and specifically no midnight UTC.
    expect(ics).not.toContain('DTSTART:');
    expect(ics).not.toContain('T000000Z');
  });

  it('uses an exclusive next-day DTEND per RFC 5545', () => {
    const { ics } = buildCalendarExport(dateOnly, OPTS);
    expect(rawLine(ics, 'DTEND;VALUE=DATE:')).toBe('DTEND;VALUE=DATE:20260911');
  });

  it('says the time is not announced rather than leaving a bare all-day block', () => {
    const { ics } = buildCalendarExport(dateOnly, OPTS);
    const description = prop(ics, 'DESCRIPTION') ?? '';
    expect(description).toContain('Time: not announced by the committee.');
    expect(description).not.toContain('Scheduled:');
  });

  it('does not shift the day at a month boundary', () => {
    const { ics } = buildCalendarExport(
      hearing({ date: '2026-10-01', startsAt: null, time: null }),
      OPTS,
    );
    expect(rawLine(ics, 'DTSTART;VALUE=DATE:')).toBe('DTSTART;VALUE=DATE:20261001');
    expect(rawLine(ics, 'DTEND;VALUE=DATE:')).toBe('DTEND;VALUE=DATE:20261002');
    expect(ics).not.toContain('20260930');
  });

  it('does not shift the day at a year boundary', () => {
    const { ics } = buildCalendarExport(
      hearing({ date: '2026-12-31', startsAt: null, time: null }),
      OPTS,
    );
    expect(rawLine(ics, 'DTSTART;VALUE=DATE:')).toBe('DTSTART;VALUE=DATE:20261231');
    expect(rawLine(ics, 'DTEND;VALUE=DATE:')).toBe('DTEND;VALUE=DATE:20270101');
  });

  it('treats an unparseable startsAt as date-only rather than inventing an instant', () => {
    const { allDay, ics } = buildCalendarExport(
      hearing({ startsAt: 'not-a-timestamp', time: null }),
      OPTS,
    );
    expect(allDay).toBe(true);
    expect(rawLine(ics, 'DTSTART;VALUE=DATE:')).toBe('DTSTART;VALUE=DATE:20260910');
  });

  it('refuses to export a hearing with no usable calendar day', () => {
    expect(() =>
      buildCalendarExport(hearing({ date: '', startsAt: null }), OPTS),
    ).toThrow(/no usable calendar date/);
  });

  it('rejects an impossible calendar day instead of normalizing it forward', () => {
    expect(calendarDayParts('2026-02-31')).toBeNull();
    expect(calendarDayParts('2026-13-01')).toBeNull();
    expect(calendarDayParts('2026-09-10')).toEqual({ y: 2026, m: 9, d: 10 });
  });
});

describe('LegiWatch calendar export — special characters', () => {
  it('escapes backslash, semicolon and comma per RFC 5545 §3.3.11', () => {
    expect(escapeIcsText('a;b,c\\d')).toBe('a\\;b\\,c\\\\d');
  });

  it('escapes the backslash first so escapes are not double-escaped', () => {
    // Naively escaping ';' before '\' would turn 'a;b' into 'a\\;b'.
    expect(escapeIcsText('a;b')).toBe('a\\;b');
    expect(escapeIcsText('\\')).toBe('\\\\');
  });

  it('escapes a title containing separators and quotes', () => {
    const { ics } = buildCalendarExport(
      hearing({
        title: 'Markup of H.R. 1234; H.R. 5678, and S. 9 — "Reform, Act"',
        location: 'Dirksen; Room SD-106, Washington, DC',
      }),
      OPTS,
    );
    expect(prop(ics, 'SUMMARY')).toBe(
      'Markup of H.R. 1234\\; H.R. 5678\\, and S. 9 — "Reform\\, Act"',
    );
    expect(prop(ics, 'LOCATION')).toBe('Dirksen\\; Room SD-106\\, Washington\\, DC');
  });

  it('preserves non-ASCII characters without splitting them across a fold', () => {
    const title = `Hearing on Café Operations ${'é'.repeat(60)}`;
    const { ics } = buildCalendarExport(hearing({ title }), OPTS);
    // Round-tripping through unfold must return the exact original title.
    expect(prop(ics, 'SUMMARY')).toBe(title);
    for (const line of ics.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
  });
});

describe('LegiWatch calendar export — multiline description', () => {
  it('carries real newlines as the literal two-character \\n sequence', () => {
    expect(escapeIcsText('one\ntwo')).toBe('one\\ntwo');
    expect(escapeIcsText('one\r\ntwo')).toBe('one\\ntwo');
    expect(escapeIcsText('one\rtwo')).toBe('one\\ntwo');
  });

  it('never emits a bare CR or LF inside the DESCRIPTION value', () => {
    const { ics } = buildCalendarExport(hearing(), OPTS);
    const unfolded = ics.replace(/\r\n /g, '');
    const line = unfolded.split('\r\n').find((l) => l.startsWith('DESCRIPTION:'))!;
    // Every real break in the value is the escaped sequence, not a raw newline.
    expect(line).toContain('\\n');
    expect(line.slice('DESCRIPTION:'.length)).not.toMatch(/[\r\n]/);
  });

  it('includes the committee, chamber, canonical link and official source', () => {
    const { ics, detailUrl } = buildCalendarExport(hearing(), OPTS);
    const description = prop(ics, 'DESCRIPTION') ?? '';
    expect(description).toContain('Committee: Committee on Armed Services');
    expect(description).toContain('Chamber: House');
    expect(description).toContain(`View in Capiro: ${detailUrl}`);
    expect(description).toContain(
      'Official source: https://armedservices.house.gov/hearings/oversight',
    );
  });

  it('omits the official source line when the source published no page', () => {
    const { ics } = buildCalendarExport(hearing({ url: null }), OPTS);
    expect(prop(ics, 'DESCRIPTION')).not.toContain('Official source:');
  });

  it('does not repeat the committee name when the subcommittee matches it', () => {
    const { ics } = buildCalendarExport(
      hearing({
        committeeName: 'Committee on Armed Services',
        subcommitteeName: 'Committee on Armed Services',
      }),
      OPTS,
    );
    expect(prop(ics, 'DESCRIPTION')).toContain(
      'Committee: Committee on Armed Services\\n',
    );
  });

  it('joins a distinct subcommittee onto the parent committee', () => {
    const { ics } = buildCalendarExport(
      hearing({ subcommitteeName: 'Subcommittee on Readiness' }),
      OPTS,
    );
    expect(prop(ics, 'DESCRIPTION')).toContain(
      'Committee: Committee on Armed Services — Subcommittee on Readiness',
    );
  });
});

describe('LegiWatch calendar export — cancellation', () => {
  it('emits STATUS:CANCELLED and bumps SEQUENCE so the update supersedes', () => {
    const { ics } = buildCalendarExport(hearing({ eventStatus: 'canceled' }), OPTS);
    expect(rawLine(ics, 'STATUS:')).toBe('STATUS:CANCELLED');
    expect(rawLine(ics, 'SEQUENCE:')).toBe('SEQUENCE:1');
  });

  it('marks the summary so the cancellation is visible in a month grid', () => {
    const { ics } = buildCalendarExport(hearing({ eventStatus: 'canceled' }), OPTS);
    expect(prop(ics, 'SUMMARY')).toBe(
      'CANCELED: Oversight of Federal Acquisition Policy',
    );
    expect(prop(ics, 'DESCRIPTION')).toContain(
      'This proceeding was CANCELED by the committee.',
    );
  });

  it('treats a postponed proceeding as TENTATIVE, not cancelled', () => {
    const { ics } = buildCalendarExport(hearing({ eventStatus: 'postponed' }), OPTS);
    expect(rawLine(ics, 'STATUS:')).toBe('STATUS:TENTATIVE');
    expect(rawLine(ics, 'SEQUENCE:')).toBe('SEQUENCE:0');
    expect(prop(ics, 'DESCRIPTION')).toContain(
      'This proceeding was POSTPONED by the committee.',
    );
  });

  it('confirms a scheduled or completed proceeding', () => {
    for (const eventStatus of ['scheduled', 'completed', 'in_progress', null]) {
      const { ics } = buildCalendarExport(hearing({ eventStatus }), OPTS);
      expect(rawLine(ics, 'STATUS:')).toBe('STATUS:CONFIRMED');
    }
  });

  it('keeps the cancelled UID identical to the original so clients match them', () => {
    const scheduled = buildCalendarExport(hearing(), OPTS);
    const canceled = buildCalendarExport(hearing({ eventStatus: 'canceled' }), OPTS);
    expect(canceled.uid).toBe(scheduled.uid);
  });
});

describe('LegiWatch calendar export — stable UID', () => {
  it('derives the UID only from the canonical hearing id', () => {
    expect(calendarUid('cm-119-900001')).toBe(
      'legiwatch-hearing-cm-119-900001@legiwatch.capiro.ai',
    );
  });

  it('returns the same UID across exports at different times', () => {
    const a = buildCalendarExport(hearing(), { appOrigin: APP_ORIGIN, now: NOW });
    const b = buildCalendarExport(hearing(), {
      appOrigin: APP_ORIGIN,
      now: new Date('2027-03-01T09:30:00.000Z'),
    });
    expect(a.uid).toBe(b.uid);
    // DTSTAMP is the only thing that moved.
    expect(rawLine(a.ics, 'DTSTAMP:')).not.toBe(rawLine(b.ics, 'DTSTAMP:'));
  });

  it('keeps the UID stable when mutable hearing fields change', () => {
    const original = buildCalendarExport(hearing(), OPTS);
    const rescheduled = buildCalendarExport(
      hearing({
        title: 'RESCHEDULED — Oversight of Federal Acquisition Policy',
        date: '2026-09-17',
        startsAt: '2026-09-17T18:00:00.000Z',
        location: 'Dirksen SD-106',
      }),
      OPTS,
    );
    expect(rescheduled.uid).toBe(original.uid);
  });

  it('gives different hearings different UIDs', () => {
    const a = buildCalendarExport(hearing({ id: 'cm-119-900001' }), OPTS);
    const b = buildCalendarExport(hearing({ id: 'cm-119-900002' }), OPTS);
    expect(a.uid).not.toBe(b.uid);
  });
});

describe('LegiWatch calendar export — CRLF and structure', () => {
  it('terminates every content line with CRLF, including the last', () => {
    const { ics } = buildCalendarExport(hearing(), OPTS);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // No bare LF anywhere: every LF must be preceded by a CR.
    expect(/(?<!\r)\n/.test(ics)).toBe(false);
  });

  it('opens and closes the VCALENDAR and VEVENT envelopes', () => {
    const { ics } = buildCalendarExport(hearing(), OPTS);
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[1]).toBe('VERSION:2.0');
    expect(lines).toContain('PRODID:-//Capiro//LegiWatch//EN');
    expect(lines).toContain('BEGIN:VEVENT');
    expect(lines).toContain('END:VEVENT');
    expect(lines).toContain('END:VCALENDAR');
  });

  it('folds long content lines to 75 octets with a single leading space', () => {
    const long = `SUMMARY:${'x'.repeat(200)}`;
    const folded = foldIcsLine(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.from(parts[0]!, 'utf8').length).toBe(75);
    for (const cont of parts.slice(1)) {
      expect(cont.startsWith(' ')).toBe(true);
      expect(Buffer.from(cont, 'utf8').length).toBeLessThanOrEqual(75);
    }
    // Unfolding returns the original.
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('leaves a short line unfolded', () => {
    expect(foldIcsLine('STATUS:CONFIRMED')).toBe('STATUS:CONFIRMED');
  });

  it('formats the instant and date primitives without separators', () => {
    expect(icsInstant(new Date('2026-01-02T03:04:05.000Z'))).toBe('20260102T030405Z');
    expect(icsDate({ y: 2026, m: 1, d: 2 })).toBe('20260102');
  });
});

describe('LegiWatch calendar export — canonical link and web calendar URLs', () => {
  it('points URL at the canonical Hearing Detail route', () => {
    const { ics, detailUrl } = buildCalendarExport(hearing(), OPTS);
    expect(detailUrl).toBe('https://os.capiro.ai/legiwatch/hearings/cm-119-900001');
    expect(rawLine(ics, 'URL:')).toBe(`URL:${detailUrl}`);
  });

  it('normalizes a trailing slash on the app origin', () => {
    const { detailUrl } = buildCalendarExport(hearing(), {
      appOrigin: 'https://os.capiro.ai/',
      now: NOW,
    });
    expect(detailUrl).toBe('https://os.capiro.ai/legiwatch/hearings/cm-119-900001');
  });

  it('builds a Google URL with a UTC instant range for a timed hearing', () => {
    const { googleUrl } = buildCalendarExport(hearing({ actualEnd: null }), OPTS);
    const url = new URL(googleUrl);
    expect(url.origin + url.pathname).toBe(
      'https://calendar.google.com/calendar/render',
    );
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('dates')).toBe('20260910T140000Z/20260910T160000Z');
    expect(url.searchParams.get('location')).toBe('Rayburn House Office Building 2118');
  });

  it('builds a Google URL with a zoneless date range for a date-only hearing', () => {
    const { googleUrl } = buildCalendarExport(
      hearing({ startsAt: null, time: null }),
      OPTS,
    );
    expect(new URL(googleUrl).searchParams.get('dates')).toBe('20260910/20260911');
  });

  it('builds an Outlook all-day URL with plain dates, not instants', () => {
    const { outlookUrl } = buildCalendarExport(
      hearing({ startsAt: null, time: null }),
      OPTS,
    );
    const url = new URL(outlookUrl);
    expect(url.searchParams.get('allday')).toBe('true');
    expect(url.searchParams.get('startdt')).toBe('2026-09-10');
    expect(url.searchParams.get('enddt')).toBe('2026-09-11');
    // The midnight-UTC form is exactly what shifts the day in Outlook.
    expect(url.searchParams.get('startdt')).not.toContain('T00:00');
  });

  it('builds an Outlook timed URL with ISO instants', () => {
    const { outlookUrl } = buildCalendarExport(hearing({ actualEnd: null }), OPTS);
    const url = new URL(outlookUrl);
    expect(url.searchParams.get('rru')).toBe('addevent');
    expect(url.searchParams.get('startdt')).toBe('2026-09-10T14:00:00.000Z');
    expect(url.searchParams.get('enddt')).toBe('2026-09-10T16:00:00.000Z');
    expect(url.searchParams.get('allday')).toBeNull();
  });

  it('carries the cancellation into both web calendar URLs', () => {
    const { googleUrl, outlookUrl } = buildCalendarExport(
      hearing({ eventStatus: 'canceled' }),
      OPTS,
    );
    expect(new URL(googleUrl).searchParams.get('text')).toMatch(/^CANCELED: /);
    expect(new URL(outlookUrl).searchParams.get('subject')).toMatch(/^CANCELED: /);
  });

  it('names the download file after the canonical hearing id', () => {
    const { filename } = buildCalendarExport(hearing(), OPTS);
    expect(filename).toBe('legiwatch-hearing-cm-119-900001.ics');
  });
});
