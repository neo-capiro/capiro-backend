import {
  change,
  client,
  clientId,
  deadline,
  harness,
  hearing,
  inputOf,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-portfolio.js';

installHooks();

describe('Portfolio today timeline calendar scopes', () => {
  test('uses Eastern timestamp day, UTC calendar dates and rolling 24-hour changes with exact catalog caps', async () => {
    const h = harness();
    expect(await h.service.getTodayTimeline(tenantId)).toEqual({
      events: [],
      counts: { critical: 0, notable: 0, info: 0 },
      today: '2026-10-12T04:00:00.000Z',
    });
    expect(inputOf(h, 'hearings')).toEqual({
      where: {
        AND: [
          { canonicalHearingId: null },
          { OR: [{ geographicJurisdiction: 'US' }, { geographicJurisdiction: null }] },
          {
            date: {
              gte: new Date('2026-10-12T00:00:00Z'),
              lte: new Date('2026-10-12T23:59:59.999Z'),
            },
          },
        ],
      },
      orderBy: { time: 'asc' },
      take: 30,
    });
    expect(inputOf(h, 'deadlines')).toEqual({
      where: {
        type: { in: ['PROPOSED_RULE', 'RULE'] },
        commentEndDate: {
          gte: new Date('2026-10-12T00:00:00Z'),
          lte: new Date('2026-10-12T23:59:59.999Z'),
        },
      },
      orderBy: { commentEndDate: 'asc' },
      take: 20,
    });
    expect(inputOf(h, 'changes')).toEqual({
      where: {
        detectedAt: { gte: new Date('2026-10-12T02:00:00Z') },
        severity: { in: ['critical', 'notable', 'info'] },
      },
      orderBy: { detectedAt: 'desc' },
      take: 30,
    });
    expect(inputOf(h, 'clients')).toEqual({
      where: { status: { not: 'archived' } },
      select: { id: true },
    });
    expect(
      h.calls.filter((call) => call.operation !== 'withTenant').map((call) => call.scope),
    ).toEqual(['global', 'global', 'global', 'tenant']);
  });
  test.each(['hearings', 'deadlines', 'changes', 'clients'])(
    'propagates %s failure while starting the independent readers',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({ errors: { [operation]: error } });
      await expect(h.service.getTodayTimeline(tenantId)).rejects.toBe(error);
      expect(
        h.calls.filter((call) => call.operation !== 'withTenant').map((call) => call.operation),
      ).toEqual(['hearings', 'deadlines', 'changes', 'clients']);
    },
  );
});

describe('Portfolio today timeline projection and tenancy', () => {
  test('includes neutral and tenant-touch changes, excludes foreign-only rows, and preserves stable timestamp ordering', async () => {
    const h = harness({
      rows: {
        clients: [client()],
        hearings: [hearing({ type: 'markup' })],
        deadlines: [deadline()],
        changes: [
          change({ id: 'foreign', relatedClientIds: ['foreign'] }),
          change({ id: 'touch', relatedClientIds: ['foreign', clientId], severity: 'critical' }),
          change({ id: 'neutral' }),
        ],
      },
    });
    const result = await h.service.getTodayTimeline(tenantId);
    expect(result.events.map((event) => event.id)).toEqual([
      'hearing-hear-one',
      'deadline-doc-one',
      'change-touch',
      'change-neutral',
    ]);
    expect(result.events[0]).toEqual({
      id: 'hearing-hear-one',
      kind: 'hearing',
      label: 'MARKUP',
      title: 'Science, Research hearing',
      detail: 'One, Two, Three',
      severity: 'notable',
      time: '10:00',
      timestamp: '2026-10-12T00:00:00.000Z',
      href: null,
    });
    expect(result.events[1]).toMatchObject({
      detail: 'Science / Commerce',
      severity: 'critical',
      time: 'before EOD',
    });
    expect(result.counts).toEqual({ critical: 2, notable: 2, info: 0 });
  });
  test('keeps global hearings/deadlines with no active clients and nullish presentation fallbacks', async () => {
    const h = harness({
      rows: {
        hearings: [hearing({ type: 'Markup', location: '', witnesses: [], time: null })],
        deadlines: [deadline({ commentEndDate: null, agencyNames: [] })],
        changes: [
          change({ severity: null, source: 'abcdefghijklmnopqr', description: 'x'.repeat(170) }),
          change({ id: 'foreign', relatedClientIds: [clientId] }),
        ],
      },
    });
    const value = await h.service.getTodayTimeline(tenantId);
    expect(value.events.map((event) => event.id)).toEqual([
      'hearing-hear-one',
      'change-change-one',
      'deadline-doc-one',
    ]);
    expect(value.events[0]).toMatchObject({
      label: 'HEARING',
      severity: 'info',
      detail: '',
      time: null,
    });
    expect(value.events[1]).toMatchObject({
      label: 'ABCDEFGHIJKLMNOP',
      detail: 'x'.repeat(160),
      severity: 'info',
    });
    expect(value.events[2]).toMatchObject({ timestamp: '2026-10-13T03:59:59.999Z', detail: '' });
  });
});

describe('Portfolio today timeline projection and tenancy', () => {
  test('retains an empty witness join and null empty change description', async () => {
    const h = harness({
      rows: {
        hearings: [hearing({ witnesses: [], location: null })],
        changes: [change({ description: '' })],
      },
    });
    const value = await h.service.getTodayTimeline(tenantId);
    expect(value.events[0]!.detail).toBe('');
    expect(value.events[1]!.detail).toBeNull();
  });
});

describe('Portfolio live ticker tenant-first filling', () => {
  test('queries only neutral changes when the active client set is empty', async () => {
    const h = harness({ rows: { changes: [change()] } });
    expect(await h.service.getLiveTicker(tenantId)).toEqual([
      {
        id: 'change-one',
        source: 'lda',
        title: 'Research change',
        severity: 'notable',
        detectedAt: '2026-10-12T12:00:00.000Z',
      },
    ]);
    expect(inputOf(h, 'changes')).toEqual({
      where: { id: { notIn: [] }, relatedClientIds: { isEmpty: true } },
      orderBy: { detectedAt: 'desc' },
      take: 12,
    });
  });
  test('keeps tenant-first output order even if a neutral fill is more recent', async () => {
    const h = harness({
      rows: { clients: [client()] },
      queues: {
        changes: [
          [change({ id: 'old' })],
          [change({ id: 'new', detectedAt: new Date('2026-10-13T01:00:00Z') })],
        ],
      },
    });
    expect((await h.service.getLiveTicker(tenantId, 2)).map((row) => row.id)).toEqual([
      'old',
      'new',
    ]);
    expect(inputOf(h, 'changes', 0)).toEqual({
      where: { relatedClientIds: { hasSome: [clientId] } },
      orderBy: { detectedAt: 'desc' },
      take: 2,
    });
    expect(inputOf(h, 'changes', 1)).toEqual({
      where: { id: { notIn: ['old'] }, relatedClientIds: { isEmpty: true } },
      orderBy: { detectedAt: 'desc' },
      take: 1,
    });
  });
  test('does not issue a neutral fill when tenant results already meet the limit', async () => {
    const h = harness({ rows: { clients: [client()], changes: [change()] } });
    expect(await h.service.getLiveTicker(tenantId, 1)).toHaveLength(1);
    expect(h.callsOf('changes')).toHaveLength(1);
  });
  test('reads clients but skips global changes for zero limit with no active clients', async () => {
    const h = harness();
    expect(await h.service.getLiveTicker(tenantId, 0)).toEqual([]);
    expect(h.callsOf('clients')).toHaveLength(1);
    expect(h.callsOf('changes')).toEqual([]);
  });
});

describe('Portfolio live ticker fatal readers', () => {
  test.each(['clients', 'changes'])('propagates the %s failure', async (operation) => {
    const error = new Error('Ticker unavailable');
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getLiveTicker(tenantId)).rejects.toBe(error);
  });
});
