import {
  affectedAgendaBills,
  legislativeEventId,
  projectLegislativeObservation,
  validateCalendarObservation,
  type LegislativeObservation,
  type CalendarFacts,
} from './legislative-calendar.js';

const source = { id: 'official', priority: 10 };
const now = new Date('2026-09-11T12:00:00Z');
function notice(): LegislativeObservation {
  return {
    jurisdiction: 'FL',
    session: '2026',
    chamber: 'senate',
    officialIdentity: 'notice:123',
    bodySourceKey: 'fl:senate:fp',
    bodyName: 'Fiscal Policy',
    stateCommitteeId: null,
    eventType: 'committee',
    sourceUrl: 'https://www.flsenate.gov/notice/123',
    publishedAt: '2026-09-10T12:00:00Z',
    completeness: 'complete',
    issues: [],
    completeFields: ['title', 'status', 'time', 'location', 'agenda', 'documents'],
    fields: {
      title: 'Committee meeting',
      status: 'scheduled',
      location: '412 K',
      time: {
        date: '2026-09-15',
        rawTime: '9:00 AM',
        timezone: 'America/New_York',
        precision: 'instant',
        startsAt: '2026-09-15T13:00:00Z',
        endsAt: null,
      },
      agenda: [
        {
          key: 'bill:123',
          position: 0,
          kind: 'bill',
          title: 'SB 123',
          bill: { scope: 'state', jurisdiction: 'FL', session: '2026', id: 'fl-2026-sb123' },
          sourceUrl: 'https://www.flsenate.gov/notice/123',
          evidence: { identifier: 'SB 123' },
        },
      ],
      documents: [],
    },
  };
}

describe('Legislative calendar source contract', () => {
  it('retains closed visibility through incomplete and lower-authority calendar refreshes', () => {
    const closed = notice();
    closed.fields.visibility = 'private';
    closed.completeFields.push('visibility');
    const projected = projectLegislativeObservation({}, {}, closed, source, now);
    expect(projected.facts.visibility).toBe('private');
    const partial = projectLegislativeObservation(
      projected.facts,
      projected.provenance,
      notice(),
      source,
      now,
    );
    expect(partial.facts.visibility).toBe('private');
    expect(partial.changedFields).not.toContain('visibility');
    const weak = { ...closed, fields: { ...closed.fields, visibility: 'public' as const } };
    expect(
      projectLegislativeObservation(
        projected.facts,
        projected.provenance,
        weak,
        { id: 'secondary', priority: 100 },
        now,
      ).facts.visibility,
    ).toBe('private');
    expect(() =>
      validateCalendarObservation({ ...closed, fields: { visibility: 'invalid' as 'private' } }),
    ).toThrow('visibility');
  });

  it('keeps identity through reschedule and separates jurisdiction, session, body and notice', () => {
    const n = notice(),
      id = legislativeEventId(n);
    expect(
      legislativeEventId({ ...n, fields: { ...n.fields, title: 'Renamed', location: 'New room' } }),
    ).toBe(id);
    for (const change of [
      { jurisdiction: 'TX' },
      { session: '2026x999' },
      { bodySourceKey: 'fl:house:fp' },
      { officialIdentity: 'notice:124' },
    ])
      expect(legislativeEventId({ ...n, ...change })).not.toBe(id);
    expect(() => legislativeEventId({ ...n, jurisdiction: 'US' })).toThrow();
  });
  it('replay and later source checks produce no material change', () => {
    const n = notice();
    const first = projectLegislativeObservation({}, {}, n, source, now);
    const next = projectLegislativeObservation(
      first.facts,
      first.provenance,
      n,
      source,
      new Date('2026-09-12'),
    );
    expect(next.changedFields).toEqual([]);
    expect(next.provenance).toEqual(first.provenance);
  });
  it('retains every A to B to A to B transition and none for polling at B', () => {
    const n = notice();
    let current = projectLegislativeObservation({}, {}, n, source, now);
    for (const location of ['B', '412 K', 'B']) {
      current = projectLegislativeObservation(
        current.facts,
        current.provenance,
        { ...n, fields: { ...n.fields, location } },
        source,
        now,
      );
      expect(current.changedFields).toEqual(['location']);
    }
    expect(
      projectLegislativeObservation(
        current.facts,
        current.provenance,
        { ...n, fields: { ...n.fields, location: 'B' } },
        source,
        now,
      ).changedFields,
    ).toEqual([]);
  });
  it('clears explicitly withdrawn time, room and final agenda member but preserves absent/partial fields', () => {
    const n = notice(),
      first = projectLegislativeObservation({}, {}, n, source, now);
    const partial = projectLegislativeObservation(
      first.facts,
      first.provenance,
      { ...n, fields: { location: null, agenda: [] }, completeFields: [], completeness: 'partial' },
      source,
      now,
    );
    expect(partial.facts).toEqual(first.facts);
    const withdrawn = projectLegislativeObservation(
      first.facts,
      first.provenance,
      {
        ...n,
        fields: {
          ...n.fields,
          location: null,
          agenda: [],
          time: {
            ...n.fields.time!,
            rawTime: 'Upon adjournment',
            startsAt: null,
            precision: 'relative',
          },
        },
      },
      source,
      now,
    );
    expect(withdrawn.changedFields).toEqual(['time', 'location', 'agenda']);
    expect(withdrawn.facts.time?.startsAt).toBeNull();
    expect(withdrawn.facts.agenda).toEqual([]);
    const stale = projectLegislativeObservation(
      withdrawn.facts,
      withdrawn.provenance,
      n,
      { id: 'lower-authority', priority: 50 },
      now,
    );
    expect(stale.facts.agenda).toEqual([]);
  });
  it('does not let an older official notice override a newer confirmed revision', () => {
    const n = notice();
    const newer = {
      ...n,
      publishedAt: '2026-09-11T10:00:00Z',
      fields: { ...n.fields, location: 'New room' },
    };
    const first = projectLegislativeObservation(
      {},
      {},
      newer,
      { id: 'confirmed', priority: 20 },
      now,
    );
    expect(
      projectLegislativeObservation(first.facts, first.provenance, n, source, now).facts.location,
    ).toBe('New room');
  });
  it('cancellation and removal retain the prior affected bill audience', () => {
    const before = notice().fields;
    const after: Partial<CalendarFacts> = { ...before, status: 'canceled', agenda: [] };
    expect(affectedAgendaBills(before, after)).toEqual(['fl-2026-sb123']);
    const first = projectLegislativeObservation({}, {}, notice(), source, now);
    expect(
      projectLegislativeObservation(
        first.facts,
        first.provenance,
        { ...notice(), fields: after },
        source,
        now,
      ).changedFields,
    ).toEqual(['status', 'agenda']);
  });
  it('supports no-bill joint meetings and preserves Pacific/DST instants without an invented end', () => {
    const n = notice();
    n.chamber = 'joint';
    n.fields.agenda = [];
    n.fields.time = {
      date: '2026-11-01',
      timezone: 'America/Los_Angeles',
      rawTime: '1:30 AM PST',
      precision: 'instant',
      startsAt: '2026-11-01T09:30:00Z',
      endsAt: null,
    };
    expect(() => validateCalendarObservation(n)).not.toThrow();
    expect(projectLegislativeObservation({}, {}, n, source, now).facts.time).toEqual(n.fields.time);
  });
  it('rejects impossible dates, invented uncertain instants and cross-session/federal bill identity', () => {
    const n = notice();
    expect(() =>
      validateCalendarObservation({
        ...n,
        fields: { time: { ...n.fields.time!, date: '2026-02-31' } },
      }),
    ).toThrow('calendar day');
    expect(() =>
      validateCalendarObservation({
        ...n,
        fields: { time: { ...n.fields.time!, precision: 'relative' } },
      }),
    ).toThrow('Uncertain time');
    for (const bill of [
      { ...n.fields.agenda![0]!.bill!, scope: 'federal' as const },
      { ...n.fields.agenda![0]!.bill!, session: '2025' },
    ])
      expect(() =>
        validateCalendarObservation({
          ...n,
          fields: { agenda: [{ ...n.fields.agenda![0]!, bill }] },
        }),
      ).toThrow('scope');
  });
});
