import { discoverFromXml, parseSenateScheduleXml, scheduledAtFrom } from './senate-schedule.js';

// Sample shaped like the live feed
// (https://www.senate.gov/general/committee_schedules/hearings.xml): a flat list
// of <meeting> elements with scalar children incl. an ISVP <video_url>.
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<css_meetings_scheduled>
  <meeting>
    <identifier>338683</identifier>
    <cmte_code>SSGA00</cmte_code>
    <committee>Homeland Security and Governmental Affairs</committee>
    <type>Open Hearing</type>
    <date>29-JUL-2026 08:30 AM</date>
    <date_iso_8601>2026-07-29</date_iso_8601>
    <time>08:30 AM</time>
    <time_iso_8601>08:30:00</time_iso_8601>
    <room>SD-342</room>
    <video_url>https://www.senate.gov/isvp/?comm=govtaff&amp;filename=govtaff072926</video_url>
    <matter>Hearings to examine the testimony of a nominee.</matter>
  </meeting>
  <meeting>
    <identifier>338700</identifier>
    <cmte_code>SSJU00</cmte_code>
    <committee>Judiciary</committee>
    <type>Executive Business Meeting</type>
    <date_iso_8601>2026-07-30</date_iso_8601>
    <video_url>https://www.senate.gov/isvp/?comm=judiciary&amp;filename=judiciary073026</video_url>
    <matter>Markup of pending nominations.</matter>
  </meeting>
  <meeting>
    <cmte_code>SSAF00</cmte_code>
    <committee>Agriculture</committee>
    <type>Open Hearing</type>
    <video_url>https://www.senate.gov/isvp/?comm=ag&amp;filename=ag073026</video_url>
    <matter>No identifier — must be skipped.</matter>
  </meeting>
  <meeting>
    <identifier>338710</identifier>
    <cmte_code>SSXX00</cmte_code>
    <committee>Some New Caucus</committee>
    <type>Open Hearing</type>
    <date_iso_8601>2026-07-31</date_iso_8601>
    <video_url>https://www.senate.gov/isvp/?comm=notacommittee&amp;filename=nope073126</video_url>
    <matter>In-scope hearing but committee not in the streamId table.</matter>
  </meeting>
</css_meetings_scheduled>`;

describe('parseSenateScheduleXml', () => {
  it('extracts every meeting that has an <identifier>, skipping those without', () => {
    const entries = parseSenateScheduleXml(SAMPLE);
    // 4 <meeting> blocks, one lacks <identifier> → 3 parsed.
    expect(entries.map((e) => e.identifier)).toEqual(['338683', '338700', '338710']);
  });

  it('decodes &amp; in the video_url and reads scalar fields', () => {
    const [first] = parseSenateScheduleXml(SAMPLE);
    expect(first?.committeeCode).toBe('SSGA00');
    expect(first?.type).toBe('Open Hearing');
    expect(first?.videoUrl).toBe(
      'https://www.senate.gov/isvp/?comm=govtaff&filename=govtaff072926',
    );
    expect(first?.matter).toContain('nominee');
  });

  it('returns [] for empty/garbage input', () => {
    expect(parseSenateScheduleXml('')).toEqual([]);
    expect(parseSenateScheduleXml('<html>not a feed</html>')).toEqual([]);
  });
});

describe('scheduledAtFrom', () => {
  it('combines date + bare time into a valid Date', () => {
    const d = scheduledAtFrom({
      identifier: 'x',
      committeeCode: null,
      committee: null,
      subCommittee: null,
      type: 'Open Hearing',
      dateIso: '2026-07-29',
      timeIso: '08:30:00',
      room: null,
      videoUrl: null,
      matter: null,
    });
    expect(d).not.toBeNull();
    expect(d!.toISOString().slice(0, 16)).toBe('2026-07-29T08:30');
  });

  it('falls back to date-only when time is missing, null when unparseable', () => {
    expect(
      scheduledAtFrom({
        identifier: 'x',
        committeeCode: null,
        committee: null,
        subCommittee: null,
        type: 'Open Hearing',
        dateIso: '2026-07-29',
        timeIso: null,
        room: null,
        videoUrl: null,
        matter: null,
      }),
    ).toBeInstanceOf(Date);
    expect(
      scheduledAtFrom({
        identifier: 'x',
        committeeCode: null,
        committee: null,
        subCommittee: null,
        type: 'Open Hearing',
        dateIso: null,
        timeIso: null,
        room: null,
        videoUrl: null,
        matter: null,
      }),
    ).toBeNull();
  });
});

describe('discoverFromXml', () => {
  it('keeps EVERY streamable proceeding (hearings + markups + business meetings)', () => {
    const found = discoverFromXml(SAMPLE);
    // Type-agnostic: 338683 (govtaff hearing) + 338700 (judiciary business
    // meeting — now IN scope) + 338710 (unknown committee). NOT the
    // no-identifier row (skipped: no capture-once key).
    expect(found.map((d) => d.entry.identifier)).toEqual(['338683', '338700', '338710']);
  });

  it('records the proceeding type as metadata (not a gate)', () => {
    const found = discoverFromXml(SAMPLE);
    const markup = found.find((d) => d.entry.identifier === '338700')!;
    expect(markup.entry.type).toBe('Executive Business Meeting');
    expect(markup.comm).toBe('judiciary');
  });

  it('constructs the Akamai master.m3u8 for a known committee', () => {
    const found = discoverFromXml(SAMPLE);
    const govtaff = found.find((d) => d.entry.identifier === '338683')!;
    expect(govtaff.comm).toBe('govtaff');
    expect(govtaff.filename).toBe('govtaff072926');
    expect(govtaff.isvpUrl).toBe(
      'https://www-senate-gov-media-srs.akamaized.net/hls/live/2036792/govtaff/govtaff072926/master.m3u8',
    );
  });

  it('still discovers an in-scope hearing whose committee lacks a streamId (isvpUrl null)', () => {
    const found = discoverFromXml(SAMPLE);
    const unknown = found.find((d) => d.entry.identifier === '338710')!;
    expect(unknown.comm).toBe('notacommittee');
    expect(unknown.isvpUrl).toBeNull();
  });
});
