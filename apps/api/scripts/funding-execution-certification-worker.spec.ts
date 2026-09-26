import type { FundingExecutionFact } from '../src/program-element/funding-execution/funding-execution-read.service.js';
import {
  runFundingExecutionCertificationWorker,
  type FundingExecutionCheckpoint,
  type FundingExecutionPublicationPort,
  type FundingExecutionWorkerPage,
} from './funding-execution-certification-worker.js';

function row(factId: string, patch: Partial<FundingExecutionFact> = {}): FundingExecutionFact {
  return {
    stableKey: factId,
    factId,
    authorityState: 'enacted',
    measure: 'allocation',
    fiscalYear: 2027,
    validFromFy: 2027,
    validToFy: null,
    availabilityStart: '2026-10-01',
    availabilityEnd: null,
    recordedAt: '2026-09-24T00:00:00.000Z',
    accountId: '0300',
    snapshotGroupId: null,
    amountUsd: '10.00',
    transferGroupId: null,
    transferLeg: null,
    allocationCertification: 'certified',
    reviewState: 'verified',
    exactAccountLevel: true,
    evidence: [{ sourceFamily: 'exec_award', sourceNativeId: `native-${factId}`, sourceUrl: null, sourceVersion: 'v1', contentHash: 'a'.repeat(64), quote: null }],
    unresolvedReasons: [],
    authoritativeAmountUsd: null,
    ...patch,
  };
}

function port(page: FundingExecutionWorkerPage, checkpoint: FundingExecutionCheckpoint | null = null) {
  const calls: string[] = [];
  const value: FundingExecutionPublicationPort = {
    loadCheckpoint: jest.fn(async () => checkpoint),
    readBoundedPage: jest.fn(async () => { calls.push('read'); return page; }),
    publishCertified: jest.fn(async (rows) => { calls.push(`publish:${rows.map((item) => item.factId).join(',')}`); return { published: rows.length }; }),
    saveCheckpoint: jest.fn(async () => { calls.push('checkpoint'); }),
  };
  return { value, calls };
}

describe('Funding Execution certification worker gate and continuation', () => {
  test('defaults to dry run and does not publish or advance a checkpoint', async () => {
    const { value } = port({ rows: [row('one')], throughId: 'high-water', hasMore: true, nextCursor: 'opaque-next' });
    const result = await runFundingExecutionCertificationWorker(value, { commit: false, limit: 1, env: { FUNDING_EXECUTION_PUBLICATION_ENABLED: 'true' } });
    expect(result).toMatchObject({ mode: 'DRY_RUN', publishable: 1, published: 0, hasMore: true, checkpointAdvanced: false });
    expect(value.publishCertified).not.toHaveBeenCalled();
    expect(value.saveCheckpoint).not.toHaveBeenCalled();
  });

  test('requires the exact publication flag as well as --commit', async () => {
    const { value } = port({ rows: [row('one')], throughId: 'high-water', hasMore: false, nextCursor: null });
    const result = await runFundingExecutionCertificationWorker(value, { commit: true, limit: 10, env: { FUNDING_EXECUTION_PUBLICATION_ENABLED: 'TRUE' } });
    expect(result.mode).toBe('DRY_RUN');
    expect(value.publishCertified).not.toHaveBeenCalled();
    expect(value.saveCheckpoint).not.toHaveBeenCalled();
  });

  test('publishes only certified exact enacted allocations, then persists a bounded continuation', async () => {
    const pending = { version: 1 as const, cursor: 'cursor-in', throughId: 'high-water', complete: false };
    const { value, calls } = port({
      rows: [
        row('eligible'),
        row('eligible-snapshot', { measure: 'cumulative_snapshot', snapshotGroupId: 'acct-0300' }),
        row('eligible-positive-delta', { measure: 'transaction_delta', amountUsd: '4.00' }),
        row('candidate', { allocationCertification: 'candidate' }),
        row('proposed', { authorityState: 'proposed' }),
        row('unaccounted', { exactAccountLevel: false }),
        row('negative', { amountUsd: '-1.00' }),
        row('negative-obligation', { measure: 'transaction_delta', amountUsd: '-25.00' }),
        row('transfer-leg', { measure: 'transfer_leg', transferGroupId: 'T1', transferLeg: 'outflow', amountUsd: '-5.00' }),
      ],
      throughId: 'high-water', hasMore: true, nextCursor: 'cursor-out',
    }, pending);
    const result = await runFundingExecutionCertificationWorker(value, {
      commit: true, limit: 10, env: { FUNDING_EXECUTION_PUBLICATION_ENABLED: 'true' },
    });
    expect(value.readBoundedPage).toHaveBeenCalledWith({ cursor: 'cursor-in', throughId: 'high-water', take: 11 });
    expect(value.publishCertified).toHaveBeenCalledWith([
      expect.objectContaining({ factId: 'eligible', exactAccountLevel: true }),
      expect.objectContaining({ factId: 'eligible-snapshot', exactAccountLevel: true }),
      expect.objectContaining({ factId: 'eligible-positive-delta', exactAccountLevel: true }),
    ]);
    expect(calls.indexOf('publish:eligible,eligible-snapshot,eligible-positive-delta')).toBeLessThan(calls.indexOf('checkpoint'));
    expect(value.saveCheckpoint).toHaveBeenCalledWith({ version: 1, cursor: 'cursor-out', throughId: 'high-water', complete: false });
    expect(result).toMatchObject({ mode: 'COMMIT', published: 3, rejected: 6, hasMore: true, checkpointAdvanced: true });
  });

  test('rejects a port that exceeds the requested bounded page', async () => {
    const { value } = port({ rows: [row('1'), row('2'), row('3')], throughId: 'hi', hasMore: true, nextCursor: 'next' });
    await expect(runFundingExecutionCertificationWorker(value, { commit: false, limit: 1 })).rejects.toThrow(/bounded page/);
  });

  test('starts the next window after the last completed high-water mark', async () => {
    const completed = { version: 1 as const, cursor: null, throughId: 'completed-through', complete: true };
    const { value } = port({ rows: [], throughId: 'next-through', hasMore: false, nextCursor: null }, completed);
    await runFundingExecutionCertificationWorker(value, {
      commit: true,
      limit: 10,
      env: { FUNDING_EXECUTION_PUBLICATION_ENABLED: 'true' },
    });
    expect(value.readBoundedPage).toHaveBeenCalledWith({
      cursor: 'completed-through',
      throughId: null,
      take: 11,
    });
    expect(value.saveCheckpoint).toHaveBeenCalledWith({
      version: 1,
      cursor: null,
      throughId: 'next-through',
      complete: true,
    });
  });
});
