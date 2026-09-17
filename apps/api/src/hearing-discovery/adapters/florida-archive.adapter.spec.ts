import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyFloridaChannelTitle,
  floridaChannelObservation,
  floridaChannelSessionProgramId,
  floridaChannelTitleDate,
  floridaKalturaEntryId,
  isFloridaChannelVideoPage,
  senateMediaArchive,
} from './florida-calendar.adapter.js';
import { validateCalendarObservation } from '../legislative-calendar.js';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../__fixtures__/florida', name), 'utf8');
type TfcFixture = {
  id: number;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  video_programs: number[];
};
const jsonFixture = (name: string): TfcFixture => JSON.parse(fixture(name)) as TfcFixture;

describe('Florida archive sources', () => {
  describe('senate media catalog', () => {
    it('parses the published page into exact per-event rows', () => {
      const { rows, maxPage, issues } = senateMediaArchive(fixture('senate-media-archive-p1.html'));
      expect(issues).toEqual([]);
      expect(maxPage).toBeGreaterThanOrEqual(24);
      expect(rows).toHaveLength(25);
      const jlbc = rows.find((r) => r.watchUrl.endsWith('/6382'));
      expect(jlbc).toMatchObject({
        date: '2026-09-11',
        title: 'Joint Legislative Budget Commission',
        kind: 'Senate Committee Meeting',
        rawTime: '11:00 AM',
        watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/6382',
        durationText: '2:33 hours',
      });
      const special = rows.find((r) => r.watchUrl.endsWith('/6344'));
      expect(special).toMatchObject({
        date: '2026-06-02',
        title: 'Senate in Special Session F',
        kind: 'Senate Session',
        rawTime: '9:00 AM',
      });
    });

    it('treats an unreadable catalog page as a source failure, not empty coverage', () => {
      expect(() => senateMediaArchive('<main>unrecognized</main>')).toThrow(
        'Senate media archive layout unavailable',
      );
    });
  });

  describe('publisher player pages', () => {
    it('extracts the Kaltura entry embedded by the official Senate player', () => {
      expect(floridaKalturaEntryId(fixture('senate-videoplayer-6382.html'))).toBe('1_abohhovv');
    });

    it('accepts only exact /videos/<slug>/ pages on thefloridachannel.org', () => {
      expect(
        isFloridaChannelVideoPage(
          'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission/',
        ),
      ).toBe(true);
      expect(
        isFloridaChannelVideoPage(
          'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission',
        ),
      ).toBe(true);
      for (const bad of [
        'https://thefloridachannel.org/videos/',
        'https://thefloridachannel.org/videos',
        'https://thefloridachannel.org/about-tfc/how-to-watch/',
        'https://thefloridachannel.org/videos/slug/extra/',
        'http://thefloridachannel.org/videos/slug/',
        'https://www.thefloridachannel.org/videos/slug/',
        'https://thefloridachannel.org.evil.example/videos/slug/',
        'https://user:pw@thefloridachannel.org/videos/slug/',
      ])
        expect(isFloridaChannelVideoPage(bad)).toBe(false);
    });
  });

  describe('florida channel archive classification', () => {
    const cases: Array<[string, { legislative: boolean; chamber?: string }]> = [
      ['9/11/26 Joint Legislative Budget Commission', { legislative: true, chamber: 'joint' }],
      ['6/2/26 House Session', { legislative: true, chamber: 'house' }],
      ['6/2/26 Senate Session', { legislative: true, chamber: 'senate' }],
      ['6/1/26 Senate Committee on Appropriations', { legislative: true, chamber: 'senate' }],
      ['6/1/26 House State Affairs Committee', { legislative: true, chamber: 'house' }],
      [
        '5/22/26 Meeting of the Budget Conference Chairs – 6:30 PM',
        { legislative: true, chamber: 'joint' },
      ],
      [
        '5/14/26 Appropriations Conference Committee on Agriculture, Environment, and General Government',
        { legislative: true, chamber: 'joint' },
      ],
      ['9/11/26 Press Availability with Joint Legislative Budget Commission', { legislative: false }],
      ['9/14/26 Capitol Update Extended: Woman Who Took Millions', { legislative: false }],
      ['9/16/26 Attorney General’s Press Conference', { legislative: false }],
      ['9/16/26 Florida Commission on Ethics', { legislative: false }],
      ['9/15/26 Public Service Commission Hearing on Storm Protection Plan', { legislative: false }],
      ['9/16/26 University of North Florida Board of Trustees Meeting', { legislative: false }],
      ['9/15/26 Historical Markers on John Wesley Hardin', { legislative: false }],
      ['1/20/26 Jackson County Delegation Meeting', { legislative: false }],
    ];
    it.each(cases)('%s', (title, expected) => {
      const cls = classifyFloridaChannelTitle(title);
      expect(cls.legislative).toBe(expected.legislative);
      if (expected.chamber) {
        expect(cls.legislative).toBe(true);
        if (cls.legislative) expect(cls.chamber).toBe(expected.chamber);
      }
    });

    it('reads the meeting date from the title, never the WP post timestamp', () => {
      expect(floridaChannelTitleDate('9/11/26 Joint Legislative Budget Commission')).toBe(
        '2026-09-11',
      );
      expect(floridaChannelTitleDate('12/31/25 House Session')).toBe('2025-12-31');
      expect(floridaChannelTitleDate('Joint Legislative Budget Commission')).toBeNull();
    });
  });

  describe('florida channel observation', () => {
    const build = (record: TfcFixture) =>
      floridaChannelObservation({
        id: record.id,
        link: record.link,
        title: record.title.rendered,
        contentHtml: record.content.rendered,
        programIds: record.video_programs,
        sessionProgramId: 54919,
        session: '2026',
      });

    it('builds a date-precision completed observation for the exact hearing record', () => {
      const built = build(jsonFixture('tfc-video-80615.json'));
      if ('rejected' in built) throw new Error(built.rejected);
      expect(built.kalturaEntryId).toBe('1_abohhovv');
      const o = built.observation;
      expect(o.officialIdentity).toBe('fl:tfc:video:80615');
      expect(o.chamber).toBe('joint');
      expect(o.eventType).toBe('joint');
      expect(o.fields).toMatchObject({
        title: 'Joint Legislative Budget Commission',
        status: 'completed',
        watchUrl: 'https://thefloridachannel.org/videos/9-11-26-joint-legislative-budget-commission/',
        time: { date: '2026-09-11', precision: 'date', startsAt: null },
      });
      expect(o.fields.agenda).toBeUndefined();
      expect(o.completeness).toBe('partial');
      expect(() => validateCalendarObservation(o)).not.toThrow();
    });

    it('rejects the press availability about the same body and day', () => {
      // 80620 is in the press-conferences program, not the session term — and
      // its title is non-legislative too. Either rung rejects it; both are
      // asserted so neither path can silently accept it.
      const rec = jsonFixture('tfc-video-80620.json');
      const cls = classifyFloridaChannelTitle(rec.title.rendered);
      expect(cls.legislative).toBe(false);
      const built = build(rec);
      expect('rejected' in built).toBe(true);
    });

    it('rejects a record outside the session program even when the title is legislative', () => {
      const rec = jsonFixture('tfc-video-80615.json');
      const built = floridaChannelObservation({
        id: rec.id,
        link: rec.link,
        title: rec.title.rendered,
        contentHtml: rec.content.rendered,
        programIds: [25458], // State Budget Process, NOT the 2026 Legislative Session term
        sessionProgramId: 54919,
        session: '2026',
      });
      expect('rejected' in built && built.rejected).toMatch(/not in the 2026 Legislative Session/);
    });

    it('rejects a record whose page embeds no playable player', () => {
      const rec = jsonFixture('tfc-video-80615.json');
      rec.content.rendered = '<p>No player here.</p>';
      const built = build(rec);
      expect('rejected' in built && built.rejected).toMatch(/no playable player/);
    });

    it('verifies the player from the rendered page when WP content is empty (TFC 78898)', () => {
      const rec = jsonFixture('tfc-video-80615.json');
      const pageHtml = fixture('tfc-78898-page.html');
      const built = floridaChannelObservation({
        id: 78898,
        link: 'https://thefloridachannel.org/videos/2-4-26-senate-appropriations-committee-on-higher-education/',
        title: '2/4/26 Senate Appropriations Committee on Higher Education',
        contentHtml: '<p></p>', // WP content carries no player for this record
        pageHtml,
        programIds: [54919],
        sessionProgramId: 54919,
        session: '2026',
      });
      if ('rejected' in built) throw new Error(built.rejected);
      expect(built.kalturaEntryId).toBe('1_llv5oqlw');
      expect(built.observation.fields.time).toMatchObject({ date: '2026-02-04', precision: 'date' });
      expect(built.observation.chamber).toBe('senate');
      void rec;
    });

    it('projects floor sittings as eventType floor, not committee (regex boundary regression)', () => {
      // FLORIDA_FLOOR_TITLE previously carried two literal ASCII backspace
      // bytes instead of \b boundaries, so "House Session"/"Senate Session"/
      // "… in Special Session F" silently projected as committee events.
      const mk = (id: number, link: string, title: string) =>
        floridaChannelObservation({
          id,
          link,
          title,
          contentHtml:
            '<iframe src="https://cdnapisec.kaltura.com/p/2593311/embedPlaykitJs/uiconf_id/48703633?iframeembed=true&entry_id=1_floor001"></iframe>',
          programIds: [54919],
          sessionProgramId: 54919,
          session: '2026',
        });
      const house = mk(
        90001,
        'https://thefloridachannel.org/videos/6-2-26-house-session/',
        '6/2/26 House Session',
      );
      if ('rejected' in house) throw new Error(house.rejected);
      expect(house.observation.eventType).toBe('floor');
      const special = mk(
        90002,
        'https://thefloridachannel.org/videos/6-2-26-senate-special-session-f/',
        '6/2/26 Senate in Special Session F',
      );
      if ('rejected' in special) throw new Error(special.rejected);
      expect(special.observation.eventType).toBe('floor');
      // A committee title of the same chamber is NOT a floor sitting.
      const committee = mk(
        90003,
        'https://thefloridachannel.org/videos/6-1-26-senate-committee-on-appropriations/',
        '6/1/26 Senate Committee on Appropriations',
      );
      if ('rejected' in committee) throw new Error(committee.rejected);
      expect(committee.observation.eventType).toBe('committee');
    });

    it('resolves the session taxonomy term by name, never by hardcoded id', () => {
      expect(
        floridaChannelSessionProgramId(
          [
            { id: 53712, name: '2025 Legislative Session' },
            { id: 54919, name: '2026 Legislative Session' },
          ],
          '2026',
        ),
      ).toBe(54919);
      expect(
        floridaChannelSessionProgramId([{ id: 53712, name: '2025 Legislative Session' }], '2026'),
      ).toBeNull();
    });
  });
});
