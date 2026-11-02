import { drainStateDocuments, parseStateTextArgs } from './sync-state-text-drain.js';
import { createHash } from 'node:crypto';
import {
  retrieveStateDocument,
  StateDocumentRetrievalError,
} from '../src/ingestion/state-document-retrieval.js';
import { persistDocumentEvidence } from '../src/ingestion/legiscan-document-evidence.js';
import { BILL_EXTRACTION_VERSION } from '../src/ingestion/bill-document-structure.js';
jest.mock('../src/ingestion/state-document-retrieval.js', () => ({
  retrieveStateDocument: jest.fn(),
  StateDocumentRetrievalError: class extends Error {
    constructor(
      message: string,
      public retryAfterMs = 3600000,
      public publisherFailure?: string,
      public publisherHost?: string,
      public publisherHttpStatus?: number,
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
  providerHash: createHash('md5').update('hello').digest('hex'),
  mime: 'text/plain',
  size: 5,
  stateUrl: 'https://example.gov/20',
};
const row = {
  billKey: 'synthetic',
  providerBillId: 10,
  state: 'FL',
  cursorId: 'FL-1',
  identity: 'text:20:' + stub.providerHash,
  attempts: 0,
  facts: { retainedDocumentStubs: [stub] },
};
const options = { states: ['FL'], limit: 1, commit: true, publisherOnly: false };
function database() {
  return {
    $queryRawUnsafe: jest.fn(async () => [row]),
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(async (fn: any) => fn({ $executeRaw: jest.fn(async () => 1) })),
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
  prisma.$queryRaw.mockResolvedValue([
    {
      id: 'retained',
      complete: true,
      evidence: {
        contentSnapshotBase64: Buffer.from('hello').toString('base64'),
        contentHash: createHash('sha256').update('hello').digest('hex'),
      },
    },
  ]);
  await drainStateDocuments(prisma, options);
  expect(retrieveStateDocument).not.toHaveBeenCalled();
  expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain(BILL_EXTRACTION_VERSION);
  expect(prisma.$queryRaw.mock.calls[0][0].join('')).not.toContain('bill-structure-v1');
});
test('retained verified raw bytes await extraction without another publisher or API fetch', async () => {
  const prisma = database();
  prisma.$queryRaw.mockResolvedValue([
    {
      id: 'retained',
      complete: false,
      evidence: {
        contentSnapshotBase64: Buffer.from('hello').toString('base64'),
        contentHash: createHash('sha256').update('hello').digest('hex'),
      },
    },
  ]);
  await drainStateDocuments(prisma, options);
  expect(retrieveStateDocument).not.toHaveBeenCalled();
  expect(prisma.$executeRaw.mock.calls.at(-1).slice(1)).toContain('DOCUMENT_EXTRACTION_PENDING');
});
test('legacy ID-only checks fan out exact hashes atomically without marking the aggregate available', async () => {
  const prisma = database(),
    execute = jest.fn(async (_query: TemplateStringsArray, ..._bindings: unknown[]) => 1);
  prisma.$transaction.mockImplementation(async (fn: any) => fn({ $executeRaw: execute }));
  prisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    sql.includes("[0-9]+$'")
      ? [
          {
            ...row,
            identity: 'text:20',
            facts: { retainedDocumentStubs: [stub, { ...stub, providerHash: 'b'.repeat(32) }] },
          },
        ]
      : [],
  );
  await drainStateDocuments(prisma, options);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(execute.mock.calls[0]!.slice(1)).toContain('text:20:' + stub.providerHash);
  expect(execute.mock.calls[1]!.slice(1)).toContain('text:20:' + 'b'.repeat(32));
  expect(execute.mock.calls[2]![0].join('')).toContain("state='metadata_only'");
  expect(execute.mock.calls[2]![0].join('')).toContain('next_check_at=NULL');
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

test.each(['PUBLISHER_RETRY_AFTER', 'PUBLISHER_COOLDOWN_ACTIVE'])(
  '%s stops the batch without consuming any document failure counter',
  async (code) => {
    const prisma = database();
    prisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
      sql.includes("[0-9]+$'")
        ? []
        : [
            { ...row, attempts: 9 },
            { ...row, billKey: 'untouched', attempts: 9 },
          ],
    );
    (retrieveStateDocument as jest.Mock).mockRejectedValue(
      new StateDocumentRetrievalError(
        code,
        120000,
        code,
        'www.flsenate.gov',
        code === 'PUBLISHER_RETRY_AFTER' ? 429 : undefined,
      ),
    );
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await drainStateDocuments(prisma, { ...options, limit: 100 });
      expect(result).toMatchObject({
        errors: 0,
        skipped: 1,
        complete: false,
        incompleteReason: code,
      });
      expect(retrieveStateDocument).toHaveBeenCalledTimes(1);
      expect(persistDocumentEvidence).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const update = prisma.$executeRaw.mock.calls[0];
      expect(update[0].join('')).toContain("state='pending'");
      expect(update[0].join('')).not.toContain('attempts=');
      expect(update[0].join('')).toContain('ELSE attempted_at END');
      expect(update[1]).toBe(code);
      expect(update[2]).toBe(code === 'PUBLISHER_RETRY_AFTER');
      expect(update[3]).toBe(3 * 3600000);
      expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
        event: 'PUBLISHER_BACKOFF',
        complete: false,
        host: 'www.flsenate.gov',
        requestAttempted: code === 'PUBLISHER_RETRY_AFTER',
        retryAfterMs: 3 * 3600000,
      });
    } finally {
      log.mockRestore();
    }
  },
);

test('an unreadable durable cooldown aborts before any document state mutation', async () => {
  const prisma = database();
  (retrieveStateDocument as jest.Mock).mockRejectedValue(
    new StateDocumentRetrievalError('PUBLISHER_COOLDOWN_STATE_FAILED'),
  );
  await expect(drainStateDocuments(prisma, options)).rejects.toThrow(
    'PUBLISHER_COOLDOWN_STATE_FAILED',
  );
  expect(persistDocumentEvidence).not.toHaveBeenCalled();
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
});
test('separate exact hashes do not let an unavailable old version starve a newer one at cap one', async () => {
  const prisma = database();
  const second = { ...stub, providerHash: 'b'.repeat(32) };
  let attempts = 0;
  prisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    sql.includes("[0-9]+$'")
      ? []
      : [
          {
            ...row,
            identity: attempts === 0 ? row.identity : 'text:20:' + second.providerHash,
            facts: { retainedDocumentStubs: [stub, second] },
          },
        ],
  );
  (retrieveStateDocument as jest.Mock).mockRejectedValueOnce(
    new StateDocumentRetrievalError('PUBLISHER_UNAVAILABLE'),
  );
  await drainStateDocuments(prisma, options);
  attempts++;
  await drainStateDocuments(prisma, options);
  expect(retrieveStateDocument).toHaveBeenCalledTimes(2);
  expect((retrieveStateDocument as jest.Mock).mock.calls[1]![1].stub.providerHash).toBe(
    second.providerHash,
  );
  expect(prisma.$executeRaw.mock.calls[0].slice(1)).toContain('failed');
  expect(prisma.$executeRaw.mock.calls.at(-1)[0].join('')).toContain("state='available'");
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
