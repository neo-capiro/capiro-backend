import { persistFederalEvidenceSnapshot } from './persistence.js';
import { captureFederalResponse } from './capture.js';

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

test('qualified immutable revision identity cannot reuse the old unreported parser identity', async () => {
  const { text, capture } = await captureFederalResponse(
    new Response('<bill>Synthetic</bill>'),
    'xml',
  );
  const input = {
    provider: 'govinfo' as const,
    collection: 'BILLS' as const,
    packageId: 'BILLS-119hr1ih',
    lineageKey: '119-hr-1:house',
    sourceUrl: 'https://www.govinfo.gov/content/synthetic.xml',
    rawContent: text,
    extractedText: text,
    completeness: 'complete' as const,
    inventoryWindowEnd: new Date('2026-01-01'),
    observationKey: 'synthetic-capture',
  };
  const inserted: unknown[][] = [],
    selected: unknown[][] = [];
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const query = sql.join('?');
      if (query.includes('INSERT INTO federal_evidence_revision')) {
        inserted.push(values);
        return [];
      }
      if (query.includes('SELECT id FROM federal_evidence_revision')) {
        selected.push(values);
        throw new Error('STOP_AFTER_IDENTITY_QUERY');
      }
      return [];
    }),
  };
  const prisma = {
    $transaction: async (body: (client: typeof tx) => Promise<unknown>) => body(tx),
  } as never;
  await expect(persistFederalEvidenceSnapshot(prisma, input)).rejects.toThrow(
    'STOP_AFTER_IDENTITY_QUERY',
  );
  await expect(persistFederalEvidenceSnapshot(prisma, { ...input, capture })).rejects.toThrow(
    'STOP_AFTER_IDENTITY_QUERY',
  );
  expect(inserted[0]).toContain('federal-legislative-exact-code-v1');
  expect(inserted[1]).toContain('federal-legislative-exact-code-v1+federal-source-capture/1');
  expect(selected[0]).toContain('federal-legislative-exact-code-v1');
  expect(selected[1]).toContain('federal-legislative-exact-code-v1+federal-source-capture/1');
  expect(inserted[1]).toContain(JSON.stringify({ capture }));
});

test('mismatched or forged metadata capture is rejected before a persistence transaction', async () => {
  const { text, capture } = await captureFederalResponse(new Response('Synthetic'), 'txt');
  const input = {
    provider: 'govinfo' as const,
    collection: 'BILLS' as const,
    packageId: 'BILLS-119hr1ih',
    lineageKey: '119-hr-1:house',
    sourceUrl: 'https://www.govinfo.gov/content/synthetic.txt',
    rawContent: text,
    extractedText: text,
    completeness: 'complete' as const,
    inventoryWindowEnd: new Date('2026-01-01'),
    observationKey: 'synthetic-capture',
  };
  const transaction = jest.fn();
  await expect(
    persistFederalEvidenceSnapshot({ $transaction: transaction } as never, {
      ...input,
      capture: { ...capture, byteLength: 999 },
    }),
  ).rejects.toThrow('FEDERAL_SOURCE_CAPTURE_INVALID');
  await expect(
    persistFederalEvidenceSnapshot({ $transaction: transaction } as never, {
      ...input,
      metadata: { capture },
    }),
  ).rejects.toThrow('FEDERAL_CAPTURE_METADATA_RESERVED');
  expect(transaction).not.toHaveBeenCalled();
});
