/**
 * The projection + diff rules. Three things here are load-bearing enough that a
 * regression would be a production defect rather than a test failure:
 *
 *  1. AUTHORITY — a lower-priority source must never overwrite a field a
 *     higher-priority source reported. Break this and docs.house.gov's thin row
 *     silently erases Congress.gov's witnesses.
 *  2. LEGACY OWNERSHIP — for the ids `sync-hearings.ts` writes, this phase may
 *     FILL an empty display column but must not fight the other writer for a
 *     populated one. Break this and two jobs flip the same column every run.
 *  3. REVISION SEMANTICS — `source_revision` bumps only when a previously
 *     POPULATED field changes. Break this and every backfill looks to a consumer
 *     like "this changed under me".
 */
import {
  legacyOwnedId,
  planCanonicalWrite,
  projectCanonical,
  type ExistingHearing,
  type ProjectableObservation,
} from './canonical-diff.js';

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date('2026-08-20T12:00:00.000Z');
const WRITE_OPTS = {
  now: NOW,
  sourceUrl: 'https://www.congress.gov/event/119th-Congress/house-event/119504',
  parserVersion: 'test/1',
};

function obs(overrides: Partial<ProjectableObservation> = {}): ProjectableObservation {
  return {
    sourceId: 'src-congress',
    adapterKey: 'congress-gov',
    sourcePriority: 10,
    lastSeenAt: NOW,
    sourceUpdatedAt: new Date('2026-08-19T10:00:00.000Z'),
    congress: 119,
    chamber: 'house',
    committeeSystemCode: 'hsif00',
    subcommitteeSystemCode: null,
    committeeName: 'House Committee on Energy and Commerce',
    title: 'Oversight of the NRC',
    eventType: 'Hearing',
    eventStatus: 'scheduled',
    visibility: 'public',
    startsAt: new Date('2026-09-17T14:00:00.000Z'),
    calendarDate: day('2026-09-17'),
    displayTime: '10:00 AM',
    location: 'Rayburn House Office Building, Room 2123',
    officialPageUrl: 'https://www.congress.gov/event/119th-Congress/house-event/119504',
    witnesses: ['Jane Doe, Chair, NRC'],
    agendaBillIds: ['119-hr-1'],
    streamCandidates: [],
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingHearing> = {}): ExistingHearing {
  return {
    id: 'cm-119-119504',
    congress: 119,
    chamber: 'House',
    committeeName: 'House Committee on Energy and Commerce',
    committeeCode: 'hsif00',
    committeeSystemCode: 'hsif00',
    subcommitteeSystemCode: null,
    title: 'Oversight of the NRC',
    type: 'hearing',
    date: day('2026-09-17'),
    startsAt: new Date('2026-09-17T14:00:00.000Z'),
    time: '10:00 AM',
    location: 'Rayburn House Office Building, Room 2123',
    url: 'https://www.congress.gov/event/119th-Congress/house-event/119504',
    witnesses: ['Jane Doe, Chair, NRC'],
    eventStatus: 'scheduled',
    visibility: 'public',
    sourceRevision: 1,
    lastOfficialUpdateAt: new Date('2026-08-19T10:00:00.000Z'),
    streamAvailability: 'unknown',
    coverageStatus: 'discovered',
    ...overrides,
  };
}

describe('legacyOwnedId', () => {
  it('recognises both id conventions sync-hearings.ts writes', () => {
    expect(legacyOwnedId('cm-119-119504')).toBe(true);
    expect(legacyOwnedId('119-58001-2026-09-17')).toBe(true);
  });

  it('does not claim ids only this phase mints', () => {
    expect(legacyOwnedId('sen-119-ssas00-20260917-0930')).toBe(false);
    expect(legacyOwnedId('cs-119-hsif00-20260917-1000-abc1234567')).toBe(false);
  });
});

describe('projectCanonical authority', () => {
  it('lets the best-priority source win a contested field', () => {
    const projected = projectCanonical([
      obs({ location: 'Rayburn 2123', sourcePriority: 10, adapterKey: 'congress-gov' }),
      obs({
        location: 'Longworth 1100',
        sourcePriority: 50,
        adapterKey: 'committee-site',
        sourceId: 'src-site',
      }),
    ]);
    expect(projected.location).toBe('Rayburn 2123');
    expect(projected.fieldSources.location).toBe('congress-gov');
  });

  it('lets a WORSE-priority source fill a field the better one left empty', () => {
    const projected = projectCanonical([
      obs({ witnesses: [], sourcePriority: 10 }),
      obs({
        witnesses: ['Ada Lovelace, Director, OMB'],
        sourcePriority: 50,
        adapterKey: 'committee-site',
      }),
    ]);
    expect(projected.witnesses).toEqual(['Ada Lovelace, Director, OMB']);
    expect(projected.fieldSources.witnesses).toBe('committee-site');
  });

  it('breaks a priority tie with the freshest observation', () => {
    const older = obs({
      location: 'Old room',
      sourcePriority: 20,
      lastSeenAt: new Date('2026-08-18T00:00:00.000Z'),
      adapterKey: 'house-repository',
    });
    const newer = obs({
      location: 'New room',
      sourcePriority: 20,
      lastSeenAt: new Date('2026-08-20T00:00:00.000Z'),
      adapterKey: 'senate-schedule',
    });
    expect(projectCanonical([older, newer]).location).toBe('New room');
  });

  it('takes the best-authority witness ARRAY rather than a union, so a removal is visible', () => {
    const projected = projectCanonical([
      obs({ witnesses: ['A'], sourcePriority: 10 }),
      obs({ witnesses: ['A', 'B'], sourcePriority: 50, adapterKey: 'committee-site' }),
    ]);
    // A union would resurrect B, which the authoritative source dropped.
    expect(projected.witnesses).toEqual(['A']);
  });

  it('DOES union stream candidates, since two players are two real candidates', () => {
    const projected = projectCanonical([
      obs({
        streamCandidates: [{ provider: 'house-live', officialPageUrl: 'https://a.house.gov' }],
      }),
      obs({
        sourcePriority: 50,
        adapterKey: 'committee-site',
        streamCandidates: [{ provider: 'youtube', officialPageUrl: 'https://youtube.com/x' }],
      }),
    ]);
    expect(projected.streamCandidates).toHaveLength(2);
  });

  it('takes the newest official update timestamp across every source', () => {
    const projected = projectCanonical([
      obs({ sourceUpdatedAt: new Date('2026-08-01T00:00:00.000Z') }),
      obs({ sourceUpdatedAt: new Date('2026-08-15T00:00:00.000Z'), sourcePriority: 50 }),
    ]);
    expect(projected.lastOfficialUpdateAt?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });
});

describe('planCanonicalWrite — new hearing', () => {
  it('emits a hearing_announced signal and no patch', () => {
    const plan = planCanonicalWrite(null, projectCanonical([obs()]), WRITE_OPTS);
    expect(plan.patch).toEqual({});
    expect(plan.updates.map((u) => u.updateType)).toEqual(['hearing_announced']);
    expect(plan.updates[0]?.committeeSystemCode).toBe('hsif00');
  });

  it('emits nothing when there is no committee to file the announcement under', () => {
    const plan = planCanonicalWrite(
      null,
      projectCanonical([obs({ committeeSystemCode: null })]),
      WRITE_OPTS,
    );
    expect(plan.updates).toHaveLength(0);
  });
});

describe('planCanonicalWrite — legacy-owned row', () => {
  it('reports a date change as a signal but does NOT write the column', () => {
    const plan = planCanonicalWrite(
      existing(),
      projectCanonical([obs({ calendarDate: day('2026-09-24') })]),
      WRITE_OPTS,
    );
    expect(plan.patch.date).toBeUndefined();
    expect(plan.changedFields).toContain('date');
    const dateChanged = plan.updates.find((u) => u.updateType === 'date_changed');
    expect(dateChanged).toMatchObject({ previousValue: '2026-09-17', newValue: '2026-09-24' });
  });

  it('FILLS an empty legacy column', () => {
    const plan = planCanonicalWrite(
      existing({ location: null }),
      projectCanonical([obs()]),
      WRITE_OPTS,
    );
    expect(plan.patch.location).toBe('Rayburn House Office Building, Room 2123');
    expect(plan.filledFields).toContain('location');
    // Filling is additive, so no room_changed signal and no revision bump.
    expect(plan.updates.find((u) => u.updateType === 'room_changed')).toBeUndefined();
    expect(plan.patch.sourceRevision).toBeUndefined();
  });

  it('writes the canonical Phase 2 columns even on a legacy-owned row', () => {
    const plan = planCanonicalWrite(
      existing({ committeeSystemCode: null, congress: null }),
      projectCanonical([obs()]),
      WRITE_OPTS,
    );
    expect(plan.patch.committeeSystemCode).toBe('hsif00');
    expect(plan.patch.congress).toBe(119);
  });

  it('does not overwrite a legacy title, since the other writer prefixes status into it', () => {
    const plan = planCanonicalWrite(
      existing({ title: '[Postponed] Something else entirely' }),
      projectCanonical([obs({ title: 'Oversight of the NRC' })]),
      WRITE_OPTS,
    );
    expect(plan.patch.title).toBeUndefined();
  });
});

describe('planCanonicalWrite — phase-owned row', () => {
  const senateId = 'sen-119-ssas00-20260917-0930';

  it('DOES write a rescheduled date on a row no other job owns', () => {
    const plan = planCanonicalWrite(
      existing({ id: senateId }),
      projectCanonical([obs({ calendarDate: day('2026-09-24') })]),
      WRITE_OPTS,
    );
    expect(plan.patch.date).toEqual(day('2026-09-24'));
    expect(plan.patch.sourceRevision).toBe(2);
  });

  it('writes a retitle on a phase-owned row', () => {
    const plan = planCanonicalWrite(
      existing({ id: senateId }),
      projectCanonical([obs({ title: 'A completely different hearing subject' })]),
      WRITE_OPTS,
    );
    expect(plan.patch.title).toBe('A completely different hearing subject');
  });
});

describe('planCanonicalWrite — status transitions', () => {
  it('records a cancellation as both a column write and a change signal', () => {
    const plan = planCanonicalWrite(
      existing(),
      projectCanonical([obs({ eventStatus: 'canceled' })]),
      WRITE_OPTS,
    );
    expect(plan.patch.eventStatus).toBe('canceled');
    expect(plan.updates.map((u) => u.updateType)).toContain('canceled');
    expect(plan.patch.sourceRevision).toBe(2);
  });

  it('records a postponement', () => {
    const plan = planCanonicalWrite(
      existing(),
      projectCanonical([obs({ eventStatus: 'postponed' })]),
      WRITE_OPTS,
    );
    expect(plan.updates.map((u) => u.updateType)).toContain('postponed');
  });

  it('does not clear a cancellation when a source simply says nothing about status', () => {
    const plan = planCanonicalWrite(
      existing({ eventStatus: 'canceled' }),
      projectCanonical([obs({ eventStatus: null })]),
      WRITE_OPTS,
    );
    expect(plan.patch.eventStatus).toBeUndefined();
  });
});

describe('planCanonicalWrite — witnesses', () => {
  it('signals additions and removals', () => {
    const plan = planCanonicalWrite(
      existing({ witnesses: ['Jane Doe, Chair, NRC', 'Gone Person, X, Y'] }),
      projectCanonical([obs({ witnesses: ['Jane Doe, Chair, NRC', 'New Person, A, B'] })]),
      WRITE_OPTS,
    );
    const types = plan.updates.map((u) => u.updateType);
    expect(types).toContain('witness_added');
    expect(types).toContain('witness_removed');
    expect(plan.updates.find((u) => u.updateType === 'witness_added')?.newValue).toBe(
      'New Person, A, B',
    );
  });

  it('fills an empty witness list even on a legacy-owned row', () => {
    const plan = planCanonicalWrite(
      existing({ witnesses: [] }),
      projectCanonical([obs({ witnesses: ['Jane Doe, Chair, NRC'] })]),
      WRITE_OPTS,
    );
    expect(plan.patch.witnesses).toEqual(['Jane Doe, Chair, NRC']);
    expect(plan.filledFields).toContain('witnesses');
  });
});

describe('planCanonicalWrite — idempotence and noise suppression', () => {
  it('produces an empty plan when nothing changed', () => {
    const plan = planCanonicalWrite(existing(), projectCanonical([obs()]), WRITE_OPTS);
    expect(plan.changedFields).toEqual([]);
    expect(plan.filledFields).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.patch.sourceRevision).toBeUndefined();
  });

  it('ignores sub-minute jitter in a re-published start instant', () => {
    // Congress.gov re-publishes the same start with second-level drift often
    // enough that exact equality would emit a phantom time_changed every run.
    const jittered = obs({ startsAt: new Date('2026-09-17T14:00:41.000Z') });
    const plan = planCanonicalWrite(existing(), projectCanonical([jittered]), WRITE_OPTS);
    expect(plan.updates.find((u) => u.updateType === 'time_changed')).toBeUndefined();
  });

  it('gives the same change the same contentHash on a repeat run, so the feed dedupes', () => {
    const project = projectCanonical([obs({ location: 'Longworth 1100' })]);
    const first = planCanonicalWrite(existing(), project, WRITE_OPTS);
    const second = planCanonicalWrite(existing(), project, {
      ...WRITE_OPTS,
      now: new Date('2026-08-21T12:00:00.000Z'),
    });
    expect(first.updates[0]?.contentHash).toBe(second.updates[0]?.contentHash);
  });
});
