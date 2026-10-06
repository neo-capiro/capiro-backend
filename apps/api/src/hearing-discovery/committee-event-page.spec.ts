import {
  CommitteeEventPageResolver,
  isCommitteeEventPage,
  type ScopedHearingRef,
} from './committee-event-page.js';
import type { SourceDescriptor } from './hearing-discovery.types.js';
const source = { sourceUrl: 'https://www.armed-services.senate.gov/' } as SourceDescriptor;
const page = 'https://www.armed-services.senate.gov/hearings/to-receive-an-update-on-golden-dome';
const hearing: ScopedHearingRef = {
  id: 'sen-119-338758',
  congress: 119,
  chamber: 'Senate',
  committeeSystemCode: 'ssas00',
  subcommitteeSystemCode: 'ssas16',
  committeeName: 'Armed Services',
  title: 'Golden Dome',
  calendarDate: new Date('2026-09-29'),
  startsAt: new Date('2026-09-29T20:00:00Z'),
  timeZone: null,
  officialPageUrl: 'https://www.congress.gov/event/119th-Congress/senate-event/338758',
};
const event = {
  ...hearing,
  calendarDate: '2026-09-29T00:00:00Z',
  startsAt: '2026-09-29T20:00:00Z',
  officialPageUrl: page,
};
const observation = (patch: Record<string, unknown> = {}) => ({
  sourceMetadata: { event: { ...event, ...patch } },
  source: { adapterKey: 'committee-site', sourceUrl: source.sourceUrl },
});
const resolve = (observations: ReturnType<typeof observation>[]) =>
  new CommitteeEventPageResolver().resolve(source, hearing, observations);
describe('committee event page identity', () => {
  it('accepts an already associated official event with exact parent, subcommittee and time', async () => {
    expect(await resolve([observation()])).toBe(page);
  });
  it.each([
    { committeeSystemCode: 'ssju00' },
    { subcommitteeSystemCode: 'ssas17' },
    { subcommitteeSystemCode: null },
    { congress: 118 },
    { chamber: 'House' },
    { calendarDate: '2026-09-28' },
    { startsAt: '2026-09-29T18:00:00Z' },
    { startsAt: null },
    { officialPageUrl: 'https://other.senate.gov/hearings/golden-dome' },
  ])('rejects incompatible observation %j', async (patch) => {
    expect(await resolve([observation(patch)])).toBeNull();
  });
  it('refuses ambiguous linked event pages', async () => {
    expect(
      await resolve([observation(), observation({ officialPageUrl: page + '-other' })]),
    ).toBeNull();
  });
  it('never uses a shared Senate day player to discover or identify an event page', async () => {
    expect(
      await resolve([
        observation({
          officialPageUrl: 'https://www.senate.gov/general/committee_schedules/hearings.xml',
          streamCandidates: [
            { officialPageUrl: 'https://www.senate.gov/isvp/?comm=armed&filename=armedA092926' },
          ],
        }),
      ]),
    ).toBeNull();
  });
  it.each([
    '/hearings',
    '/hearings/calendar',
    '/hearings/2026-09-29',
    '/video/live',
    '/public/index.cfm?date=2026-09-29',
  ])('rejects shared page %s', (path) => {
    expect(isCommitteeEventPage(new URL(path, source.sourceUrl).href, source.sourceUrl)).toBe(
      false,
    );
  });
});
