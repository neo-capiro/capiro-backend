import {
  client,
  clientId,
  deferred,
  grouped,
  harness,
  inputOf,
  installHooks,
  meeting,
  now,
  tenantId,
  userId,
} from '../../test/fixtures/intelligence-portfolio.js';

installHooks();

describe('Portfolio client rollup query scopes', () => {
  test('starts four independent tenant reads with original task/shared-meeting filters', async () => {
    const tasks = deferred<unknown[]>();
    const h = harness({ rows: { taskCounts: tasks.promise } });
    const pending = h.service.getPortfolioRollup(tenantId);
    await h.started('workCounts');
    expect(inputOf(h, 'taskCounts')).toEqual({
      by: ['clientId'],
      where: { status: { in: ['todo', 'in_progress', 'blocked'] }, clientId: { not: null } },
      _count: { id: true },
    });
    expect(inputOf(h, 'billCounts')).toEqual({ by: ['clientId'], _count: { id: true } });
    expect(inputOf(h, 'meetings')).toEqual({
      where: {
        startsAt: { gte: now },
        visibility: 'shared',
        status: { not: 'cancelled' },
        clientId: { not: null },
      },
      select: { id: true, clientId: true, startsAt: true, subject: true },
      orderBy: { startsAt: 'asc' },
    });
    expect(inputOf(h, 'workCounts')).toEqual({
      by: ['clientId'],
      where: { status: 'in_progress', clientId: { not: null } },
      _count: { id: true },
    });
    expect(
      ['taskCounts', 'billCounts', 'meetings', 'workCounts'].map(
        (operation) => h.callsOf(operation)[0]!.transaction,
      ),
    ).toEqual([1, 2, 3, 4]);
    tasks.resolve([]);
    expect(await pending).toEqual({ rollup: {} });
  });
  test.each(['taskCounts', 'billCounts', 'meetings', 'workCounts'])(
    'keeps %s failure fatal',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({ errors: { [operation]: error } });
      await expect(h.service.getPortfolioRollup(tenantId)).rejects.toBe(error);
      expect(h.transactions).toHaveLength(4);
    },
  );
});

describe('Portfolio client rollup merge authority', () => {
  test('keeps encounter order, later count overwrites, first meeting and zero defaults for new keys', async () => {
    const h = harness({
      rows: {
        taskCounts: [grouped(clientId, 2), grouped(clientId, 3)],
        billCounts: [grouped(clientId, 4), grouped('bill-only', 5)],
        meetings: [
          meeting({ id: 'first' }),
          meeting({ id: 'later', startsAt: new Date('2026-10-15T14:00:00Z') }),
          meeting({ id: 'meeting-only', clientId: 'meeting-only' }),
        ],
        workCounts: [grouped('work-only', 1), grouped(clientId, 9)],
      },
    });
    const result = await h.service.getPortfolioRollup(tenantId);
    expect(Object.keys(result.rollup)).toEqual([
      clientId,
      'bill-only',
      'meeting-only',
      'work-only',
    ]);
    expect(result.rollup[clientId]).toEqual({
      attentionCount: 3,
      intelCount: 4,
      nextTouch: { id: 'first', startsAt: '2026-10-14T14:00:00.000Z', subject: 'Research meeting' },
      workCount: 9,
    });
    expect(result.rollup['bill-only']).toEqual({
      attentionCount: 0,
      intelCount: 5,
      nextTouch: null,
      workCount: 0,
    });
    expect(result.rollup['work-only']).toEqual({
      attentionCount: 0,
      intelCount: 0,
      nextTouch: null,
      workCount: 1,
    });
    expect(h.callsOf('clients')).toEqual([]);
  });
});

describe('Portfolio PE summary watch and delta authority', () => {
  test('returns before catalogs when no tenant-wide watches exist', async () => {
    const h = harness();
    expect(await h.service.getPortfolioPeSummary(tenantId, userId)).toEqual({
      netDeltaPct: null,
      peAttribution: {},
      watchedCount: 0,
    });
    expect(inputOf(h, 'watches')).toEqual({ where: { tenantId }, select: { peCode: true } });
    expect(h.callsOf('deltas')).toEqual([]);
    expect(h.callsOf('capabilities')).toEqual([]);
  });
  test('deduplicates watch order and averages only finite numeric deltas from live highest-materiality SQL', async () => {
    const codes = ['A', 'B', 'A', 'C', 'D', 'E', 'F'];
    const h = harness({
      rows: {
        watches: codes.map((peCode) => ({ peCode })),
        deltas: [
          { pe_code: 'A', delta_pct: 10 },
          { pe_code: 'B', delta_pct: null },
          { pe_code: 'C', delta_pct: -4 },
          { pe_code: 'D', delta_pct: '20' },
          { pe_code: 'E', delta_pct: NaN },
          { pe_code: 'F', delta_pct: Infinity },
        ],
      },
    });
    expect(await h.service.getPortfolioPeSummary(tenantId, undefined)).toEqual({
      netDeltaPct: 3,
      peAttribution: { A: [], B: [], C: [], D: [], E: [], F: [] },
      watchedCount: 6,
    });
    const query = h.callsOf('deltas')[0]!.query!;
    expect(query.values).toEqual([['A', 'B', 'C', 'D', 'E', 'F']]);
    expect(query.sql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY d.pe_code ORDER BY d.materiality_score DESC)',
    );
    expect(query.sql).toContain('d.superseded_at IS NULL');
    expect(query.sql).toContain('WHERE rn = 1');
    expect(h.callsOf('clients')).toEqual([]);
  });
});

describe('Portfolio PE summary capability and client attribution', () => {
  test('joins both PE fields, keeps names in encounter order and deduplicates equal names per code', async () => {
    const capabilities = [
      { clientId, peNumber: 'A', peNumbers: ['A', 'B', 'outside'] },
      { clientId: 'other', peNumber: 'B', peNumbers: ['A'] },
      { clientId: 'same-name', peNumber: 'A', peNumbers: ['A'] },
      { clientId: 'unknown', peNumber: 'A', peNumbers: ['B'] },
    ];
    const h = harness({
      rows: {
        watches: [{ peCode: 'A' }, { peCode: 'B' }],
        capabilities,
        clients: [client(), client({ id: 'other', name: 'Other' }), client({ id: 'same-name' })],
      },
    });
    expect(await h.service.getPortfolioPeSummary(tenantId, 'ignored-user')).toEqual({
      netDeltaPct: null,
      peAttribution: { A: ['Acme Research', 'Other'], B: ['Acme Research', 'Other'] },
      watchedCount: 2,
    });
    expect(inputOf(h, 'capabilities')).toEqual({
      where: { OR: [{ peNumber: { in: ['A', 'B'] } }, { peNumbers: { hasSome: ['A', 'B'] } }] },
      select: { clientId: true, peNumber: true, peNumbers: true },
    });
    expect(inputOf(h, 'clients')).toEqual({
      where: {
        id: { in: [clientId, 'other', 'same-name', 'unknown'] },
        status: { not: 'archived' },
      },
      select: { id: true, name: true },
    });
    expect(
      ['watches', 'capabilities', 'clients'].map(
        (operation) => h.callsOf(operation)[0]!.transaction,
      ),
    ).toEqual([1, 2, 3]);
  });
  test.each(['watches', 'deltas', 'capabilities', 'clients'])(
    'propagates %s attribution failure',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({
        rows: {
          watches: [{ peCode: 'A' }],
          capabilities: [{ clientId, peNumber: 'A', peNumbers: [] }],
        },
        errors: { [operation]: error },
      });
      await expect(h.service.getPortfolioPeSummary(tenantId, userId)).rejects.toBe(error);
    },
  );
});
