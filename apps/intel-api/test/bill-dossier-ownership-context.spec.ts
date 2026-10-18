import type { BillDossierResponse } from '../src/bill-dossier/bill-dossier.types.js';
import { harness, installHooks, type Subject } from './fixtures/bill-dossier-ownership/harness.js';
import {
  alert,
  billId,
  clientId,
  kpi,
  now,
  parentPackage,
  position,
  tenantId,
  tracking,
  vote,
} from './fixtures/bill-dossier-ownership/rows.js';

installHooks();

it('passes the exact real core funding and overview objects into late-bound client joins', async () => {
  const h = harness({
    results: { getBillFundingPositions: [position()], getParentBudgetPackage: parentPackage() },
  });
  const core = jest.spyOn(h.subject, 'buildFederalCore');
  const kpis = jest.spyOn(h.subject, 'buildKpis');
  const overview = jest.spyOn(h.subject, 'mergeAnalystOverview');
  const result = await h.service.getClientDossier(tenantId, clientId, billId, { funding: true });
  const realCore: BillDossierResponse = await core.mock.results[0]!.value;
  expect(core.mock.calls).toEqual([[billId, { funding: true }]]);
  expect(result.funding).toBe(realCore.funding);
  expect(kpis.mock.calls).toHaveLength(2);
  expect(kpis.mock.calls[0]![6]).toBe(realCore.funding);
  expect(kpis.mock.calls[1]![6]).toBe(realCore.funding);
  expect(overview.mock.calls[0]![0]).toBe(realCore.overview);
  expect(result.overview).not.toBe(realCore.overview);
  expect(kpi(result, 'funding_position').value).toBe('$120M');
});

it('resolves the original Root KPI method before a funding block getter replaces that method and preserves its receiver', async () => {
  const h = harness({
    results: { getBillFundingPositions: [position()], getParentBudgetPackage: parentPackage() },
  });
  const realLoad = h.subject.loadFunding;
  const builder = jest.spyOn(h.subject, 'buildKpis');
  const replacement: Subject['buildKpis'] = jest.fn(() => {
    throw new Error('Late KPI method lookup');
  });
  let blockReads = 0;
  const load = jest.spyOn(h.subject, 'loadFunding').mockImplementation(function (
    this: Subject,
    id,
  ) {
    return realLoad.call(this, id).then((funding) => {
      const block = funding.block;
      Object.defineProperty(funding, 'block', {
        configurable: true,
        get() {
          blockReads += 1;
          h.subject.buildKpis = replacement;
          return block;
        },
      });
      return funding;
    });
  });
  const result = await h.service.getGlobalDossier(billId, { funding: true });
  expect(load.mock.calls).toEqual([[billId]]);
  expect(blockReads).toBe(2);
  expect(builder).toHaveBeenCalledTimes(1);
  expect(builder.mock.contexts).toEqual([h.service]);
  expect(replacement).not.toHaveBeenCalled();
  expect(result.kpis).toHaveLength(6);
  expect(kpi(result, 'funding_position').value).toBe('$120M');
});

it('pins all four context selectors, caps, separate transactions and explicit tenant/client predicates', async () => {
  const h = harness();
  await h.service.getClientDossier(tenantId, clientId, billId);
  expect(h.callsOf('tracking')[0]!.args).toEqual([{ where: { tenantId, clientId, billId } }]);
  expect(h.callsOf('alerts')[0]!.args).toEqual([
    {
      where: { tenantId, clientId, sourceType: 'bill', sourceRef: billId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        severity: true,
        createdAt: true,
        title: true,
        whyItMatters: true,
        recommendedAction: true,
      },
    },
  ]);
  expect(h.callsOf('match')[0]!.args).toEqual([
    {
      where: { tenantId, clientId, billId },
      select: { matchedTags: true, fit: true, jurisdiction: true, lastFitAt: true },
    },
  ]);
  expect(h.callsOf('clientHearings')[0]!.args).toEqual([
    {
      where: {
        tenantId,
        clientId,
        sourceType: 'combined',
        sourceRef: billId,
        status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { sourceRef: true, evidence: true, createdAt: true },
    },
  ]);
  expect(
    h.calls
      .filter((call) => call.scope === 'tenant')
      .map((call) => [call.tenantId, call.transaction]),
  ).toEqual([
    [tenantId, 1],
    [tenantId, 2],
    [tenantId, 3],
    [tenantId, 4],
  ]);
  expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit', 'commit', 'commit', 'commit']);
});

it('retains raw matched-topic text, duplicates and nonfinite numeric fit while filtering only empty/non-string tags', async () => {
  const h = harness({
    results: {
      match: {
        matchedTags: [' Ship ', '', 7, 'Ship', 'Ship', '   '],
        fit: NaN,
        jurisdiction: 'US',
        lastFitAt: now,
      },
    },
  });
  const result = await h.service.getClientDossier(tenantId, clientId, billId);
  expect(result.matchedTopics).toEqual([
    { label: ' Ship ', fit: NaN, jurisdiction: 'US', matchedAt: now.toISOString() },
    { label: 'Ship', fit: NaN, jurisdiction: 'US', matchedAt: now.toISOString() },
    { label: 'Ship', fit: NaN, jurisdiction: 'US', matchedAt: now.toISOString() },
  ]);
});

it.each([
  ['support', 'med', 'support', 'med'],
  ['Support', 'medium', null, null],
  ['unknown', 'unknown', null, null],
] as const)(
  'preserves exact tracking token normalization for %s/%s',
  async (positionValue, priority, expectedPosition, expectedPriority) => {
    const h = harness({
      results: {
        tracking: tracking({
          position: positionValue,
          priority,
          note: 'Legacy note',
          analystNote: '',
        }),
      },
    });
    const result = await h.service.getClientDossier(tenantId, clientId, billId);
    expect(result.tracking).toMatchObject({
      tracked: true,
      position: expectedPosition,
      priority: expectedPriority,
      analystNote: '',
      expected: null,
    });
    expect(result.overview.whyItMatters).toBeNull();
  },
);

it('does not create an expected milestone from confidence or update metadata alone', async () => {
  const h = harness({
    results: {
      tracking: tracking({
        expectedConfidence: 'high',
        expectedUpdatedBy: 'analyst',
        expectedUpdatedAt: now,
      }),
    },
  });
  expect(
    (await h.service.getClientDossier(tenantId, clientId, billId)).tracking!.expected,
  ).toBeNull();
});

it.each([-1, 0, 1])(
  'uses the strict expected-window expiry comparison for offset %s',
  async (offset) => {
    const h = harness({
      results: {
        tracking: tracking({
          expectedWindowEnd: new Date(now.getTime() + offset),
          expectedRationale: 'Analyst outlook',
          expectedMilestoneType: 'floor_vote',
          expectedUpdatedAt: now,
        }),
      },
    });
    const result = await h.service.getClientDossier(tenantId, clientId, billId);
    expect(result.tracking!.expected!.stale).toBe(offset < 0);
    expect(result.overview.analystOutlook).toMatchObject({
      origin: 'analyst',
      text: 'Analyst outlook',
      asOf: now.toISOString(),
    });
  },
);

it('uses one alert result for context, first derived why-it-matters and ten unique recommendations', async () => {
  const alerts = [
    alert({ id: 'first', whyItMatters: ' Derived reason ', recommendedAction: '  Brief client  ' }),
    alert({ id: 'duplicate', whyItMatters: 'Later reason', recommendedAction: 'brief CLIENT' }),
    ...Array.from({ length: 12 }, (_, index) =>
      alert({ id: `unique-${index}`, recommendedAction: `Action ${index}` }),
    ),
  ];
  const h = harness({ results: { alerts } });
  const result = await h.service.getClientDossier(tenantId, clientId, billId);
  expect(h.callsOf('alerts')).toHaveLength(1);
  expect(result.alerts).toHaveLength(14);
  expect(result.overview.whyItMatters).toEqual({
    origin: 'derived',
    text: ' Derived reason ',
    asOf: now.toISOString(),
    source: 'Capiro alert analysis',
  });
  expect(result.recommendedActions).toHaveLength(10);
  expect(result.recommendedActions[0]).toEqual({
    text: 'Brief client',
    origin: 'derived',
    sev: 'notable',
    date: now.toISOString(),
    alertId: 'first',
  });
  expect(result.recommendedActions[9]!.text).toBe('Action 8');
});

it('keeps an analyst note authoritative over the derived alert reason and a separate analyst outlook', async () => {
  const h = harness({
    results: {
      alerts: [alert({ whyItMatters: 'Derived' })],
      tracking: tracking({ note: 'Legacy analyst', expectedRationale: 'Future outlook' }),
    },
  });
  const result = await h.service.getClientDossier(tenantId, clientId, billId);
  expect(result.overview.whyItMatters).toEqual({
    origin: 'analyst',
    text: 'Legacy analyst',
    asOf: now.toISOString(),
    source: 'Analyst note',
  });
  expect(result.overview.analystOutlook).toEqual({
    origin: 'analyst',
    text: 'Future outlook',
    asOf: null,
    expires: null,
  });
});

it('keeps passage vote KPI authority when a later procedural vote sorts first', async () => {
  const h = harness({
    results: {
      getBillVotes: [
        vote({ id: 'passage', voteDate: new Date('2026-10-12T12:00:00.000Z') }),
        vote({
          id: 'procedure',
          question: 'On Motion to Recommit',
          result: 'Failed',
          yeas: 100,
          nays: 200,
        }),
      ],
    },
  });
  const result = await h.service.getClientDossier(tenantId, clientId, billId);
  expect(result.votes[0]!.id).toBe('procedure');
  expect(kpi(result, 'latest_vote')).toMatchObject({
    value: 'Passed 230-200',
    asOf: '2026-10-12T12:00:00.000Z',
    sub: 'On Passage',
  });
});

it('deduplicates client hearing sessions, caps mentions and keeps client sessions before global hearings at the twenty-row merge cap', async () => {
  const combined = Array.from({ length: 21 }, (_, index) => ({
    sourceRef: billId,
    createdAt: now,
    evidence: {
      hearing: {
        sessionId: `session-${index}`,
        title: `Client hearing ${index}`,
        committeeId: 'committee-one',
        occurredAt: now.toISOString(),
        mentions: Array.from({ length: 12 }, (_, n) => ({
          timestampMs: n === 0 ? -1000 : n === 1 ? 3_661_000 : n * 1000,
          speakerName: 'Speaker',
          quote: n === 0 ? null : `Quote ${n}`,
        })),
      },
    },
  }));
  const h = harness({
    results: {
      clientHearings: [combined[0], combined[0], ...combined.slice(1)],
      getUpcomingHearingsForBills: [
        { hearingId: 'global-one', title: 'Public hearing', committeeName: 'Committee', date: now },
      ],
    },
  });
  const result = await h.service.getClientDossier(tenantId, clientId, billId);
  expect(result.hearings).toHaveLength(20);
  expect(result.hearings[0]!.id).toBe('session-0');
  expect(result.hearings[19]!.id).toBe('session-19');
  expect(result.hearings[0]!.mentions).toHaveLength(10);
  expect(result.hearings[0]!.mentions[0]).toEqual({ ts: '0:00', speaker: 'Speaker', quote: null });
  expect(result.hearings[0]!.mentions[1]).toEqual({
    ts: '1:01:01',
    speaker: 'Speaker',
    quote: 'Quote 1',
  });
});
