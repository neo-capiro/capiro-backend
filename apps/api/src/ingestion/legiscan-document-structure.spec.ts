import { createHash } from 'node:crypto';
jest.mock('./published-record-observations.js', () => ({
  observeStateRecord: jest.fn(async () => {}),
}));
import { documentEvidence, persistDocumentEvidence } from './legiscan-document-evidence';
describe('state source bytes survive extraction failure', () => {
  it('keeps provider-verified invalid UTF8 with explicit unreadable coverage and no passages', async () => {
    const bytes = Buffer.from([255, 254, 253]);
    const doc = {
      bill_id: 1,
      doc_id: 2,
      mime: 'text/plain',
      doc: bytes.toString('base64'),
      text_hash: createHash('md5').update(bytes).digest('hex'),
      text_size: 3,
    } as any;
    const { evidence } = await documentEvidence(doc, { billId: 1, docId: 2 });
    expect(evidence.extractionState).toBe('unreadable');
    expect(evidence.coverage).toBe('unknown');
    expect(evidence.contentSnapshotBase64).toBe(doc.doc);
    expect(evidence.structure.text).toBe('');
    expect(evidence.structure.sections).toEqual([]);
    expect(evidence.structure.warnings).toEqual(['DOCUMENT_TEXT_ENCODING_UNQUALIFIED']);
    await expect(
      documentEvidence({ ...doc, text_hash: '0'.repeat(32) }, { billId: 1, docId: 2 }),
    ).rejects.toThrow('DOCUMENT_PROVIDER_HASH_MISMATCH');
  });
  it('admits only a hash-qualified frozen dateless text and preserves existing version ownership', async () => {
    const bytes = Buffer.from('Exact frozen version text.');
    const hash = createHash('md5').update(bytes).digest('hex');
    const doc = {
      bill_id: 1,
      doc_id: 2,
      mime: 'text/plain',
      document_kind: 'text',
      doc: bytes.toString('base64'),
      text_hash: hash,
      text_size: bytes.length,
      date: '2026-02-30',
    } as any;
    const stub = { id: 2, kind: 'text' as const, billId: 1, providerHash: hash };
    const create = jest.fn(async () => ({ count: 1 }));
    const db: any = {
      stateBillVersion: { findUnique: jest.fn(async () => null) },
      stateBill: {
        findUnique: jest.fn(async () => ({
          legiscanBillId: 1,
          reportSourceFacts: {
            retainedDocumentStubs: [{ kind: 'text', providerId: 2, providerHash: hash }],
          },
        })),
      },
      $transaction: async (fn: any) => fn({ stateBillPublishedRecord: { createMany: create } }),
    };
    await expect(persistDocumentEvidence(db, 'ca-test', doc, stub)).resolves.toBe('extracted');
    expect(create.mock.calls[0][0].data[0]).toMatchObject({
      sourceIdentity: 'legiscan:text:2',
      eventDate: null,
      evidence: { rawDate: '2026-02-30', date: null },
    });
    await expect(
      persistDocumentEvidence(db, 'ca-test', doc, { ...stub, billId: 3 }),
    ).rejects.toThrow('DOCUMENT_SUBJECT_MISMATCH');
    await expect(
      persistDocumentEvidence(db, 'ca-test', doc, { ...stub, providerHash: '0'.repeat(32) }),
    ).rejects.toThrow('DOCUMENT_SUBJECT_MISMATCH');
    db.stateBillVersion.findUnique.mockResolvedValue({ id: 'normal-version', billKey: 'ca-test' });
    await persistDocumentEvidence(db, 'ca-test', { ...doc, date: '2026-02-01' }, stub);
    expect(create.mock.calls[1][0].data[0].sourceIdentity).toBe('normal-version');
    db.stateBillVersion.findUnique.mockResolvedValue({
      id: 'foreign-version',
      billKey: 'other-bill',
    });
    await expect(persistDocumentEvidence(db, 'ca-test', doc, stub)).rejects.toThrow(
      'DOCUMENT_SUBJECT_MISMATCH',
    );
  });
});
