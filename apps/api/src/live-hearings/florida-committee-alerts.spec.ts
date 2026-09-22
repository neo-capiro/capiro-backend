import {
  committeeUpdatesDeepLink,
  parseStateCommitteeFollowKey,
  stateCalendarCommitteeUpdates,
  stateCommitteeFollowKey,
  verifiedStateCommitteeAliasIds,
} from '../hearing-discovery/florida-committee-alerts.js';
import type { CalendarFacts } from '../hearing-discovery/legislative-calendar.js';

const base: CalendarFacts = {
  title: 'Appropriations Committee',
  status: 'scheduled',
  time: {
    date: '2027-02-01',
    rawTime: '10:00 AM',
    timezone: 'America/New_York',
    precision: 'instant',
    startsAt: '2027-02-01T15:00:00.000Z',
    endsAt: null,
  },
  location: 'Room 110',
  agenda: [],
  documents: [],
  watchUrl: null,
};

describe('Florida committee alert projection', () => {
  it('uses a collision-proof state key and a state-aware committee deep link', () => {
    const key = stateCommitteeFollowKey('fl', 'official-committee-1');
    expect(key).toBe('state:FL:official-committee-1');
    expect(parseStateCommitteeFollowKey(key)).toEqual({
      jurisdiction: 'FL',
      stateCommitteeId: 'official-committee-1',
    });
    expect(committeeUpdatesDeepLink(key)).toBe(
      '/legiwatch/committees/FL/official-committee-1?tab=updates',
    );
    expect(committeeUpdatesDeepLink('HSAS')).toBe('/legiwatch/committees/HSAS?tab=updates');
  });

  it('encodes state ids and federal codes as single route segments', () => {
    expect(committeeUpdatesDeepLink('state:FL:budget/../rules?client=a#top')).toBe(
      '/legiwatch/committees/FL/budget%2F..%2Frules%3Fclient%3Da%23top?tab=updates',
    );
    expect(committeeUpdatesDeepLink('HSAS/../?client=a#top')).toBe(
      '/legiwatch/committees/HSAS%2F..%2F%3Fclient%3Da%23top?tab=updates',
    );
    expect(() => committeeUpdatesDeepLink('state:FL:..')).toThrow('Unsafe committee route segment');
    expect(() => committeeUpdatesDeepLink('.')).toThrow('Unsafe committee route segment');
  });

  it('accepts only normalized unique alias ids from directory evidence', () => {
    expect(
      verifiedStateCommitteeAliasIds({
        directory: { aliasIds: [' legacy-1 ', 'legacy-1', '', 42, 'legacy-2'] },
      }),
    ).toEqual(['legacy-1', 'legacy-2']);
    expect(verifiedStateCommitteeAliasIds({ openstates: { aliasIds: ['untrusted'] } })).toEqual([]);
  });

  it('maps one Florida transition to stable federal-pipeline observations', () => {
    const after: CalendarFacts = {
      ...base,
      status: 'canceled',
      time: {
        ...base.time,
        date: '2027-02-02',
        rawTime: '1:00 PM',
        startsAt: '2027-02-02T18:00:00.000Z',
      },
      location: 'Room 212',
      watchUrl: 'https://www.flsenate.gov/Media/VideoPlayer/1234',
      agenda: [
        {
          key: 'sb-100',
          position: 1,
          kind: 'unresolved_bill',
          title: 'SB 100',
          sourceUrl: 'https://www.flsenate.gov/Session/Bill/2027/100',
          evidence: { identifier: 'SB 100' },
        },
      ],
      documents: [
        {
          key: 'packet',
          title: 'Meeting packet',
          url: 'https://www.flsenate.gov/Committees/Show/AP/MeetingPacket.pdf',
          kind: 'packet',
          publishedAt: '2027-01-31T17:00:00.000Z',
        },
      ],
    };
    const input = {
      jurisdiction: 'FL',
      stateCommitteeId: 'official-committee-1',
      hearingId: 'state-fl-hearing-1',
      revision: 2,
      existed: true,
      before: base,
      after,
      changedFields: ['time', 'location', 'status', 'watchUrl', 'agenda', 'documents'] as const,
      sourceUrl: 'https://www.flsenate.gov/Committees/Show/AP',
      publishedAt: '2027-01-31T17:00:00.000Z',
      parserVersion: 'fl-calendar-v1',
    };
    const first = stateCalendarCommitteeUpdates(input);
    const replay = stateCalendarCommitteeUpdates(input);
    expect(first.map((row) => row.updateType)).toEqual([
      'date_changed',
      'time_changed',
      'room_changed',
      'canceled',
      'livestream_posted',
      'bill_added',
      'committee_memo_published',
    ]);
    expect(first.map((row) => row.contentHash)).toEqual(replay.map((row) => row.contentHash));
    expect(new Set(first.map((row) => row.contentHash)).size).toBe(first.length);
    expect(first.every((row) => row.committeeSystemCode === 'state:FL:official-committee-1')).toBe(
      true,
    );
  });

  it('announces a new hearing without mislabeling its initial room and time as changes', () => {
    const rows = stateCalendarCommitteeUpdates({
      jurisdiction: 'FL',
      stateCommitteeId: 'official-committee-1',
      hearingId: 'state-fl-hearing-1',
      revision: 1,
      existed: false,
      before: {},
      after: base,
      changedFields: ['title', 'status', 'time', 'location', 'agenda', 'documents', 'watchUrl'],
      sourceUrl: 'https://www.flhouse.gov/Sections/Committees/committees.aspx',
      publishedAt: null,
      parserVersion: 'fl-calendar-v1',
    });
    expect(rows.map((row) => row.updateType)).toEqual(['hearing_announced']);
  });

  it('announces the first unresolved-to-committee attribution with a replay-stable hash', () => {
    const input = {
      jurisdiction: 'FL',
      stateCommitteeId: 'official-committee-1',
      hearingId: 'state-fl-hearing-1',
      revision: 3,
      existed: true,
      firstCommitteeAttribution: true,
      before: base,
      after: base,
      changedFields: [] as const,
      sourceUrl: 'https://www.flsenate.gov/Committees/Show/AP',
      publishedAt: null,
      parserVersion: 'fl-calendar-v1',
    };
    const first = stateCalendarCommitteeUpdates(input);
    const replay = stateCalendarCommitteeUpdates(input);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      updateType: 'hearing_announced',
      committeeSystemCode: 'state:FL:official-committee-1',
    });
    expect(replay[0]!.contentHash).toBe(first[0]!.contentHash);
  });
});
