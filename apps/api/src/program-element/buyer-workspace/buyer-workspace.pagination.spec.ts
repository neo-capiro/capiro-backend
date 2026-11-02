import { BuyerWorkspaceService } from './buyer-workspace.service.js';
import { AcquisitionContinuityReadService, type AcquisitionContinuityReadRepository,
  type AcquisitionContinuityRelationshipRow } from '../acquisition-continuity/acquisition-continuity-read.service.js';
import { FundingExecutionReadService, type FundingExecutionReadRepository,
  type FundingExecutionFact } from '../funding-execution/funding-execution-read.service.js';
import type { FederalEvidenceReadService } from '../federal-evidence/federal-evidence-read.service.js';

const input = { peCode: '0601234A', asOfFy: 2027, knownAt: '2026-09-24T00:00:00.000Z' };
function relationship(i: number): AcquisitionContinuityRelationshipRow {
  const entity = { entityType: 'notice', id: null, sourceNativeId: 'synthetic', label: null };
  return { stableKey: 'a' + String(i).padStart(3, '0'), relationshipId: 'relationship-' + i,
    relationshipKind: 'notice_to_vehicle', status: 'candidate', from: entity, to: { ...entity, entityType: 'vehicle' },
    sourceNativeIds: { notice: 'synthetic' }, path: [], parent: null,
    validity: { validFromFy: 2027, validToFy: null, knownFrom: input.knownAt, knownTo: null },
    evidence: [], unresolvedReasons: [], financialFact: { classification: 'inferred_relevance',
      reviewState: 'candidate', sourceAmountUsd: '20.00', actionEffect: 'ordinary', evidencePresent: false },
    authoritativeAmountUsd: 'untrusted',
  };
}
function fact(i: number): FundingExecutionFact {
  return { stableKey: 'f' + String(i).padStart(3, '0'), factId: 'fact-' + i,
    authorityState: i % 2 ? 'proposed' : 'enacted', measure: 'transaction_delta', fiscalYear: 2027,
    validFromFy: 2027, validToFy: null, availabilityStart: null, availabilityEnd: null, recordedAt: input.knownAt,
    accountId: '0300', snapshotGroupId: null, amountUsd: i === 50 ? '-12.00' : '10.00',
    amountBasis: 'transaction_delta', executionMetric: null, asOfDate: null, periodStart: null, periodEnd: null,
    transferGroupId: null, transferLeg: null, allocationCertification: 'not_applicable',
    reviewState: 'verified', exactAccountLevel: false, evidence: [], unresolvedReasons: [], authoritativeAmountUsd: null };
}
function fixture() {
  const acquisitions = Array.from({ length: 51 }, (_, i) => relationship(i));
  const funds = Array.from({ length: 51 }, (_, i) => fact(i));
  const acquisition: AcquisitionContinuityReadRepository = { readPage: jest.fn(async query => ({
    rows: acquisitions.filter(row => !query.afterStableKey || row.stableKey > query.afterStableKey).slice(0, query.take),
    coverage: { state: 'complete' as const, supportedRelationshipKinds: ['notice_to_vehicle'], unsupportedRelationshipKinds: [],
      unresolvedReasons: [], sourceFreshness: [] },
  })) };
  const funding: FundingExecutionReadRepository = { readPage: jest.fn(async query => ({
    rows: funds.filter(row => !query.afterStableKey || row.stableKey > query.afterStableKey).slice(0, query.take),
    coverage: { state: 'complete' as const, unresolvedReasons: [],
      sourceFreshness: [{ source: 'synthetic', sourceAsOf: input.knownAt, state: 'current' as const }] },
  })) };
  const federal = { currentQualifiedMentions: jest.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
    lifecycleTimeline: jest.fn(async () => ({ items: [], hasMore: false, nextCursor: null })) } as unknown as FederalEvidenceReadService;
  return { acquisition, funding, service: new BuyerWorkspaceService(
    new AcquisitionContinuityReadService(acquisition), new FundingExecutionReadService(funding), federal) };
}

test('actual readers continue independently with pinned dates and preserve financial categories', async () => {
  const f = fixture(), first = await f.service.read(input);
  expect(first.acquisition.state).toBe('partial');
  expect(first.fundingExecution.state).toBe('partial');
  expect(first.acquisition.data.candidates).toHaveLength(50);
  const next = await f.service.read({ ...input,
    acquisitionCursor: first.acquisition.data.page.nextCursor!, fundingCursor: first.fundingExecution.data.page.nextCursor! });
  expect(next.acquisition.state).toBe('complete');
  expect(next.fundingExecution.state).toBe('complete');
  expect(next.acquisition.data.candidates).toHaveLength(1);
  expect(next.acquisition.data.candidates[0]).toMatchObject({ stableKey: 'a050', authoritativeAmountUsd: null });
  expect(next.fundingExecution.data.enacted.transactionDeltas).toHaveLength(1);
  expect(next.fundingExecution.data.enacted.transactionDeltas[0]!.amountUsd).toBe('-12.00');
  expect(next.fundingExecution.data.proposed.transactionDeltas).toEqual([]);
  expect(next.fundingExecution.data.enacted.totals.transactionDeltaUsd).toBe('-12.00');
  expect(f.acquisition.readPage).toHaveBeenLastCalledWith(expect.objectContaining({
    subject: { type: 'pe', id: input.peCode }, asOfFy: 2027, knownAt: new Date(input.knownAt), afterStableKey: 'a049' }));
  expect(f.funding.readPage).toHaveBeenLastCalledWith(expect.objectContaining({ afterStableKey: 'f049' }));
});

test.each(['acquisition', 'funding'] as const)('advancing only %s leaves the other section on its own first page', async section => {
  const f = fixture(), first = await f.service.read(input);
  const key = section === 'acquisition' ? 'acquisitionCursor' : 'fundingCursor';
  const cursor = (section === 'acquisition' ? first.acquisition : first.fundingExecution).data.page.nextCursor!;
  const next = await f.service.read({ ...input, [key]: cursor });
  expect(next.acquisition.data.candidates).toHaveLength(section === 'acquisition' ? 1 : 50);
  expect(next.fundingExecution.data.enacted.transactionDeltas).toHaveLength(section === 'funding' ? 1 : 25);
  expect(next.acquisition.data.page.hasMore).toBe(section !== 'acquisition');
  expect(next.fundingExecution.data.page.hasMore).toBe(section !== 'funding');
});

test.each(['peCode', 'asOfFy', 'knownAt'] as const)('actual section cursors reject a changed %s', async field => {
  const f = fixture(), first = await f.service.read(input);
  const changed = { ...input, [field]: field === 'peCode' ? '0609999A' : field === 'asOfFy' ? 2028 : '2026-09-25T00:00:00.000Z' };
  await expect(f.service.read({ ...changed, acquisitionCursor: first.acquisition.data.page.nextCursor! })).rejects.toThrow('cursor');
  await expect(f.service.read({ ...changed, fundingCursor: first.fundingExecution.data.page.nextCursor! })).rejects.toThrow('cursor');
});
