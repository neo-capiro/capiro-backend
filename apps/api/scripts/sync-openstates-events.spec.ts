import { validateCalendarObservation } from '../src/hearing-discovery/legislative-calendar.js';
import { normalizeStateCommitteeChamber } from '../src/hearing-discovery/legislative-calendar.repository.js';
import {
  floridaOfficialCommitteeKeyFromEvent,
  floridaOfficialCommitteeEvidenceFromEvent,
  legacyOpenstatesEventIdentity,
  openstatesCommitteeIdentity,
  openstatesEventObservation,
  qualifiedCommitteeChamber,
  repairedOpenstatesSourceMetadata,
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

  it('uses publisher URLs only to qualify a committee body, never a Senate event id', () => {
    expect(floridaOfficialCommitteeKeyFromEvent(EVENT)).toBe('fl:senate:CJ');
    expect(
      floridaOfficialCommitteeKeyFromEvent({
        ...EVENT,
        sources: [{ url: 'https://www.flsenate.gov/Committees/Show/AG/MeetingNotice/7000' }],
        documents: [],
      }),
    ).toBe('fl:senate:AG');
    expect(
      floridaOfficialCommitteeKeyFromEvent({
        ...EVENT,
        sources: [
          ...EVENT.sources!,
          { url: 'https://www.flsenate.gov/Committees/Show/AG/MeetingNotice/7000' },
        ],
      }),
    ).toBeNull();
    expect(
      floridaOfficialCommitteeEvidenceFromEvent({
        ...EVENT,
        sources: [
          ...EVENT.sources!,
          { url: 'https://www.flsenate.gov/Committees/Show/AG/MeetingNotice/7000' },
        ],
      }),
    ).toEqual({ key: null, ambiguous: true });
  });

  it('maps committee identity, agenda bill, official media, documents, and exact time', () => {
    const committees = new Map([
      [
        '2026\u0000ocd-organization/d985568b-8718-4da2-9e2d-543cb9a0547e',
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
      officialIdentity: 'openstates:event:ocd-event/709f2430-b337-4039-a48b-15618e3c2576',
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
      bodySourceKey:
        'unresolved-body:openstates:ocd-organization/d985568b-8718-4da2-9e2d-543cb9a0547e',
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

  it('keeps distinct provider events that share one stale Senate notice URL', () => {
    const first = openstatesEventObservation(
      { ...EVENT, participants: [], name: 'Senate Agriculture' },
      new Map(),
      new Map(),
    )!;
    const second = openstatesEventObservation(
      {
        ...EVENT,
        id: 'ocd-event/4c91ae26-a1dc-40f0-9c43-ec4c50c6e79a',
        participants: [],
        name: 'Senate Agriculture',
        start_date: '2026-01-27T13:30:00-05:00',
      },
      new Map(),
      new Map(),
    )!;
    expect(first.officialIdentity).not.toBe(second.officialIdentity);
    expect(first.bodySourceKey).not.toBe(second.bodySourceKey);
    expect([first.officialIdentity, second.officialIdentity]).toEqual([
      'openstates:event:ocd-event/709f2430-b337-4039-a48b-15618e3c2576',
      'openstates:event:ocd-event/4c91ae26-a1dc-40f0-9c43-ec4c50c6e79a',
    ]);
  });

  it('maps an event without participants through one exact official committee code', () => {
    const observation = openstatesEventObservation(
      { ...EVENT, participants: [], name: 'Committee meeting' },
      new Map(),
      new Map(),
      new Map([
        [
          '2026\u0000fl:senate:CJ',
          {
            stateCommitteeId: 'official-cj',
            name: 'Criminal Justice',
            chamber: 'senate' as const,
            session: '2026',
            bodySourceKey: 'fl:senate:CJ',
          },
        ],
      ]),
    );
    expect(observation).toMatchObject({
      chamber: 'senate',
      stateCommitteeId: 'official-cj',
      bodySourceKey: 'fl:senate:CJ',
    });
  });

  it('never assigns a publisher committee from a different session', () => {
    const observation = openstatesEventObservation(
      { ...EVENT, participants: [], name: 'Senate committee meeting' },
      new Map(),
      new Map(),
      new Map([
        [
          '2025\u0000fl:senate:CJ',
          {
            stateCommitteeId: 'historical-cj',
            name: 'Criminal Justice',
            chamber: 'senate' as const,
            session: '2025',
            bodySourceKey: 'fl:senate:CJ',
          },
        ],
      ]),
    );
    expect(observation).toMatchObject({ session: '2026', stateCommitteeId: null });
  });

  it('fails closed when organization and publisher committee evidence conflict', () => {
    const observation = openstatesEventObservation(
      {
        ...EVENT,
        sources: [{ url: 'https://www.flsenate.gov/Committees/Show/AG/MeetingNotice/7000' }],
        documents: [],
      },
      new Map([
        [
          '2026\u0000ocd-organization/d985568b-8718-4da2-9e2d-543cb9a0547e',
          {
            stateCommitteeId: 'official-cj',
            name: 'Criminal Justice',
            chamber: 'senate' as const,
            session: '2026',
            bodySourceKey: 'fl:senate:CJ',
          },
        ],
      ]),
      new Map(),
      new Map([
        [
          '2026\u0000fl:senate:AG',
          {
            stateCommitteeId: 'official-ag',
            name: 'Agriculture',
            chamber: 'senate' as const,
            session: '2026',
            bodySourceKey: 'fl:senate:AG',
          },
        ],
      ]),
    );
    expect(observation).toMatchObject({
      session: '2026',
      stateCommitteeId: null,
      bodySourceKey:
        'unresolved-body:openstates:ocd-organization/d985568b-8718-4da2-9e2d-543cb9a0547e',
    });
    expect(observation?.issues).toContain(
      'OpenStates organization and Florida publisher committee evidence conflict; no committee profile was asserted.',
    );
  });

  it('does not assert one mapped committee for a multi-organization event', () => {
    const observation = openstatesEventObservation(
      {
        ...EVENT,
        participants: [
          ...EVENT.participants!,
          {
            entity_type: 'organization',
            name: 'Unmapped co-host',
            organization: { id: 'ocd-organization/unmapped', name: 'Unmapped co-host' },
          },
        ],
        sources: [],
        documents: [],
      },
      new Map([
        [
          '2026\u0000ocd-organization/d985568b-8718-4da2-9e2d-543cb9a0547e',
          {
            stateCommitteeId: 'official-cj',
            name: 'Criminal Justice',
            chamber: 'senate' as const,
            session: '2026',
            bodySourceKey: 'fl:senate:CJ',
          },
        ],
      ]),
      new Map(),
    );
    expect(observation).toMatchObject({ stateCommitteeId: null, eventType: 'joint' });
    expect(observation?.issues).toContain(
      'Multiple committee organizations were published; no single committee profile was asserted.',
    );
  });

  it('marks conflicting publisher committee URLs as a run-integrity error', () => {
    const observation = openstatesEventObservation(
      {
        ...EVENT,
        sources: [
          ...EVENT.sources!,
          { url: 'https://www.flsenate.gov/Committees/Show/AG/MeetingNotice/7000' },
        ],
      },
      new Map(),
      new Map(),
    );
    expect(observation?.issues).toContain(
      'Florida publisher URLs identify multiple committees; no committee profile was asserted.',
    );
  });

  it('derives a legacy repair target only from fully qualified stored evidence', () => {
    const metadata = {
      legislative: {
        jurisdiction: 'FL',
        session: '2026',
        chamber: 'senate',
        stateCommitteeId: null,
        bodySourceKey: 'openstates:event:ocd-event/709f2430-b337-4039-a48b-15618e3c2576',
        officialIdentity: 'fl:senate:meeting:7000',
      },
    };
    expect(legacyOpenstatesEventIdentity(metadata, '2026', 'fl:senate:meeting:7000')).toBe(
      'ocd-event/709f2430-b337-4039-a48b-15618e3c2576',
    );
    expect(
      legacyOpenstatesEventIdentity(
        { legislative: { ...metadata.legislative, stateCommitteeId: 'official-cj' } },
        '2026',
        'fl:senate:meeting:7000',
      ),
    ).toBeNull();
    expect(legacyOpenstatesEventIdentity(metadata, '2026', 'fl:senate:meeting:9999')).toBeNull();
    expect(
      repairedOpenstatesSourceMetadata(metadata, 'ocd-event/709f2430-b337-4039-a48b-15618e3c2576'),
    ).toMatchObject({
      legislative: {
        officialIdentity: 'openstates:event:ocd-event/709f2430-b337-4039-a48b-15618e3c2576',
        bodySourceKey: 'openstates:event:ocd-event/709f2430-b337-4039-a48b-15618e3c2576',
      },
    });
  });

  it('qualifies state committee upper/lower chamber vocabulary', () => {
    expect(normalizeStateCommitteeChamber('upper')).toBe('senate');
    expect(normalizeStateCommitteeChamber('lower')).toBe('house');
    expect(normalizeStateCommitteeChamber('joint')).toBe('joint');
    expect(normalizeStateCommitteeChamber('unknown')).toBeNull();
    expect(qualifiedCommitteeChamber('upper', 'fl:senate:CJ')).toBe('senate');
    expect(qualifiedCommitteeChamber('lower', 'fl:house:AG')).toBe('house');
    expect(qualifiedCommitteeChamber(null, 'fl:senate:CJ')).toBeNull();
    expect(qualifiedCommitteeChamber('upper', 'fl:house:CJ')).toBeNull();
  });
});
