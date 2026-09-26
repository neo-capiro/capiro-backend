import { projectPortfolioAcquisition } from './acquisition-projection.js';

describe('projectPortfolioAcquisition', () => {
  test('deduplicates one award reached through several program paths', () => {
    const result = projectPortfolioAcquisition({
      awardPaths: [
        { awardIdentityKey: 'usaspending|award|A1', pathIdentityKey: 'pe|P1' },
        { awardIdentityKey: 'usaspending|award|A1', pathIdentityKey: 'pe|P2' },
      ],
      transactions: [{ identityKey: 'TX1', awardIdentityKey: 'usaspending|award|A1', signedDeltaUsd: '100', revision: 1 }],
      accountTotals: [],
    });
    expect(result).toMatchObject({ awardCount: 1, transactionCount: 1, signedTransactionDeltaUsd: '100' });
  });

  test('preserves parent/order/modification chains as distinct awards and signed actions', () => {
    const result = projectPortfolioAcquisition({
      awardPaths: [{ awardIdentityKey: 'prime' , pathIdentityKey: 'program' }, { awardIdentityKey: 'order', pathIdentityKey: 'program' }],
      transactions: [
        { identityKey: 'prime-award-action', awardIdentityKey: 'prime', signedDeltaUsd: '1000', revision: 1 },
        { identityKey: 'order-action', awardIdentityKey: 'order', signedDeltaUsd: '250', revision: 1 },
      ],
      accountTotals: [],
    });
    expect(result).toMatchObject({ awardCount: 2, transactionCount: 2, signedTransactionDeltaUsd: '1250' });
  });

  test('preserves negative deobligation actions and applies corrected revisions once', () => {
    const result = projectPortfolioAcquisition({
      awardPaths: [{ awardIdentityKey: 'award-1', pathIdentityKey: 'pe-1' }],
      transactions: [
        { identityKey: 'action-1', awardIdentityKey: 'award-1', signedDeltaUsd: '100', revision: 1 },
        { identityKey: 'action-2', awardIdentityKey: 'award-1', signedDeltaUsd: '-25', revision: 1 },
        { identityKey: 'action-1', awardIdentityKey: 'award-1', signedDeltaUsd: '90', revision: 2 },
      ],
      accountTotals: [],
    });
    expect(result).toMatchObject({ transactionCount: 2, signedTransactionDeltaUsd: '65' });
  });

  test('a distinct correction action replaces the transaction it corrects', () => {
    const result = projectPortfolioAcquisition({
      awardPaths: [{ awardIdentityKey: 'award-1', pathIdentityKey: 'pe-1' }],
      transactions: [
        { identityKey: 'original', awardIdentityKey: 'award-1', signedDeltaUsd: '100', revision: 1 },
        { identityKey: 'correction', awardIdentityKey: 'award-1', signedDeltaUsd: '80', revision: 1, correctsIdentityKey: 'original' },
      ],
      accountTotals: [],
    });
    expect(result).toMatchObject({ transactionCount: 1, signedTransactionDeltaUsd: '80' });
  });

  test('keeps account totals separate so award actions are never added to them', () => {
    const result = projectPortfolioAcquisition({
      awardPaths: [{ awardIdentityKey: 'award-1', pathIdentityKey: 'pe-1' }],
      transactions: [{ identityKey: 'TX1', awardIdentityKey: 'award-1', signedDeltaUsd: '10', revision: 1 }],
      accountTotals: [{ identityKey: 'TAS-057-3600-FY26', amountUsd: '100', sourceAsOf: '2026-09-01' }],
    });
    expect(result.signedTransactionDeltaUsd).toBe('10');
    expect(result.accountTotals).toEqual([{ identityKey: 'TAS-057-3600-FY26', amountUsd: '100', sourceAsOf: '2026-09-01' }]);
    expect(result).not.toHaveProperty('combinedTotalUsd');
  });
});
