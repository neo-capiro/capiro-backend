import { BadRequestException } from '@nestjs/common';
import { FundingExecutionReadService, type FundingExecutionCoverage, type FundingExecutionFact, type FundingExecutionReadRepository } from './funding-execution-read.service.js';

function fact(stableKey: string, patch: Partial<FundingExecutionFact> = {}): FundingExecutionFact {
  return {
    stableKey,
    factId: `fact-${stableKey}`,
    authorityState: 'enacted',
    measure: 'transaction_delta',
    fiscalYear: 2027,
    validFromFy: 2027,
    validToFy: null,
    availabilityStart: '2026-10-01',
    availabilityEnd: null,
    recordedAt: '2026-09-24T00:00:00.000Z',
    accountId: '0300',
    snapshotGroupId: null,
    amountUsd: '10.00',
    amountBasis: 'transaction_delta',
    executionMetric: null,
    asOfDate: '2026-09-24',
    periodStart: null,
    periodEnd: null,
    transferGroupId: null,
    transferLeg: null,
    allocationCertification: 'not_applicable',
    reviewState: 'verified',
    exactAccountLevel: false,
    evidence: [{ sourceFamily: 'execution_record', sourceNativeId: stableKey, sourceUrl: null, sourceVersion: 'v1', contentHash: 'a'.repeat(64), quote: null }],
    unresolvedReasons: [],
    authoritativeAmountUsd: 'untrusted',
    ...patch,
  };
}

const coverage = { state: 'partial' as const, unresolvedReasons: [{ code: 'source_gap', count: null, detail: 'Missing source' }], sourceFreshness: [] };

function makeService(pages: Array<{ rows: FundingExecutionFact[]; coverage: FundingExecutionCoverage }>) {
  const calls: unknown[] = [];
  const repository: FundingExecutionReadRepository = {
    readPage: jest.fn(async (query) => { calls.push(query); return pages.shift()!; }),
  };
  return { service: new FundingExecutionReadService(repository), calls };
}

describe('FundingExecutionReadService', () => {
  test('pins asOfFy and knownAt in the cursor and returns a stable next page', async () => {
    const { service, calls } = makeService([
      { rows: [fact('b'), fact('a'), fact('c')], coverage },
      { rows: [fact('d')], coverage },
    ]);
    const first = await service.read({ programId: 'p1', asOfFy: 2027, knownAt: '2026-09-24T12:00:00Z', limit: 2 });
    const second = await service.read({ programId: 'p1', asOfFy: 2027, limit: 2, cursor: first.page.nextCursor! });
    expect(first.enacted.transactionDeltas.map((row) => row.stableKey)).toEqual(['a', 'b']);
    expect(second.enacted.transactionDeltas.map((row) => row.stableKey)).toEqual(['d']);
    expect(second.knownAt).toBe(first.knownAt);
    expect(calls[1]).toMatchObject({ asOfFy: 2027, afterStableKey: 'b', take: 4 });
    expect((calls[1] as { knownAt: Date }).knownAt.toISOString()).toBe(first.knownAt);
    await expect(service.read({ programId: 'p1', asOfFy: 2026, cursor: first.page.nextCursor! })).rejects.toBeInstanceOf(BadRequestException);
  });

  test('does not split an explicit two-leg transfer at the page limit', async () => {
    const { service } = makeService([
      { rows: [
        fact('transfer-a', { measure: 'transfer_leg', transferGroupId: 'transfer-1', transferLeg: 'outflow', amountUsd: '-5.00' }),
        fact('transfer-b', { measure: 'transfer_leg', transferGroupId: 'transfer-1', transferLeg: 'inflow', amountUsd: '5.00' }),
        fact('z-later'),
      ], coverage },
      { rows: [fact('z-later')], coverage },
    ]);
    const first = await service.read({ programId: 'p1', asOfFy: 2027, knownAt: '2026-09-24T12:00:00Z', limit: 1 });
    expect(first.enacted.transferLegs.map((leg) => leg.stableKey)).toEqual(['transfer-a', 'transfer-b']);
    expect(first.transferPairs[0]!.state).toBe('paired');
    expect(first.page.hasMore).toBe(true);
    const second = await service.read({ programId: 'p1', asOfFy: 2027, limit: 1, cursor: first.page.nextCursor! });
    expect(second.enacted.transferLegs).toEqual([]);
    expect(second.enacted.transactionDeltas.map((row) => row.stableKey)).toEqual(['z-later']);
  });

  test('keeps enacted and proposed facts separate, pairs transfers explicitly, and preserves residuals', async () => {
    const { service } = makeService([{
      rows: [
        fact('enacted-snapshot', { measure: 'cumulative_snapshot', snapshotGroupId: 'account-0300', amountUsd: '100.00' }),
        fact('negative-delta', { amountUsd: '-12.50' }),
        fact('proposed-snapshot', { authorityState: 'proposed', measure: 'cumulative_snapshot', snapshotGroupId: 'proposed-0300', amountUsd: '125.00' }),
        fact('transfer-out', { measure: 'transfer_leg', transferGroupId: 'T1', transferLeg: 'outflow', amountUsd: '-5.00' }),
        fact('transfer-in', { measure: 'transfer_leg', transferGroupId: 'T1', transferLeg: 'inflow', amountUsd: '5.00' }),
        fact('residual', { measure: 'residual', amountUsd: null, unresolvedReasons: ['unmatched source item'] }),
      ],
      coverage,
    }]);
    const result = await service.read({ peCode: '0604802A', asOfFy: 2027, knownAt: '2026-09-24T12:00:00Z' });
    expect(result.enacted.totals).toEqual({ cumulativeSnapshotUsd: '100.00', transactionDeltaUsd: '-12.50' });
    expect(result.proposed.totals.cumulativeSnapshotUsd).toBe('125.00');
    expect(result.enacted.cumulativeSnapshots).toHaveLength(1);
    expect(result.proposed.cumulativeSnapshots).toHaveLength(1);
    expect(result.transferPairs[0]).toMatchObject({ transferGroupId: 'T1', state: 'paired' });
    expect(result.residuals.map((row) => row.factId)).toContain('fact-residual');
    expect(result.coverage.state).toBe('partial');
  });

  test('does not expose allocation dollars without certified verified exact account-level evidence', async () => {
    const allowed = fact('allowed', {
      measure: 'allocation', amountUsd: '123.45', allocationCertification: 'certified', reviewState: 'verified',
      exactAccountLevel: true, accountId: '0300',
    });
    const inferred = fact('inferred', {
      measure: 'allocation', amountUsd: '999.00', allocationCertification: 'candidate', reviewState: 'candidate',
      exactAccountLevel: false,
    });
    const proposed = fact('proposed-allocation', {
      measure: 'allocation', authorityState: 'proposed', amountUsd: '50.00', allocationCertification: 'certified',
      reviewState: 'verified', exactAccountLevel: true,
    });
    const { service } = makeService([{ rows: [allowed, inferred, proposed], coverage }]);
    const result = await service.read({ programId: 'p1', asOfFy: 2027 });
    expect(result.allocations.find((row) => row.factId === 'fact-allowed')!.authoritativeAmountUsd).toBe('123.45');
    expect(result.allocations.find((row) => row.factId === 'fact-inferred')!.authoritativeAmountUsd).toBeNull();
    expect(result.allocations.find((row) => row.factId === 'fact-proposed-allocation')!.authoritativeAmountUsd).toBeNull();
    expect('tenantId' in result).toBe(false);
  });

  test('fails closed when complete coverage has no source freshness or freshness is unknown', async () => {
    const noFreshness = { ...coverage, state: 'complete' as const, unresolvedReasons: [] };
    const unknownFreshness = {
      ...noFreshness,
      sourceFreshness: [{ source: 'appropriations', sourceAsOf: null, state: 'unknown' as const }],
    };
    const { service: noSourceService } = makeService([{ rows: [], coverage: noFreshness }]);
    const noSource = await noSourceService.read({ programId: 'p1', asOfFy: 2027 });
    expect(noSource.coverage.state).toBe('partial');
    expect(noSource.coverage.unresolvedReasons.map((reason) => reason.code)).toContain('source_freshness_unverified');

    const { service: unknownService } = makeService([{ rows: [fact('row')], coverage: unknownFreshness }]);
    const unknown = await unknownService.read({ programId: 'p1', asOfFy: 2027 });
    expect(unknown.coverage.state).toBe('partial');
    expect(unknown.coverage.unresolvedReasons.map((reason) => reason.code)).toContain('source_freshness_unverified');
  });

  test('does not call a group with extra legs a paired transfer', async () => {
    const { service } = makeService([{ rows: [
      fact('transfer-a', { measure: 'transfer_leg', transferGroupId: 'transfer-1', transferLeg: 'outflow' }),
      fact('transfer-b', { measure: 'transfer_leg', transferGroupId: 'transfer-1', transferLeg: 'inflow' }),
      fact('transfer-c', { measure: 'transfer_leg', transferGroupId: 'transfer-1', transferLeg: 'inflow' }),
    ], coverage }]);
    const result = await service.read({ programId: 'p1', asOfFy: 2027 });
    expect(result.transferPairs[0]).toMatchObject({ state: 'unresolved', unresolvedReason: 'transfer_pair_incomplete_or_ambiguous' });
  });
});
