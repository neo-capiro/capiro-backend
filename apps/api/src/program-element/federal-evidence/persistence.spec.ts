import { persistFederalEvidenceSnapshot } from './persistence.js';
import { byteHash } from '../../ingestion/federal-document-bytes.js';

describe('persistFederalEvidenceSnapshot transaction bounds', () => {
  it('keeps old unbound PLAW bytes immutable and creates/reuses the exact qualified bill binding', async () => {
    const revisions = new Map<string, { id: string; billId: string | null; parser: string }>();
    const tx: any = {
      $executeRaw: jest.fn(async () => 1),
      $queryRawUnsafe: jest.fn(async (_sql: string, id: string, receipt: string) =>
        id === '119-hr-1' && receipt === 'bill-receipt' ? [{ id }] : [],
      ),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = strings.join('?');
        if (sql.includes('INSERT INTO federal_evidence_revision')) {
          const key = JSON.stringify([values[0], values[7], values[8], values[9]]);
          if (revisions.has(key)) return [];
          const row = { id: `revision-${revisions.size}`, billId: values[4], parser: values[9] };
          revisions.set(key, row);
          return [{ id: row.id }];
        }
        if (sql.includes('SELECT id FROM federal_evidence_revision'))
          return [{ id: revisions.get(JSON.stringify(values))!.id }];
        if (sql.includes('INSERT INTO federal_evidence_observation')) return [{ id: 1n }];
        return [];
      }),
    };
    const db: any = { $transaction: async (fn: any) => fn(tx) },
      bytes = Buffer.from('Synthetic law'),
      base: any = {
        provider: 'govinfo',
        collection: 'PLAW',
        packageId: 'PLAW-119publ1',
        lineageKey: 'PLAW-119publ1',
        sourceUrl: 'https://www.govinfo.gov/content/pkg/PLAW-119publ1/html/PLAW-119publ1.htm',
        rawContent: bytes.toString(),
        originalBytes: {
          base64: bytes.toString('base64'),
          sha256: byteHash(bytes),
          mime: 'text/plain',
        },
        extractedText: bytes.toString(),
        completeness: 'partial',
        inventoryWindowEnd: new Date('2026-02-01'),
        observationKey: 'old',
        metadata: { sourceInventoryReceiptId: 'bill-receipt', providerVersionId: 'law-version' },
      };
    const old = await persistFederalEvidenceSnapshot(db, base);
    const bound = await persistFederalEvidenceSnapshot(db, {
      ...base,
      billId: '119-hr-1',
      observationKey: 'bound',
    });
    const retry = await persistFederalEvidenceSnapshot(db, {
      ...base,
      billId: '119-hr-1',
      observationKey: 'retry',
    });
    expect(old.revisionId).not.toBe(bound.revisionId);
    expect(retry.revisionId).toBe(bound.revisionId);
    expect(revisions.size).toBe(2);
    expect([...revisions.values()].map((r) => r.billId)).toEqual([null, '119-hr-1']);
    expect([...revisions.values()].every((r) => r.parser.length <= 64)).toBe(true);
    await expect(
      persistFederalEvidenceSnapshot(db, { ...base, billId: '119-hr-2', observationKey: 'wrong' }),
    ).rejects.toThrow('BINDING_UNQUALIFIED');
    expect(revisions.size).toBe(2);
  });
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
