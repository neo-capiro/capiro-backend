jest.mock('../embeddings/embedder.js', () => ({
  embedAndUpsert: jest.fn(async () => 'inserted'),
  sha256: (text: string) => 'hash:' + text,
  assertEmbeddingStorageCompatibility: jest.fn(),
}));
import { embedAndUpsert } from '../embeddings/embedder';
import {
  embedBillPassage,
  loadProvenBillPassages,
  billPassageIsProven,
} from './bill-passage-embedding';
import { BILL_EXTRACTION_VERSION } from './bill-document-structure';
import { CHUNKER_VERSION } from './bill-text-passages';
const provider = { metadata: { model: 'exact-model' } } as any;
const args = {
  tenantId: null,
  sourceType: 'bill_passage',
  sourceId: 'v2:new:0',
  text: 'Identical public passage.',
};
describe('bill vector hash reuse', () => {
  beforeEach(() => jest.clearAllMocks());
  it('copies only same-model exact-content public vectors and bypasses provider', async () => {
    const db: any = {
      $executeRawUnsafe: jest.fn(async (sql: string) => (sql.startsWith('INSERT') ? 1 : 0)),
      $transaction: async (fn: any) => fn(db),
    };
    expect(await embedBillPassage(db, args, provider)).toBe('inserted');
    expect(embedAndUpsert).not.toHaveBeenCalled();
    const call = db.$executeRawUnsafe.mock.calls[1];
    expect(call[0]).toContain('tenant_id IS NULL AND client_id IS NULL AND owner_user_id IS NULL');
    expect(call.slice(1)).toEqual([
      'bill_passage',
      'v2:new:0',
      'exact-model',
      'hash:' + args.text,
      args.text,
    ]);
  });
  it('falls back to canonical embedder if no exact vector exists and refuses lost leases', async () => {
    const db: any = {
      $executeRawUnsafe: jest.fn(async () => 0),
      $transaction: async (fn: any) => fn(db),
    };
    await embedBillPassage(db, args, provider);
    expect(embedAndUpsert).toHaveBeenCalledTimes(1);
    await expect(
      embedBillPassage(db, { ...args, beforeWrite: async () => false }, provider),
    ).rejects.toThrow('BILL_TEXT_LEASE_LOST');
    expect(embedAndUpsert).toHaveBeenCalledTimes(1);
  });
  it('binds a single immutable extraction and the same full proof as search and coverage', async () => {
    const query = jest.fn(async (_sql: string, ..._args: unknown[]) => []);
    const identity = {
      extractionId: 'extraction',
      sourceKind: 'state' as const,
      revisionId: 'revision',
      documentHash: 'document',
      structureHash: 'structure',
      textHash: 'text',
      model: 'exact-model',
      billId: 'bill',
    };
    await loadProvenBillPassages({ $queryRawUnsafe: query as any }, identity);
    const [sql, ...bindings] = query.mock.calls[0]!;
    expect(bindings).toEqual([
      'extraction',
      'state',
      'revision',
      'document',
      BILL_EXTRACTION_VERSION,
      'structure',
      'text',
      CHUNKER_VERSION,
      'exact-model',
      'bill',
    ]);
    for (const clause of [
      'v.tenant_id IS NULL',
      'v.client_id IS NULL',
      'v.owner_user_id IS NULL',
      'v.model=$9',
      'v.content_text=p.content_text',
      "v.content_hash=encode(sha256(convert_to(p.content_text,'UTF8')),'hex')",
      'e.document_hash=$4',
      'e.parser_version=$5',
      "v.metadata_jsonb->>'extractionVersion'",
      "v.metadata_jsonb->>'chunkerVersion'",
    ])
      expect(sql).toContain(clause);
  });
  it('requires full metadata and generated passage offsets/hash, ignoring JSON object key order only', () => {
    const chunk = { ordinal: 0, start: 5, end: 29, text: 'Identical public passage.' };
    const metadata = {
      sourceUrl: 'https://example.test',
      startOffset: 5,
      sectionPath: ['1', '(a)'],
    };
    const proof = {
      ordinal: 0,
      start: 5,
      end: 29,
      contentHash: 'hash:' + chunk.text,
      metadata: { sectionPath: ['1', '(a)'], startOffset: 5, sourceUrl: 'https://example.test' },
    };
    expect(billPassageIsProven(proof, chunk, metadata)).toBe(true);
    // Match the JSON representation the existing metadata writer persists.
    expect(billPassageIsProven(proof, chunk, { ...metadata, absent: undefined })).toBe(true);
    expect(
      billPassageIsProven({ ...proof, metadata: { ...metadata, startOffset: 6 } }, chunk, metadata),
    ).toBe(false);
    expect(billPassageIsProven({ ...proof, end: 30 }, chunk, metadata)).toBe(false);
    expect(billPassageIsProven({ ...proof, contentHash: 'wrong' }, chunk, metadata)).toBe(false);
    expect(billPassageIsProven(undefined, chunk, metadata)).toBe(false);
  });
});
