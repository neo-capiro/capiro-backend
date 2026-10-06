import { persistFederalEvidenceSnapshot } from './persistence.js';

describe('persistFederalEvidenceSnapshot transaction bounds', () => {
  it('gives a large bill version time to fill its passage index, still bounded', async () => {
    const transaction = jest.fn(async () => ({ written: true }));
    await persistFederalEvidenceSnapshot({ $transaction: transaction } as never, {
      provider: 'govinfo',
      collection: 'BILLS',
      packageId: 'BILLS-119hr8070rh',
      lineageKey: '119-hr-8070:house',
      sourceUrl: 'https://www.govinfo.gov/content/pkg/BILLS-119hr8070rh/html/BILLS-119hr8070rh.htm',
      rawContent: '<html>NDAA</html>',
      extractedText: 'SEC. 1. SHORT TITLE.',
      completeness: 'complete',
      inventoryWindowEnd: new Date('2026-10-06T13:19:53.940Z'),
      observationKey: 'govinfo-federal:full:BILLS:119:BILLS-119hr8070rh',
      historical: true,
    });
    // Prisma's 5-second default failed every batch from the first oversized package.
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 180_000,
    });
  });
});
