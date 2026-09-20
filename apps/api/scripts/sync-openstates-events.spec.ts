import { validateCalendarObservation } from '../src/hearing-discovery/legislative-calendar.js';
import {
  floridaOfficialIdentityFromEvent,
  openstatesCommitteeIdentity,
  openstatesEventObservation,
  type OpenstatesEvent,
} from './sync-openstates-events.js';

const EVENT: OpenstatesEvent = {
  id: 'ocd-event/709f2430-b337-4039-a48b-15618e3c2576',
  name: 'Senate Criminal Justice',
  jurisdiction: { id: 'ocd-jurisdiction/country:us/state:fl/government', name: 'Florida' },
  classification: 'event',
  start_date: '2026-01-12T13:30:00-05:00',
  end_date: '2026-01-12T15:30:00-05:00',
  all_day: false,
  status: 'confirmed',
  upstream_id: 'CJ-2026-01-12',
  deleted: false,
  location: { name: 'Mallory Horne Committee Room' },
  sources: [{ url: 'https://www.flsenate.gov/Committees/Show/CJ/MeetingNotice/7000' }],
  links: [{ url: 'https://openstates.org/fl/events/709f2430/' }],
  media: [
    {
      note: 'Official video',
      date: '2026-01-12',
      classification: 'video',
      links: [{ url: 'https://www.flsenate.gov/media/VideoPlayer/7000' }],
    },
    {
      note: 'Official audio',
      date: '2026-01-12',
      classification: 'audio',
      links: [{ url: 'https://www.flsenate.gov/media/Audio/7000.mp3' }],
    },
  ],
  documents: [
    {
      note: 'Expanded Agenda',
      date: '2026-01-10',
      classification: 'agenda',
      links: [{ url: 'https://www.flsenate.gov/Committees/Show/CJ/ExpandedAgenda/7000' }],
    },
    {
      note: 'Attendance',
      date: '2026-01-12',
      classification: 'attendance',
      links: [{ url: 'https://www.flsenate.gov/Committees/Show/CJ/Attendance/7000' }],
    },
  ],
  participants: [
    {
      entity_type: 'organization',
      name: 'Criminal Justice',
      organization: {
        id: 'ocd-organization/d985568b-8718-4da2-9e2d-543cb9a0547e',
        name: 'Senate Criminal Justice',
      },
    },
  ],
  agenda: [
    {
      description: 'SB 50 — Public Records',
      classification: ['discussion'],
      order: 1,
      subjects: ['Public records'],
      notes: [],
      extras: {},
      related_entities: [{ entity_type: 'bill', name: 'SB 50', bill: { identifier: 'SB 50' } }],
      media: [],
    },
  ],
};

describe('OpenStates Florida event reconciliation', () => {
  it('extracts the committee provider identity from merged source evidence', () => {
    expect(
      openstatesCommitteeIdentity({
        directory: { aliasIds: ['FL-upper-criminal-justice'] },
        openstates: { committeeId: 'ocd-organization/cj' },
      }),
    ).toBe('ocd-organization/cj');
    expect(openstatesCommitteeIdentity({ directory: {} })).toBeNull();
  });

  it('derives only exact first-party Florida notice identities', () => {
    expect(floridaOfficialIdentityFromEvent(EVENT)).toBe('fl:senate:meeting:7000');
    expect(
      floridaOfficialIdentityFromEvent({
        ...EVENT,
        sources: [
          { url: 'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193' },
        ],
      }),
    ).toBe('fl:house:meeting:15193');
    expect(
      floridaOfficialIdentityFromEvent({
        ...EVENT,
        sources: [
          ...EVENT.sources!,
          { url: 'https://www.flhouse.gov/Sections/Committees/meetingnotice.aspx?MeetingId=15193' },
        ],
      }),
    ).toBeNull();
  });

  it('maps committee identity, agenda bill, official media, documents, and exact time', () => {
    const committees = new Map([
      [
        'ocd-organization/d985568b-8718-4da2-9e2d-543cb9a0547e',
        {
          stateCommitteeId: 'FL-upper-criminal-justice',
          name: 'Criminal Justice',
          chamber: 'senate' as const,
          session: '2026',
          bodySourceKey: 'fl:senate:CJ',
        },
      ],
    ]);
    const bills = new Map([['SB50', { id: 'fl-2026-sb50', sessionKey: '2026' }]]);
    const observation = openstatesEventObservation(EVENT, committees, bills);
    expect(observation).not.toBeNull();
    validateCalendarObservation(observation!);
    expect(observation).toMatchObject({
      officialIdentity: 'fl:senate:meeting:7000',
      chamber: 'senate',
      stateCommitteeId: 'FL-upper-criminal-justice',
      bodySourceKey: 'fl:senate:CJ',
      fields: {
        location: 'Mallory Horne Committee Room',
        watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/7000',
        time: {
          date: '2026-01-12',
          precision: 'instant',
          startsAt: '2026-01-12T18:30:00.000Z',
          endsAt: '2026-01-12T20:30:00.000Z',
        },
        agenda: [
          expect.objectContaining({
            kind: 'bill',
            bill: {
              scope: 'state',
              id: 'fl-2026-sb50',
              jurisdiction: 'FL',
              session: '2026',
            },
          }),
        ],
      },
    });
    expect(observation!.fields.documents?.map((document) => document.kind)).toEqual(
      expect.arrayContaining(['agenda', 'attendance', 'video', 'audio']),
    );
  });

  it('retains an unmapped stable organization without guessing a committee profile', () => {
    const observation = openstatesEventObservation(EVENT, new Map(), new Map());
    expect(observation).toMatchObject({
      chamber: 'senate',
      stateCommitteeId: null,
      completeness: 'partial',
    });
    expect(observation?.issues).toContain(
      'OpenStates committee organization is not yet crosswalked to a canonical state committee.',
    );
  });

  it('rejects a row with no attributable legislative chamber', () => {
    expect(
      openstatesEventObservation(
        { ...EVENT, name: 'Policy briefing', participants: [] },
        new Map(),
        new Map(),
      ),
    ).toBeNull();
  });
});
