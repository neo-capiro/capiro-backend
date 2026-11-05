let fakeDb: any;
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn(() => fakeDb) }));
import { PrismaClient } from '@prisma/client';
import { main, verifyIndexes } from './index-bill-passages.js';
const lexical = {
  name: 'context_embeddings_bill_passage_tsv_idx',
  valid: true,
  ready: true,
  table: 'context_embeddings',
  method: 'gin',
  keys: 1,
  opclass: 'tsvector_ops',
  column: null,
  expression: "to_tsvector('english'::regconfig, content_text)",
  predicate:
    "((tenant_id IS NULL) AND (source_type = ANY (ARRAY['bill_passage'::text, 'state_bill_passage'::text])))",
};
const vector = {
  ...lexical,
  name: 'context_embeddings_bill_passage_hnsw_idx',
  method: 'hnsw',
  opclass: 'vector_cosine_ops',
  column: 'embedding',
  expression: null,
};
const originalUrl = process.env.DATABASE_URL;
afterAll(() => {
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.DATABASE_URL = 'postgresql://test:unused@clone/capiro';
  fakeDb = {
    $queryRawUnsafe: jest.fn(async () => []),
    $executeRawUnsafe: jest.fn(),
    $disconnect: jest.fn(),
  };
});
it('accepts only the intended complete public passage indexes', () =>
  expect(() => verifyIndexes([lexical, vector])).not.toThrow());
it.each([
  { valid: false },
  { ready: false },
  { table: 'other' },
  { method: 'btree' },
  { keys: 2 },
  { opclass: 'jsonb_ops' },
  { expression: "to_tsvector('simple'::regconfig, content_text)" },
  { predicate: "tenant_id IS NULL OR source_type='bill_passage'" },
])('rejects mismatched index %p', (change) =>
  expect(() => verifyIndexes([{ ...lexical, ...change }])).toThrow('EXISTING_BILL_INDEX'),
);
it('rejects wrong host before any SQL', async () => {
  await expect(main(['--commit', '--expected-host', 'other'])).rejects.toThrow(
    'DATABASE_HOST_MISMATCH',
  );
  expect(fakeDb.$queryRawUnsafe).not.toHaveBeenCalled();
});
it('defaults to read-only inspection', async () => {
  await main([]);
  expect(fakeDb.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  expect(fakeDb.$executeRawUnsafe).not.toHaveBeenCalled();
});
it('applies only two concurrent indexes and verifies them without migration ledger writes', async () => {
  fakeDb.$queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([lexical, vector]);
  await main(['--commit', '--expected-host', 'clone']);
  const sql = fakeDb.$executeRawUnsafe.mock.calls.map((a: any[]) => a[0]);
  expect(sql).toHaveLength(4);
  expect(
    sql
      .slice(2)
      .every((s: string) =>
        s.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS context_embeddings_bill_passage_'),
      ),
  ).toBe(true);
  expect(sql.join(' ')).not.toContain('_prisma_migrations');
});

it('rejects missing database configuration without allocating Prisma', async () => {
  delete process.env.DATABASE_URL;
  await expect(main([])).rejects.toThrow('DATABASE_URL_REQUIRED');
  expect(PrismaClient).not.toHaveBeenCalled();
});
it('disconnects on index inspection failure', async () => {
  fakeDb.$queryRawUnsafe.mockRejectedValueOnce(Error('INSPECTION_FAILURE'));
  await expect(main([])).rejects.toThrow('INSPECTION_FAILURE');
  expect(fakeDb.$disconnect).toHaveBeenCalledTimes(1);
});
