import { createHash } from 'node:crypto';
import { persistDocumentEvidence } from './legiscan-document-evidence.js';
import { observeStateRecord } from './published-record-observations.js';
jest.mock('./published-record-observations.js', () => ({ observeStateRecord: jest.fn() }));
jest.mock('./bill-document-structure.js', () => {
  const actual = jest.requireActual('./bill-document-structure.js');
  return {
    ...actual,
    extractBillDocumentStructure: jest.fn(async () =>
      actual.structureText('SECTION 1. Synthetic qualified bill text.'),
    ),
  };
});
it('keeps the canonical version and primary stream intact while recording a separately bound PDF format', async () => {
  const bytes = Buffer.from('%PDF-synthetic verified bytes'),
    hash = createHash('md5').update(bytes).digest('hex');
  const format = {
    role: 'alternate' as const,
    primaryProviderHash: 'a'.repeat(32),
    receiptId: 'b'.repeat(64),
    archiveHash: 'c'.repeat(64),
  };
  const doc = {
    bill_id: 1,
    doc_id: 2,
    type: 'Introduced',
    date: '2026-01-01',
    mime: 'application/pdf',
    text_size: bytes.length,
    text_hash: hash,
    doc: bytes.toString('base64'),
    state_link: 'https://www.flsenate.gov/2/PDF',
    format,
  };
  const stub = {
    kind: 'text',
    providerId: 2,
    providerHash: hash,
    size: bytes.length,
    mime: doc.mime,
    stateUrl: doc.state_link,
    date: doc.date,
    versionType: doc.type,
    format,
  };
  const create = jest.fn();
  const db: any = {
    stateBillVersion: {
      findUnique: jest.fn(async () => ({
        id: 'canonical-version',
        billKey: 'bill',
        mime: 'text/html',
        stateUrl: 'https://www.flsenate.gov/2/HTML',
      })),
    },
    stateBill: { findUnique: jest.fn(async () => ({ legiscanBillId: 1 })) },
    $queryRawUnsafe: jest.fn(async () => [{ stub }]),
    $transaction: async (run: any) => run({ stateBillPublishedRecord: { createMany: create } }),
  };
  const qualified = { kind: 'text' as const, id: 2, billId: 1, providerHash: hash };
  await persistDocumentEvidence(db, 'bill', doc, qualified);
  expect(create.mock.calls[0]![0].data[0]).toMatchObject({
    sourceIdentity: 'canonical-version:format:pdf',
    evidence: {
      canonicalVersionId: 'canonical-version',
      format,
      providerHash: hash,
      mime: 'application/pdf',
      contentSnapshotBase64: doc.doc,
    },
  });
  expect(observeStateRecord).toHaveBeenCalledWith(
    expect.anything(),
    'bill',
    'document',
    'canonical-version:format:pdf',
    expect.any(String),
  );
  await persistDocumentEvidence(db, 'bill', doc, qualified);
  expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
  for (const changed of [
    { text_hash: 'd'.repeat(32) },
    { mime: 'text/html' },
    { state_link: 'https://www.flsenate.gov/other/PDF' },
    { doc: Buffer.from('changed').toString('base64') },
  ])
    await expect(
      persistDocumentEvidence(db, 'bill', { ...doc, ...changed }, qualified),
    ).rejects.toThrow();
  expect(create).toHaveBeenCalledTimes(2);
  db.stateBillVersion.findUnique.mockResolvedValue({ id: 'foreign', billKey: 'other' });
  await expect(persistDocumentEvidence(db, 'bill', doc, qualified)).rejects.toThrow(
    'DOCUMENT_SUBJECT_MISMATCH',
  );
});
