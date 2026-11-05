import { retrieveStateDocument } from './state-document-retrieval.js';
import { fetchStatePublisherDocument, PublisherDocumentError } from './state-publisher-document.js';
import { getBillText, getSupportingDocument } from '../external/legiscan/legiscan.client.js';
import { currentQuotaMonth } from './legiscan-quota.util.js';
jest.mock('./state-publisher-document.js', () => ({
  fetchStatePublisherDocument: jest.fn(),
  PublisherDocumentError: class extends Error {
    constructor(
      message: string,
      public retryAfterMs = 0,
      public host?: string,
      public httpStatus?: number,
    ) {
      super(message);
    }
  },
  publisherCooldown: jest.fn(() => ({ remaining: jest.fn(), hold: jest.fn() })),
}));
jest.mock('../external/legiscan/legiscan.client.js', () => ({
  getBillText: jest.fn(),
  getSupportingDocument: jest.fn(),
}));
const request = {
  state: 'FL',
  billKey: 'synthetic',
  providerBillId: 10,
  cursorId: 'FL-1',
  apiKey: 'synthetic',
  stub: {
    kind: 'text' as const,
    providerId: 20,
    providerHash: 'a'.repeat(32),
    size: 5,
    mime: 'text/plain',
  },
};
const doc = {
  bill_id: 10,
  doc_id: 20,
  text_hash: 'a'.repeat(32),
  text_size: 5,
  mime: 'text/plain',
  doc: 'aGVsbG8=',
  type: 'Introduced',
};
function database(used = 0) {
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    stateSyncCursor: {
      findMany: jest.fn(async () => [{ queriesUsed: used, quotaMonth: currentQuotaMonth() }]),
    },
  };
  return {
    ...tx,
    $queryRawUnsafe: jest.fn(async () => []),
    $transaction: jest.fn(async (run) => run(tx)),
    tx,
  } as any;
}
beforeEach(() => {
  jest.clearAllMocks();
  (fetchStatePublisherDocument as jest.Mock).mockRejectedValue(
    new PublisherDocumentError('DOCUMENT_PROVIDER_HASH_MISMATCH'),
  );
});
test('verified publisher bytes require no API key, reservation, or provider call even at exhausted budget', async () => {
  const prisma = database(30000);
  (fetchStatePublisherDocument as jest.Mock).mockResolvedValue(doc);
  expect(await retrieveStateDocument(prisma, { ...request, apiKey: undefined })).toMatchObject({
    document: doc,
    apiAttempts: 0,
    acquisition: 'publisher',
  });
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(getBillText).not.toHaveBeenCalled();
});
test('budget exhaustion preserves publisher failure and refuses every provider operation', async () => {
  const prisma = database(30000);
  await expect(retrieveStateDocument(prisma, request)).rejects.toMatchObject({
    message: 'EXISTING_PROVIDER_BUDGET_HOLD',
    publisherFailure: 'DOCUMENT_PROVIDER_HASH_MISMATCH',
  });
  expect(getBillText).not.toHaveBeenCalled();
  expect(getSupportingDocument).not.toHaveBeenCalled();
});
test('publisher-only failure cannot spend provider quota', async () => {
  const prisma = database();
  await expect(retrieveStateDocument(prisma, { ...request, publisherOnly: true })).rejects.toThrow(
    'DOCUMENT_PROVIDER_HASH_MISMATCH',
  );
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
test('alternate format proof precedes transport and never falls back to the primary API even with a key', async () => {
  const prisma = database();
  const stub = {
    ...request.stub,
    mime: 'application/pdf',
    stateUrl: 'https://www.flsenate.gov/alternate/PDF',
    format: {
      role: 'alternate' as const,
      primaryProviderHash: 'b'.repeat(32),
      receiptId: 'c'.repeat(64),
      archiveHash: 'd'.repeat(64),
    },
  };
  prisma.$queryRawUnsafe.mockResolvedValue([{ stub }]);
  await expect(retrieveStateDocument(prisma, { ...request, stub })).rejects.toThrow(
    'DOCUMENT_PROVIDER_HASH_MISMATCH',
  );
  expect(fetchStatePublisherDocument).toHaveBeenCalledTimes(1);
  expect(getBillText).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
  jest.mocked(fetchStatePublisherDocument).mockClear();
  prisma.$queryRawUnsafe.mockResolvedValue([]);
  await expect(retrieveStateDocument(prisma, { ...request, stub })).rejects.toThrow(
    'DOCUMENT_FORMAT_INVENTORY_MISMATCH',
  );
  expect(fetchStatePublisherDocument).not.toHaveBeenCalled();
});
test.each([
  'PUBLISHER_RETRY_AFTER',
  'PUBLISHER_COOLDOWN_ACTIVE',
  'PUBLISHER_COOLDOWN_STATE_FAILED',
])('refuses API fallback during %s and retains publisher diagnostics', async (code) => {
  const prisma = database();
  (fetchStatePublisherDocument as jest.Mock).mockRejectedValue(
    new PublisherDocumentError(
      code,
      120000,
      'www.flsenate.gov',
      code === 'PUBLISHER_RETRY_AFTER' ? 429 : undefined,
    ),
  );
  await expect(retrieveStateDocument(prisma, request)).rejects.toMatchObject({
    message: code,
    retryAfterMs: 3 * 3600000,
    publisherHost: 'www.flsenate.gov',
    publisherHttpStatus: code === 'PUBLISHER_RETRY_AFTER' ? 429 : undefined,
  });
  expect(getBillText).not.toHaveBeenCalled();
  expect(getSupportingDocument).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
test('provider capacity hold leaves publisher failure pending without reserving API units', async () => {
  const prisma = database();
  prisma.$queryRawUnsafe.mockResolvedValue([{ cursor: { exhausted: true } }]);
  await expect(
    retrieveStateDocument(prisma, { ...request, apiKey: 'synthetic-document-held' }),
  ).rejects.toMatchObject({
    message: 'EXISTING_PROVIDER_CAPACITY_HOLD',
    publisherFailure: 'DOCUMENT_PROVIDER_HASH_MISMATCH',
  });
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(getBillText).not.toHaveBeenCalled();
  (fetchStatePublisherDocument as jest.Mock).mockResolvedValue(doc);
  expect(
    await retrieveStateDocument(prisma, { ...request, apiKey: 'synthetic-document-held' }),
  ).toMatchObject({ acquisition: 'publisher', apiAttempts: 0 });
});
test('provider fallback charges initial call and all retries, refunds only unused reserved units', async () => {
  const prisma = database();
  (getBillText as jest.Mock).mockImplementation(async (_key, _id, retry) => {
    retry();
    retry();
    return doc;
  });
  expect(await retrieveStateDocument(prisma, request)).toMatchObject({
    apiAttempts: 3,
    acquisition: 'legiscan-api',
  });
  const refund = prisma.$executeRaw.mock.calls.find((call: any[]) =>
    call[0].join('').includes('greatest'),
  );
  expect(refund[1]).toBe(1);
});
test('four failed attempts remain charged; failed requests are not refunded', async () => {
  const prisma = database();
  (getBillText as jest.Mock).mockImplementation(async (_key, _id, retry) => {
    retry();
    retry();
    retry();
    throw Error('network');
  });
  await expect(retrieveStateDocument(prisma, request)).rejects.toThrow(
    'DOCUMENT_PROVIDER_RETRIEVAL_FAILED',
  );
  expect(
    prisma.$executeRaw.mock.calls.some((call: any[]) => call[0].join('').includes('greatest')),
  ).toBe(false);
});
test.each(['bill_id', 'doc_id', 'text_hash', 'text_size', 'mime'])(
  'refuses changed frozen %s from API fallback',
  async (field) => {
    (getBillText as jest.Mock).mockResolvedValue({ ...doc, [field]: 'changed' });
    await expect(retrieveStateDocument(database(), request)).rejects.toThrow(
      'DOCUMENT_IDENTITY_OR_SOURCE_HASH_CHANGED',
    );
  },
);
test('amendment fallback retains kind/id and uses supporting-document API', async () => {
  (getSupportingDocument as jest.Mock).mockResolvedValue({ ...doc, document_kind: 'amendment' });
  await retrieveStateDocument(database(), {
    ...request,
    stub: { ...request.stub, kind: 'amendment' },
  });
  expect(getSupportingDocument).toHaveBeenCalledWith(
    'synthetic',
    'amendment',
    20,
    expect.any(Function),
  );
  expect(getBillText).not.toHaveBeenCalled();
});
