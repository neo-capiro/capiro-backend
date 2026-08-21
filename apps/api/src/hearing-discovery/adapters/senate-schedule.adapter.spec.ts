/**
 * Senate central schedule parsing.
 *
 * The fixture below is the VERBATIM response from
 * https://www.senate.gov/general/committee_schedules/hearings.xml captured
 * 2026-08-20. It is used as-is rather than hand-written because two of its
 * quirks are the whole reason this parser has edge cases, and a tidied-up
 * fixture would test a feed that does not exist:
 *
 *   - the first <meeting> is a PLACEHOLDER with empty cmte_code/committee and
 *     matter "No committee hearings scheduled";
 *   - <last_update_iso_8601> is malformed — it carries both `Z` and a numeric
 *     offset (`2026-08-03T15:34:42.000000Z-04:00`), which `new Date()` rejects.
 */
import {
  SenateScheduleAdapter,
  parseIsoClock,
  parseIsoDay,
  parseSenateSchedule,
  parseSenateTimestamp,
} from './senate-schedule.adapter.js';
import type { DiscoveryContext, SourceDescriptor } from '../hearing-discovery.types.js';

const LIVE_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?><css_meetings_scheduled>
  <meeting>
    <cmte_code/>
    <committee/>
    <type/>
    <date>20-AUG-2026</date>
    <date_iso_8601>2026-08-20</date_iso_8601>
    <day_of_week>Today</day_of_week>
    <time>18:00:00</time>
    <room/>
    <matter>No committee hearings scheduled</matter>
    <video_url/>
    <senate_cable_channel/>
  </meeting>
  <meeting>
    <identifier>338724</identifier>
    <last_update>08-03-2026 03:34:42 PM</last_update>
    <last_update_iso_8601>2026-08-03T15:34:42.000000Z-04:00</last_update_iso_8601>
    <cmte_code>SSAS00</cmte_code>
    <committee>Armed Services</committee>
    <type>Closed Hearing</type>
    <date>17-SEP-2026 09:30 AM</date>
    <date_iso_8601>2026-09-17</date_iso_8601>
    <day_of_week>Thursday</day_of_week>
    <time>09:30 AM</time>
    <time_iso_8601>09:30:00</time_iso_8601>
    <room>SVC-217</room>
    <video_url>
    </video_url>
    <senate_cable_channel>
    </senate_cable_channel>
    <Documents/>
    <matter>To receive a closed briefing on the implementation of the National Defense Strategy and its impact on global defense posture.</matter>
  </meeting>
</css_meetings_scheduled>`;

const SOURCE: SourceDescriptor = {
  id: 'src-senate',
  committeeSystemCode: null,
  chamber: 'senate',
  sourceType: 'SENATE_SCHEDULE',
  sourceUrl: 'https://www.senate.gov/general/committee_schedules/hearings.xml',
  adapterKey: 'senate-schedule',
  priority: 20,
  parserVersion: 'senate-schedule/2026-08-20',
};

const CTX: DiscoveryContext = { since: null, daysAhead: 21, delayMs: 0, log: () => {} };

describe('parseSenateSchedule', () => {
  it('returns every <meeting> block, placeholder included', () => {
    const rows = parseSenateSchedule(LIVE_FIXTURE);
    expect(rows).toHaveLength(2);
  });

  it('reads the real meeting fields', () => {
    const row = parseSenateSchedule(LIVE_FIXTURE)[1];
    expect(row).toMatchObject({
      identifier: '338724',
      committeeCode: 'SSAS00',
      committeeName: 'Armed Services',
      type: 'Closed Hearing',
      dateIso: '2026-09-17',
      timeIso: '09:30:00',
      room: 'SVC-217',
    });
  });

  it('treats an empty element as absent rather than as an empty string', () => {
    const placeholder = parseSenateSchedule(LIVE_FIXTURE)[0];
    expect(placeholder?.committeeCode).toBeNull();
    expect(placeholder?.videoUrl).toBeNull();
  });
});

describe('parseSenateTimestamp', () => {
  it('repairs the feed malformed Z-plus-offset timestamp', () => {
    // Proof the raw value really is unparseable, so the repair is necessary.
    expect(Number.isNaN(new Date('2026-08-03T15:34:42.000000Z-04:00').getTime())).toBe(true);
    const parsed = parseSenateTimestamp('2026-08-03T15:34:42.000000Z-04:00');
    expect(parsed?.toISOString()).toBe('2026-08-03T19:34:42.000Z');
  });

  it('leaves a well-formed timestamp alone', () => {
    expect(parseSenateTimestamp('2026-08-03T15:34:42Z')?.toISOString()).toBe(
      '2026-08-03T15:34:42.000Z',
    );
  });

  it('returns null rather than an Invalid Date', () => {
    expect(parseSenateTimestamp('not a date')).toBeNull();
    expect(parseSenateTimestamp(null)).toBeNull();
  });
});

describe('parseIsoDay / parseIsoClock', () => {
  it('parses the feed date to a UTC-midnight day', () => {
    expect(parseIsoDay('2026-09-17')?.toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });

  it('rejects anything that is not exactly YYYY-MM-DD', () => {
    expect(parseIsoDay('17-SEP-2026')).toBeNull();
    expect(parseIsoDay(null)).toBeNull();
  });

  it('parses both the ISO and the 12-hour clock forms the feed uses', () => {
    expect(parseIsoClock('09:30:00')).toEqual({ hour: 9, minute: 30 });
    expect(parseIsoClock('02:15 PM')).toEqual({ hour: 14, minute: 15 });
    expect(parseIsoClock('12:00 AM')).toEqual({ hour: 0, minute: 0 });
    expect(parseIsoClock('12:00 PM')).toEqual({ hour: 12, minute: 0 });
  });

  it('rejects an impossible clock instead of coercing it', () => {
    expect(parseIsoClock('25:00')).toBeNull();
    expect(parseIsoClock('13:00 PM')).toBeNull();
    expect(parseIsoClock('')).toBeNull();
  });
});

describe('SenateScheduleAdapter.discoverEvents', () => {
  const adapter = new SenateScheduleAdapter({ congress: 119, url: 'https://senate.test/feed.xml' });

  beforeEach(() => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(LIVE_FIXTURE, { status: 200, headers: { 'content-type': 'application/xml' } }),
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('drops the placeholder row and keeps the real hearing', async () => {
    const events = await adapter.discoverEvents(SOURCE, CTX);
    expect(events).toHaveLength(1);
    expect(events[0]?.externalEventId).toBe('338724');
  });

  it('lowercases the committee code to match congress_committee.system_code', async () => {
    const [event] = await adapter.discoverEvents(SOURCE, CTX);
    expect(event?.committeeSystemCode).toBe('ssas00');
    expect(event?.subcommitteeSystemCode).toBeNull();
  });

  it('converts the Eastern wall clock forward to a real instant (09:30 ET = 13:30Z in EDT)', async () => {
    const [event] = await adapter.discoverEvents(SOURCE, CTX);
    expect(event?.startsAt?.toISOString()).toBe('2026-09-17T13:30:00.000Z');
    expect(event?.displayTime).toBe('9:30 AM');
  });

  it('marks a closed briefing private, so it can never be queued for public capture', async () => {
    const [event] = await adapter.discoverEvents(SOURCE, CTX);
    expect(event?.visibility).toBe('private');
  });

  it('carries the repaired official update timestamp', async () => {
    const [event] = await adapter.discoverEvents(SOURCE, CTX);
    expect(event?.sourceUpdatedAt?.toISOString()).toBe('2026-08-03T19:34:42.000Z');
  });

  it('advertises no stream candidate when <video_url> is empty', async () => {
    const [event] = await adapter.discoverEvents(SOURCE, CTX);
    expect(event?.streamCandidates).toEqual([]);
  });

  it('treats a subcommittee code as a child of its parent body', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(LIVE_FIXTURE.replace('SSAS00', 'SSAS15'), { status: 200 }));
    const [event] = await adapter.discoverEvents(SOURCE, CTX);
    expect(event?.committeeSystemCode).toBe('ssas00');
    expect(event?.subcommitteeSystemCode).toBe('ssas15');
  });

  it('throws on an upstream failure rather than reporting an empty calendar', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    await expect(adapter.discoverEvents(SOURCE, CTX)).rejects.toThrow(
      /senate schedule fetch failed/,
    );
  });
});
