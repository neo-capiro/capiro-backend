import { drainStateDocuments, parseStateTextArgs } from './sync-state-text-drain.js';
import {
  retrieveStateDocument,
  StateDocumentRetrievalError,
} from '../src/ingestion/state-document-retrieval.js';
import { persistDocumentEvidence } from '../src/ingestion/legiscan-document-evidence.js';
jest.mock('../src/ingestion/state-document-retrieval.js', () => ({
  retrieveStateDocument: jest.fn(),
  StateDocumentRetrievalError: class extends Error {
    constructor(
      message: string,
      public retryAfterMs = 3600000,
    ) {
      super(message);
    }
  },
}));
jest.mock('../src/ingestion/legiscan-document-evidence.js', () => ({
  persistDocumentEvidence: jest.fn(),
}));
const stub = {
  kind: 'text' as const,
  providerId: 20,
  providerHash: 'a'.repeat(32),
  mime: 'text/plain',
  size: 5,
  stateUrl: 'https://example.gov/20',
};
const row = {
  billKey: 'synthetic',
  providerBillId: 10,
  state: 'FL',
  cursorId: 'FL-1',
  identity: 'text:20',
  attempts: 0,
  facts: { retainedDocumentStubs: [stub] },
};
const options = { states: ['FL'], limit: 1, commit: true, publisherOnly: false };
function database() {
  return {
    $queryRawUnsafe: jest.fn(async () => [row]),
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 1),
  } as any;
}
beforeEach(() => {
  jest.clearAllMocks();
  (retrieveStateDocument as jest.Mock).mockResolvedValue({ document: {}, apiAttempts: 0 });
  (persistDocumentEvidence as jest.Mock).mockResolvedValue('extracted');
});
test('dry inspection cannot fetch or persist', async () => {
  const prisma = database();
  await drainStateDocuments(prisma, { ...options, commit: false });
  expect(retrieveStateDocument).not.toHaveBeenCalled();
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
});
test('complete existing version is skipped without requests', async () => {
  const prisma = database();
  prisma.$queryRaw.mockResolvedValue([{ id: 'retained' }]);
  await drainStateDocuments(prisma, options);
  expect(retrieveStateDocument).not.toHaveBeenCalled();
});
test('budget-held version stays pending and cannot claim available', async () => {
  const prisma = database();
  (retrieveStateDocument as jest.Mock).mockRejectedValue(
    new StateDocumentRetrievalError('EXISTING_PROVIDER_BUDGET_HOLD'),
  );
  const result = await drainStateDocuments(prisma, options);
  expect(result).toMatchObject({ inserted: 0, complete: false });
  expect(persistDocumentEvidence).not.toHaveBeenCalled();
  expect(prisma.$executeRaw.mock.calls.at(-1).slice(1)).toContain('pending');
});
test('partial structure is retained but never credited as complete', async () => {
  const prisma = database();
  (persistDocumentEvidence as jest.Mock).mockResolvedValue('partial');
  const result = await drainStateDocuments(prisma, options);
  expect(result.complete).toBe(false);
  expect(prisma.$executeRaw.mock.calls.at(-1).slice(1)).toContain('DOCUMENT_EXTRACTION_PARTIAL');
});
test('every retained hash is required before queue row becomes available', async () => {
  const prisma = database();
  prisma.$queryRawUnsafe.mockResolvedValue([
    { ...row, facts: { retainedDocumentStubs: [stub, { ...stub, providerHash: 'b'.repeat(32) }] } },
  ]);
  await drainStateDocuments(prisma, options);
  expect(retrieveStateDocument).toHaveBeenCalledTimes(1);
  expect(prisma.$executeRaw.mock.calls.at(-1).slice(1)).toContain('DOCUMENT_RUN_LIMIT');
});
test('commit requires the approved clone and explicit scope', () => {
  expect(() =>
    parseStateTextArgs(['--commit', '--states', 'FL'], {
      DATABASE_URL: 'postgres://localhost/test',
    }),
  ).toThrow('DATABASE_MISMATCH');
  expect(() =>
    parseStateTextArgs(['--states', 'XX'], { DATABASE_URL: 'postgres://localhost/test' }),
  ).toThrow('INVALID_STATE_TEXT_SCOPE');
});
