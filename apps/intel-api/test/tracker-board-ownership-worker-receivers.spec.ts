import { harness, installHooks, args } from './fixtures/tracker-board-ownership/harness.js';
import * as boardExports from '../src/tracker/tracker-board.service.js';
import { TrackerBoardService } from '../src/tracker/tracker-board.service.js';
import {
  billId,
  stateId,
  clientId,
  otherClientId,
  tenantId,
  userId,
  federal,
  state,
  tracked,
  watchlist,
  deferred,
} from './fixtures/tracker-board-ownership/rows.js';

installHooks();

it('runs the real worker through real recommendations and refreshes federal history while atomically creating a state match alert', async () => {
  const h = harness({
    results: {
      'watchlist.findFirst': watchlist({ jurisdictions: ['CA'] }),
      federalCandidates: [{ id: billId }],
      federalRows: [federal()],
      stateCandidates: [{ id: stateId }],
      stateRows: [state()],
      'billMatch.findMany': [{ billId }],
    },
  });
  expect(await h.worker.runNewMatchCycle()).toEqual({
    clients: 1,
    candidates: 2,
    newMatches: 1,
    alertsWritten: 1,
    refreshed: 1,
  });
  const universe = h.callsOf('watchlist.findMany')[0]!;
  expect(universe.scope).toBe('system');
  expect(args(universe)).toEqual({
    where: { active: true },
    select: { tenantId: true, clientId: true },
  });
  expect(args(h.callsOf('billMatch.update')[0]!).data).toMatchObject({
    fit: expect.closeTo(0.45),
    matchedTags: ['Grid', 'Energy'],
  });
  const match = h.callsOf('billMatch.create')[0]!,
    alert = h.callsOf('intelAlert.create')[0]!;
  expect(match.transaction).toBe(alert.transaction);
  expect(match.tenantId).toBe(tenantId);
  expect(args(match).data).toMatchObject({
    tenantId,
    clientId,
    billId: stateId,
    congress: null,
    jurisdiction: 'CA',
    fit: expect.closeTo(0.45),
  });
  expect(args(alert).data).toMatchObject({
    tenantId,
    clientId,
    sourceType: 'state_bill',
    sourceRef: stateId,
    changeType: 'bill_new_match',
    status: 'new',
    evidence: {
      url: 'https://example.invalid/state',
      sourceUrl: 'https://example.invalid/state',
      jurisdiction: 'CA',
      matchedTags: ['Grid', 'Energy'],
    },
  });
});

it('contains a real recommendation failure per worker client and continues into the next client tenant scope', async () => {
  const secondTenant = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const h = harness({
    results: {
      'watchlist.findMany': [
        watchlist(),
        watchlist({ tenantId: secondTenant, clientId: otherClientId }),
      ],
      federalRows: [federal()],
    },
    queues: { federalCandidates: [new Error('first ranking unavailable'), [{ id: billId }]] },
  });
  expect(await h.worker.runNewMatchCycle()).toEqual({
    clients: 2,
    candidates: 1,
    newMatches: 1,
    alertsWritten: 1,
    refreshed: 0,
  });
  expect(h.callsOf('intelAlert.create')[0]!.tenantId).toBe(secondTenant);
  expect(args(h.callsOf('intelAlert.create')[0]!).data).toMatchObject({ clientId: otherClientId });
  expect(h.callsOf('watchlist.findFirst').map((call) => call.tenantId)).toEqual([
    tenantId,
    secondTenant,
  ]);
});

it('preserves real-worker unique-race handling after real recommendations without creating a second alert', async () => {
  const raced = Object.assign(new Error('unique race'), { code: 'P2002' });
  const h = harness({
    results: {
      federalCandidates: [{ id: billId }],
      federalRows: [federal()],
      'billMatch.create': raced,
    },
  });
  expect(await h.worker.runNewMatchCycle()).toEqual({
    clients: 1,
    candidates: 1,
    newMatches: 1,
    alertsWritten: 0,
    refreshed: 0,
  });
  expect(h.callsOf('intelAlert.create')).toHaveLength(0);
  expect(h.events).toContain(`tx:fail:${h.callsOf('billMatch.create')[0]!.transaction}`);
});

it('retains original constructor arity, twenty-five method descriptors/default arities and five runtime exports', () => {
  expect(TrackerBoardService.length).toBe(4);
  expect(Object.keys(boardExports).sort()).toEqual(
    [
      'EMBED_CANDIDATE_FLOOR',
      'LEGIWATCH_STATE_FIT_FLOOR',
      'TrackerBoardService',
      'billSearchPatterns',
      'summarizeTrackedRows',
    ].sort(),
  );
  const arities: Record<string, number> = {
    stateStatusToBoardStage: 1,
    stateBoardStage: 2,
    stateStageLabel: 2,
    fetchMergedBills: 1,
    canonicalStatusFor: 4,
    isTerminalNegativeStateStatus: 2,
    displayNumFor: 1,
    alignStateStageFilter: 4,
    jurisdictionFor: 1,
    compiledTopics: 2,
    getRecommendations: 2,
    getBoard: 2,
    getTenantBoard: 1,
    compileTopicsForClients: 2,
    getTrackedStatus: 3,
    getSummary: 2,
    getPortfolioCounts: 1,
    searchBills: 1,
    trackCongressStage: 1,
    trackStateStage: 1,
    trackBill: 5,
    untrackBill: 3,
    updateBillContext: 5,
    recordFeedback: 4,
    feedbackSignal: 2,
  };
  expect(
    Object.getOwnPropertyNames(TrackerBoardService.prototype)
      .filter((name) => name !== 'constructor')
      .sort(),
  ).toEqual(Object.keys(arities).sort());
  for (const [name, arity] of Object.entries(arities)) {
    const descriptor = Object.getOwnPropertyDescriptor(TrackerBoardService.prototype, name)!;
    expect(descriptor).toMatchObject({ configurable: true, writable: true, enumerable: false });
    expect((descriptor.value as (...args: unknown[]) => unknown).length).toBe(arity);
  }
  const h = harness(),
    fields = h.service as unknown as Record<string, unknown>;
  expect(fields.prisma).toBe(h.prisma);
  expect(fields.repo).toBe(h.repo);
  expect(fields.watchlists).toBe(h.watchlists);
  expect(fields.stateRepo).toBe(h.stateRepo);
});

it('supports borrowed dependency-only receivers for summary and direct status without constructing a second owner graph', async () => {
  const row = tracked();
  const h = harness({ results: { 'trackedBill.findMany': [row], 'trackedBill.findFirst': row } });
  const receiver = { prisma: h.prisma } as unknown as TrackerBoardService;
  expect(await TrackerBoardService.prototype.getSummary.call(receiver, tenantId, clientId)).toEqual(
    { boardCount: 1, unread: 0, hasWatchlist: true },
  );
  const status = await TrackerBoardService.prototype.getTrackedStatus.call(
    receiver,
    tenantId,
    clientId,
    billId,
  );
  expect(status).toEqual({ tracked: true, trackedAt: row.trackedAt });
  expect(status.trackedAt).toBe(row.trackedAt);
});

it('keeps a prototype-inherited service receiver and actual Root helper contexts observable', async () => {
  const h = harness({ results: { federalCandidates: [{ id: billId }], federalRows: [federal()] } });
  const spy = jest.spyOn(h.subject, 'compiledTopics');
  const receiver = Object.create(h.service) as TrackerBoardService;
  expect(await receiver.getRecommendations(tenantId, clientId)).toHaveLength(1);
  expect(spy.mock.contexts).toEqual([receiver]);
  expect(h.callsOf('federalCandidates')).toHaveLength(1);
});

it('resolves a replaced real source dependency only after the ownership await and preserves the actual repository receiver', async () => {
  const guard = deferred<Array<{ id: string }>>();
  const h = harness({ results: { clientOwnership: guard.promise } });
  const replacement = harness({ results: { federalIdentity: [federal()] } });
  const spy = jest.spyOn(replacement.repo, 'getBillById');
  const pending = h.service.trackBill(tenantId, clientId, userId, billId);
  await h.started('clientOwnership');
  Object.defineProperty(h.service, 'repo', { value: replacement.repo, configurable: true });
  guard.resolve([{ id: clientId }]);
  await pending;
  expect(spy.mock.contexts).toEqual([replacement.repo]);
  expect(h.callsOf('federalIdentity')).toHaveLength(0);
  expect(replacement.callsOf('federalIdentity')).toHaveLength(1);
  expect(h.callsOf('trackedBill.upsert')).toHaveLength(1);
});

it('resolves a replacement Root private compilation method at request time with a real passthrough body', async () => {
  const h = harness({ results: { federalCandidates: [{ id: billId }], federalRows: [federal()] } });
  const original = h.subject.compiledTopics;
  const contexts: unknown[] = [];
  const passthrough = jest.fn(function (this: unknown, tenant: string, client: string) {
    contexts.push(this);
    return original.call(this as typeof h.subject, tenant, client);
  });
  h.subject.compiledTopics = passthrough;
  expect(await h.service.getRecommendations(tenantId, clientId)).toHaveLength(1);
  expect(contexts).toEqual([h.service]);
  expect(passthrough).toHaveBeenCalledWith(tenantId, clientId);
  expect(h.callsOf('watchlistTerm.findMany')).toHaveLength(1);
});

it('looks up the replacement Root feedback method only after real compilation completes across an await', async () => {
  const terms = deferred<unknown[]>();
  const h = harness({
    results: {
      'watchlistTerm.findMany': terms.promise,
      federalCandidates: [{ id: billId }],
      federalRows: [federal()],
    },
  });
  const original = h.service.feedbackSignal;
  const pending = h.service.getRecommendations(tenantId, clientId);
  await h.started('watchlistTerm.findMany');
  const passthrough = jest.fn(function (this: TrackerBoardService, tenant: string, client: string) {
    return original.call(this, tenant, client);
  });
  h.service.feedbackSignal = passthrough;
  terms.resolve([]);
  expect(await pending).toHaveLength(1);
  expect(passthrough.mock.contexts).toEqual([h.service]);
  expect(passthrough).toHaveBeenCalledWith(tenantId, clientId);
  expect(h.callsOf('intelFeedback.findMany')).toHaveLength(2);
});

it('uses a replaced Prisma dependency for the second context read after the first write has committed', async () => {
  const returned = tracked({ note: 'stored' });
  const h = harness(),
    replacement = harness({ results: { 'trackedBill.findFirst': returned } });
  h.queue('trackedBill.updateMany', () => {
    Object.defineProperty(h.service, 'prisma', { value: replacement.prisma, configurable: true });
    return { count: 1 };
  });
  expect(
    await h.service.updateBillContext(tenantId, clientId, userId, billId, { analystNote: 'saved' }),
  ).toEqual({ ok: true, bill: returned });
  expect(h.callsOf('trackedBill.findFirst')).toHaveLength(0);
  expect(replacement.callsOf('trackedBill.findFirst')).toHaveLength(1);
  expect(h.events).toContain(`tx:end:${h.callsOf('trackedBill.updateMany')[0]!.transaction}`);
});
