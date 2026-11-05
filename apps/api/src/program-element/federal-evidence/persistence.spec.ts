import { persistFederalEvidenceSnapshot } from './persistence.js';
import { byteHash } from '../../ingestion/federal-document-bytes.js';
import { captureFederalResponse } from './capture.js';
import { createHash } from 'node:crypto';

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
  const bytes = Buffer.from(text);
  const originalBytes = { base64: bytes.toString('base64'), sha256: byteHash(bytes), mime: 'application/xml' };
  for (const provenance of [{ originalBytes }, { originalBytes, capture }, { originalBytes, capture }]) {
    await expect(persistFederalEvidenceSnapshot(prisma, { ...input, ...provenance })).rejects.toThrow(
      'STOP_AFTER_IDENTITY_QUERY',
    );
  }
  expect(inserted).toHaveLength(5);
  expect(selected).toHaveLength(5);
  expect(inserted[2]?.[9]).toMatch(/^fed-exact-v1:bytes:/);
  expect(inserted[3]?.[9]).toMatch(/^fed-capture-v1:/);
  expect(inserted[3]?.[9]).toBe(inserted[4]?.[9]);
  expect(new Set(inserted.slice(0, 4).map((values) => values[9])).size).toBe(4);
  for (const [index, values] of inserted.entries()) {
    expect(String(values[9]).length).toBeLessThanOrEqual(64);
    expect(selected[index]?.[3]).toBe(values[9]);
  }
  expect(JSON.parse(String(inserted[3]?.[16]))).toMatchObject({
    capture, originalBytesBase64: originalBytes.base64, rawBytesHash: originalBytes.sha256,
  });
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

test.each([
  ['provenance-only recapture', 'Synthetic', 'Synthetic', false, false],
  ['combined capture and original recapture', 'Synthetic', 'Synthetic', false, true],
  ['changed source bytes', 'Earlier raw source', 'Synthetic', true, false],
  ['changed extracted text', 'Synthetic', 'Earlier extraction', true, false],
])('%s preserves revision/observation and emits only genuine text changes', async (_, priorRaw, priorText, changed, withOriginal) => {
  const { text, capture } = await captureFederalResponse(new Response('Synthetic'), 'txt');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const tx = {
    $executeRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ query: sql.join('?'), values });
      return 1;
    }),
    $queryRaw: jest.fn(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const query = sql.join('?');
      statements.push({ query, values });
      if (query.includes('FROM federal_evidence_current c')) {
        expect(query).toContain('r.extraction_hash AS "extractionHash"');
        expect(query).toContain('LEFT JOIN federal_evidence_revision r ON r.id = c.revision_id');
        return [{ state: 'present', revisionId: 'old-revision', billId: null,
          contentHash: hash(priorRaw as string), extractionHash: hash(priorText as string), observationKey: 'prior' }];
      }
      if (query.includes('INSERT INTO federal_evidence_revision')) return [{ id: 'capture-revision' }];
      if (query.includes('INSERT INTO federal_evidence_observation')) return [{ id: 2n }];
      if (query.includes('INSERT INTO federal_evidence_mention_event')) return [{ id: 'event' }];
      return [];
    }),
  };
  const result = await persistFederalEvidenceSnapshot({
    $transaction: async (body: (client: typeof tx) => Promise<unknown>) => body(tx),
  } as never, {
    provider: 'govinfo', collection: 'BILLS', packageId: 'BILLS-119hr1ih', lineageKey: '119-hr-1:house',
    sourceUrl: 'https://www.govinfo.gov/content/synthetic.txt', rawContent: text, extractedText: text,
    capture, ...(withOriginal ? { originalBytes: { base64: Buffer.from(text).toString('base64'), sha256: hash(text), mime: 'text/plain' } } : {}),
    completeness: 'complete', inventoryWindowEnd: new Date('2026-01-01'), observationKey: 'recapture',
    mentions: [],
  });
  expect(result).toMatchObject({ revisionId: 'capture-revision', revisionInserted: true,
    observationInserted: true, eventTypes: changed ? ['text_changed'] : [] });
  const outbox = statements.filter(({ query }) => query.includes('INSERT INTO federal_evidence_change_outbox'));
  expect(outbox).toHaveLength(changed ? 1 : 0);
  expect(statements.filter(({ query }) => query.includes('INSERT INTO federal_evidence_mention_event')))
    .toHaveLength(changed ? 1 : 0);
  const firstOutbox = outbox[0];
  if (changed && !firstOutbox) throw new Error('Changed evidence did not enqueue its event');
  if (changed && firstOutbox) expect(JSON.parse(firstOutbox.values[2] as string)).toMatchObject({
    eventType: 'text_changed', previousRevisionId: 'old-revision', currentRevisionId: 'capture-revision',
    after: { contentHash: hash(text), extractionHash: hash(text) }, historical: false,
  });
});
