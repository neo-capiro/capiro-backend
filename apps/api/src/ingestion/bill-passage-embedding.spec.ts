jest.mock('../embeddings/embedder.js', () => ({
  embedAndUpsert: jest.fn(async () => 'inserted'),
  sha256: (text: string) => 'hash:' + text,
  assertEmbeddingStorageCompatibility: jest.fn(),
}));
import { embedAndUpsert } from '../embeddings/embedder';
import { embedBillPassage } from './bill-passage-embedding';
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
});
