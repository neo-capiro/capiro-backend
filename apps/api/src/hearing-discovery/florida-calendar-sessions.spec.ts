import type { PrismaClient } from '@prisma/client';
import {
  discoverFloridaCalendar,
  discoverFloridaCalendarSessions,
  floridaCalendarSessions,
  type FloridaDiscoveryOptions,
} from './florida-calendar-discovery.js';

jest.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() {
      return {
        text: '2027 Regular Session\nCOMMITTEE MEETING NOTICE\nTIME: 9:00 a.m.\nPresentation',
      };
    }
    async destroy() {}
  },
}));

describe('Florida recurring calendar session rollover', () => {
  it('keeps the primary session first and accepts one explicit additional session', () => {
    expect(floridaCalendarSessions(['--session=2026'], {})).toEqual(['2026']);
    expect(floridaCalendarSessions(['--session=2026', '--additional-session=2027'], {})).toEqual([
      '2026',
      '2027',
    ]);
    expect(
      floridaCalendarSessions([], {
        FL_CALENDAR_SESSION: '2026',
        FL_CALENDAR_ADDITIONAL_SESSION: '2027',
      }),
    ).toEqual(['2026', '2027']);
    expect(floridaCalendarSessions(['--session=2026', '--additional-session=2026'], {})).toEqual([
      '2026',
    ]);
  });

  it.each([
    ['missing primary', ['--additional-session=2027']],
    ['malformed primary', ['--session=2026F']],
    ['malformed additional', ['--session=2026', '--additional-session=special']],
  ])('rejects %s', (_label, args) => {
    expect(() => floridaCalendarSessions(args, {})).toThrow(
      'one or two explicit four-digit regular sessions',
    );
  });

  it('reads only session-specific Senate pages twice and writes shared sources once', async () => {
    const writes = new Set<string>();
    let sharedNoticeSet: Set<string> | undefined;
    const discover = jest.fn(
      async (_prisma: PrismaClient | null, options: FloridaDiscoveryOptions) => {
        if (!sharedNoticeSet) sharedNoticeSet = options.seenSenateNoticeIds;
        else expect(options.seenSenateNoticeIds).toBe(sharedNoticeSet);

        const primary = options.session === '2026';
        const keys = [
          `senate-committees:${options.session}`,
          ...(options.includeSenateDaily ? ['senate-daily:shared'] : []),
          ...(options.chambers?.includes('house') ? ['house:shared'] : []),
        ];
        for (const key of keys) {
          if (writes.has(key)) throw new Error(`duplicate shared-source write: ${key}`);
          writes.add(key);
        }
        expect(options.optionalSession).toBe(!primary);
        return [
          {
            chamber: 'senate',
            pages: 1,
            expected: 0,
            found: 0,
            inserted: 0,
            updated: 0,
            unchanged: 0,
            issues: [],
            sourceIssues: [],
            skippedOutsideWindow: 0,
            events: [],
            session: options.session,
            availability: 'available' as const,
          },
        ];
      },
    );
    const archive = jest.fn(async (_prisma: PrismaClient, options: { session: string }) => {
      if (writes.has('archive:shared')) throw new Error('duplicate shared-source write: archive');
      writes.add('archive:shared');
      return {
        archive: {
          inserted: 0,
          updated: 0,
          unchanged: 0,
          errors: 0,
          issues: [],
          ambiguous: [],
          session: options.session,
        },
      };
    });

    const result = await discoverFloridaCalendarSessions(
      {} as PrismaClient,
      { from: '2026-09-14', to: '2026-10-05', sessions: ['2026', '2027'] },
      { discover: discover as typeof discoverFloridaCalendar, archive },
    );

    expect(
      discover.mock.calls.map(([, options]) => ({
        session: options.session,
        chambers: options.chambers,
        daily: options.includeSenateDaily,
        optional: options.optionalSession,
        sourceHealth: options.recordSourceHealth,
      })),
    ).toEqual([
      {
        session: '2026',
        chambers: ['senate', 'house'],
        daily: true,
        optional: false,
        sourceHealth: true,
      },
      {
        session: '2027',
        chambers: ['senate'],
        daily: false,
        optional: true,
        sourceHealth: false,
      },
    ]);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(archive.mock.calls[0]![1]).toMatchObject({ session: '2026' });
    expect([...writes]).toEqual([
      'senate-committees:2026',
      'senate-daily:shared',
      'house:shared',
      'senate-committees:2027',
      'archive:shared',
    ]);
    expect(result).toMatchObject({ inserted: 0, updated: 0, skipped: 0, complete: true });
  });

  it('marks an unpublished additional session unavailable instead of parsing its fallback', async () => {
    const logs: string[] = [];
    const sourceUpdate = jest.fn(async (_input: { data: Record<string, unknown> }) => ({}));
    const coverageUpdate = jest.fn(async (_input: { data: Record<string, unknown> }) => ({}));
    const source = {
      id: 'florida-senate-source',
      committeeSystemCode: null,
      chamber: 'senate',
      sourceType: 'COMMITTEE_API',
      sourceUrl: 'https://www.flsenate.gov/Committees',
      adapterKey: 'florida-senate',
      priority: 5,
      parserVersion: 'previous-primary-health',
      enabled: true,
    };
    const prisma = {
      committeeSource: {
        upsert: jest.fn(async () => source),
        findMany: jest.fn(async () => [source]),
        update: sourceUpdate,
      },
      legislativeCalendarCoverage: {
        create: jest.fn(async () => ({ id: 'coverage-2027' })),
        update: coverageUpdate,
      },
    } as unknown as PrismaClient;
    const directory = '<a href="/Committees/Show/FP">Fiscal Policy</a>';
    const fallback = `
      <select id="session-name"><option value="2026F" selected="selected">2026F</option></select>
      <ul id="committeePageTabNavigation">
        <li><a href="/Committees/Show/FP/2026F/Meetings">Meetings</a></li>
      </ul>
      <div id="tabBodyMeetings">No meeting records</div>`;
    const result = await discoverFloridaCalendar(prisma, {
      from: '2026-09-14',
      to: '2026-10-05',
      session: '2027',
      chambers: ['senate'],
      includeSenateDaily: false,
      optionalSession: true,
      recordSourceHealth: false,
      delayMs: 0,
      log: (message) => logs.push(message),
      fetchSource: async (url) =>
        new TextEncoder().encode(url.endsWith('/Committees') ? directory : fallback),
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      session: '2027',
      availability: 'unavailable',
      found: 0,
      events: [],
      issues: [],
    });
    expect(result[0]!.sourceIssues[0]).toContain(
      'requested Senate session 2027, publisher served 2026F',
    );
    expect(logs.some((line) => line.includes('FLORIDA_SESSION_UNAVAILABLE'))).toBe(true);
    expect(logs.some((line) => line.includes('fl:senate:meeting:'))).toBe(false);
    expect(coverageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    expect(sourceUpdate).toHaveBeenCalledTimes(1);
    expect(sourceUpdate.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ data: { lastCheckedAt: expect.any(Date) } }),
    );
    expect(sourceUpdate.mock.calls.some(([call]) => 'sourceHealth' in call.data)).toBe(false);
  });

  it('does not fetch or project a daily-page notice again from the additional committee pass', async () => {
    const seenSenateNoticeIds = new Set<string>();
    let noticeFetches = 0;
    const directory = '<a href="/Committees/Show/FP">Fiscal Policy</a>';
    const page = (session: string, meetings: string) => `
      <select id="session-name"><option value="${session}" selected="selected">${session}</option></select>
      <ul id="committeePageTabNavigation">
        <li><a href="/Committees/Show/FP/${session}/Meetings">Meetings</a></li>
      </ul>
      <div id="tabBodyMeetings">${meetings}</div>`;
    const emptyPrimary = page('2026', 'No meeting records');
    const additionalMeeting = page(
      '2027',
      `<table id="meetingsTbl"><tbody><tr>
        <td>9/14/2026</td><td>9:00 AM</td><td>
          <a class="mtgrecord_notice" href="/Committees/Show/FP/MeetingNotice/7000">Notice</a>
        </td></tr></tbody></table>`,
    );
    const daily = `
      <div class="calHeader"><h2>Monday, September 14, 2026 Open Calendar</h2></div>
      <div id="CalendarContents"><div class="eventGroupContainer"><h4>9:00 AM</h4>
        <div class="event"><div class="eventtitle">Fiscal Policy</div>
          <a href="/Committees/Show/FP/MeetingNotice/7000">Notice</a>
        </div>
      </div></div>`;
    const fetchSource = async (session: '2026' | '2027', url: string) => {
      if (url.endsWith('/Committees')) return new TextEncoder().encode(directory);
      if (url.includes('/Committees/Show/FP/MeetingNotice/7000')) {
        noticeFetches++;
        return new TextEncoder().encode('published notice bytes');
      }
      if (url.includes('/Home/09-14-2026')) return new TextEncoder().encode(daily);
      return new TextEncoder().encode(session === '2026' ? emptyPrimary : additionalMeeting);
    };

    const primary = await discoverFloridaCalendar(null, {
      from: '2026-09-14',
      to: '2026-09-14',
      session: '2026',
      chambers: ['senate'],
      includeSenateDaily: true,
      seenSenateNoticeIds,
      delayMs: 0,
      fetchSource: (url) => fetchSource('2026', url),
    });
    const additional = await discoverFloridaCalendar(null, {
      from: '2026-09-14',
      to: '2026-09-14',
      session: '2027',
      chambers: ['senate'],
      includeSenateDaily: false,
      optionalSession: true,
      seenSenateNoticeIds,
      delayMs: 0,
      fetchSource: (url) => fetchSource('2027', url),
    });

    expect(primary[0]!.events).toEqual(['fl:senate:meeting:7000']);
    expect(additional[0]!.events).toEqual([]);
    expect(noticeFetches).toBe(1);
    expect(seenSenateNoticeIds).toEqual(new Set(['7000']));
  });

  it('surfaces unavailable optional sessions without failing completed primary work', async () => {
    const discover = jest.fn(
      async (_prisma: PrismaClient | null, options: FloridaDiscoveryOptions) => [
        {
          chamber: 'senate',
          pages: 1,
          expected: 0,
          found: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          issues: [],
          sourceIssues: options.session === '2027' ? ['publisher served 2026F'] : [],
          skippedOutsideWindow: 0,
          events: [],
          session: options.session,
          availability:
            options.session === '2027' ? ('unavailable' as const) : ('available' as const),
        },
      ],
    );

    const receipt = await discoverFloridaCalendarSessions(
      null,
      {
        from: '2026-09-14',
        to: '2026-10-05',
        sessions: ['2026', '2027'],
        dryRun: true,
      },
      { discover: discover as typeof discoverFloridaCalendar },
    );

    expect(receipt).toMatchObject({ complete: true, errors: 0, unavailableSessions: ['2027'] });
  });
});
