import {
  harness,
  installHooks,
  embedText,
  args,
} from './fixtures/tracker-board-ownership/harness.js';
import {
  billId,
  clientId,
  tenantId,
  federal,
  state,
  stateId,
  watchlist,
  deferred,
} from './fixtures/tracker-board-ownership/rows.js';

installHooks();

it('stops after real watchlist compilation when no topic or issue-area terms remain', async () => {
  const h = harness({
    results: {
      'watchlist.findFirst': watchlist({ issueAreas: [], jurisdictions: [] }),
      'watchlistTopic.findMany': [],
      'watchlistTerm.findMany': [],
    },
  });
  expect(await h.service.getRecommendations(tenantId, clientId)).toEqual([]);
  expect(h.callsOf('watchlistTerm.findMany')).toHaveLength(1);
  expect(h.callsOf('intelFeedback.findMany')).toHaveLength(0);
  expect(h.callsOf('federalCandidates')).toHaveLength(0);
  expect(embedText).not.toHaveBeenCalled();
});

it('binds real normalized embedding/vector helpers and current-Congress keyword SQL after compilation', async () => {
  jest.mocked(embedText).mockResolvedValue([0.25, -0.5]);
  const h = harness({
    results: { semantic: [{ sourceId: billId, score: 0.8 }], federalRows: [federal()] },
  });
  const recs = await h.service.getRecommendations(tenantId, clientId);
  expect(embedText).toHaveBeenCalledWith('Grid. Energy');
  expect(h.callsOf('semantic')[0]!.args.slice(1)).toEqual(['[0.25,-0.5]', expect.any(String), 0.3]);
  expect(h.callsOf('semantic')[0]!.scope).toBe('global');
  expect(h.callsOf('federalCandidates')[0]!.args.slice(1)).toEqual([
    119,
    ['grid', 'energy'],
    ['\\mgrid\\M', '\\menergy\\M'],
  ]);
  expect(recs[0]!.fit).toBeCloseTo(0.77);
  expect(recs[0]!.matchedTopicIds).toEqual(['topic-grid']);
  expect(recs[0]).toEqual({
    billId,
    displayNum: 'H.R. 7',
    title: 'Grid modernization',
    stage: 'committee',
    stageLabel: 'In committee',
    passageProbability: expect.closeTo(0.138),
    latestActionText: 'Referred to committee',
    latestActionDate: federal().latestActionDate,
    sponsorName: 'Sponsor',
    sponsorParty: 'D',
    cosponsorsCount: 2,
    fit: expect.closeTo(0.77),
    matchedTags: ['Grid', 'Energy'],
    matchedTopicIds: ['topic-grid'],
    why: 'Matches your watchlist term "grid".',
    whyKind: 'keyword',
    matchReasons: [
      { kind: 'keyword', detail: 'Matches your watchlist term "grid".' },
      { kind: 'issue_code', detail: 'In your issue area "Energy".' },
      { kind: 'semantic', detail: 'Semantic match to your watchlist (≈ "Grid").' },
    ],
  });
});

it('keeps only current-Congress semantic IDs, last duplicate score and untracked undismissed union order', async () => {
  jest.mocked(embedText).mockResolvedValue([1]);
  const extra = '119-s-8';
  const h = harness({
    results: {
      semantic: [
        { sourceId: billId, score: 0.9 },
        { sourceId: '118-hr-1', score: 1 },
        { sourceId: '119-hr-8', score: 0.8 },
        { sourceId: '119-hr-9', score: 0.9 },
        { sourceId: billId, score: 0.7 },
      ],
      federalCandidates: [{ id: extra }, { id: billId }, { id: '119-hr-8' }],
      federalRows: [federal(), federal({ id: extra })],
      'trackedBill.findMany': [{ billId: '119-hr-8' }],
      'intelFeedback.findMany': [
        { targetRef: '119-hr-9', matchedTags: [], matchedTopicIds: [], reason: null },
      ],
    },
  });
  const recs = await h.service.getRecommendations(tenantId, clientId);
  expect(h.callsOf('federalRows')[0]!.args[1]).toEqual([billId, extra]);
  expect(recs.map((row) => row.billId)).toEqual([billId, extra]);
  expect(recs[0]!.fit).toBeCloseTo(0.73);
  const [signal, dismissed] = h.callsOf('intelFeedback.findMany');
  expect(args(signal!).where).toMatchObject({
    signal: 'marked_irrelevant',
    matchedTags: { isEmpty: false },
  });
  expect(args(dismissed!).where).toEqual({
    tenantId,
    clientId,
    targetType: 'bill',
    signal: { in: ['dismissed', 'marked_irrelevant'] },
  });
  expect(h.callsOf('trackedBill.findMany')[0]!.transaction).toBe(dismissed!.transaction);
  expect(signal!.transaction).not.toBe(dismissed!.transaction);
});

it.each(['embedding', 'semantic'] as const)(
  'degrades %s failure to the real keyword path and preserves scored reasons',
  async (boundary) => {
    const failure = new Error('semantic offline');
    if (boundary === 'semantic') jest.mocked(embedText).mockResolvedValue([1]);
    const h = harness({
      results: {
        semantic: failure,
        federalCandidates: [{ id: billId }],
        federalRows: [federal()],
      },
    });
    const recs = await h.service.getRecommendations(tenantId, clientId);
    expect(recs.map((row) => row.billId)).toEqual([billId]);
    expect(recs[0]!.fit).toBeCloseTo(0.45);
    expect(recs[0]!.matchReasons.every((reason) => reason.kind !== 'semantic')).toBe(true);
    expect(h.callsOf('semantic')).toHaveLength(boundary === 'semantic' ? 1 : 0);
    expect(h.events.indexOf('federalCandidates')).toBeGreaterThan(
      h.events.indexOf('intelFeedback.findMany'),
    );
  },
);

it.each(['federalCandidates', 'federalRows', 'stateCandidates', 'stateRows'])(
  'keeps nonsemantic %s failure fatal',
  async (operation) => {
    const failure = new Error(operation);
    const h = harness({
      results: {
        'watchlist.findFirst': watchlist({ jurisdictions: ['CA'] }),
        federalCandidates: [{ id: billId }],
        federalRows: [federal()],
        stateCandidates: [{ id: stateId }],
        stateRows: [state()],
        [operation]: failure,
      },
    });
    await expect(h.service.getRecommendations(tenantId, clientId)).rejects.toBe(failure);
  },
);

it('uses the lower opted-in state floor while rejecting the same issue-only federal fit', async () => {
  const h = harness({
    results: {
      'watchlist.findFirst': watchlist({ jurisdictions: ['ca'] }),
      'watchlistTopic.findMany': [],
      'watchlistTerm.findMany': [],
      federalCandidates: [{ id: billId }],
      federalRows: [federal({ title: 'Other subject' })],
      stateCandidates: [{ id: stateId }],
      stateRows: [state({ title: 'Other subject' })],
    },
  });
  const recs = await h.service.getRecommendations(tenantId, clientId);
  expect(recs).toHaveLength(1);
  expect(recs[0]).toMatchObject({
    billId: stateId,
    fit: 0.4,
    jurisdiction: 'CA',
    stateUrl: 'https://example.invalid/state',
    url: 'https://example.invalid/provider',
    cosponsorsCount: null,
  });
  expect(h.callsOf('stateCandidates')[0]!.args[1]).toEqual(['CA']);
  expect(recs[0]).toEqual({
    billId: stateId,
    displayNum: 'CA AB 1234',
    title: 'Other subject',
    stage: 'committee',
    stageLabel: 'In committee',
    passageProbability: expect.closeTo(0.138),
    latestActionText: 'Referred to committee',
    latestActionDate: state().latestActionDate,
    sponsorName: 'State Sponsor',
    sponsorParty: 'R',
    cosponsorsCount: null,
    fit: 0.4,
    matchedTags: ['Energy'],
    matchedTopicIds: [],
    why: "Matches this client's tracked issue areas.",
    whyKind: 'keyword',
    matchReasons: [
      { kind: 'issue_code', detail: 'In your issue area "Energy".' },
      { kind: 'keyword', detail: "Matches this client's tracked issue areas." },
    ],
    jurisdiction: 'CA',
    stateUrl: 'https://example.invalid/state',
    url: 'https://example.invalid/provider',
  });
});

it('does not opt a client into state candidates from facility suggestions', async () => {
  const h = harness({
    results: {
      'watchlist.findFirst': watchlist({ jurisdictions: [] }),
      suggestedJurisdictions: [{ state: 'CA' }],
      federalCandidates: [{ id: billId }],
      federalRows: [federal()],
    },
  });
  expect(await h.service.getRecommendations(tenantId, clientId)).toHaveLength(1);
  expect(h.callsOf('suggestedJurisdictions')).toHaveLength(1);
  expect(h.callsOf('stateCandidates')).toHaveLength(0);
});

it('reuses the federal prehydration clock for the later state rail and ranks equal-fit rows stably', async () => {
  const gate = deferred<ReturnType<typeof federal>[]>();
  const h = harness({
    results: {
      'watchlist.findFirst': watchlist({ jurisdictions: ['CA'] }),
      federalCandidates: [{ id: billId }],
      federalRows: gate.promise,
      stateCandidates: [{ id: stateId }, { id: 'ca-2025-ab1235' }],
      stateRows: [state(), state({ id: 'ca-2025-ab1235' })],
    },
  });
  const clock = jest.spyOn(Date, 'now');
  const pending = h.service.getRecommendations(tenantId, clientId, 2);
  await h.started('federalRows');
  const readsBefore = clock.mock.calls.length;
  jest.setSystemTime(new Date('2032-01-01T00:00:00Z'));
  gate.resolve([federal()]);
  const recs = await pending;
  expect(clock.mock.calls.length).toBe(readsBefore);
  expect(recs.map((row) => row.billId)).toEqual([billId, stateId]);
  expect(recs[0]!.passageProbability).toBe(recs[1]!.passageProbability);
});
