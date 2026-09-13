import { assertHearingRecordDocumentAccess } from './hearing-record-document-access.js';
const ctx = { tenantId: 'tenant', userId: 'user', clerkUserId: 'owner' } as never;
const attachment = {
  id: 'attachment',
  sourceEntityType: 'hearing_record_brief',
  sourceEntityId: 'brief',
  clientId: 'client',
};
describe('saved record brief access boundary', () => {
  const secret = process.env.INTERNAL_SERVICE_SECRET,
    originalFetch = globalThis.fetch;
  const row = {
    eventId: 'event',
    briefId: 'brief',
    clientId: 'client',
    contentHash: 'content',
    sourceHash: 'source',
  };
  const query = jest.fn(),
    execute = jest.fn();
  const prisma = {
    withTenant: async (_: unknown, fn: (tx: unknown) => unknown) =>
      fn({ $executeRaw: execute, $queryRaw: query }),
  } as never;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'test';
    query.mockReset().mockResolvedValue([row]);
    execute.mockClear();
    globalThis.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            kind: 'capiro_record_document_access',
            tenantId: 'tenant',
            id: 'brief',
            ...row,
          }),
          { status: 200 },
        ),
    );
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (secret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = secret;
  });
  it('keeps ordinary attachment reads on their existing boundary', async () => {
    await assertHearingRecordDocumentAccess(prisma, ctx, { ...attachment, sourceEntityType: null });
    expect(query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks exact immutable provenance and asks the owner service for current access', async () => {
    await assertHearingRecordDocumentAccess(prisma, ctx, attachment);
    expect(JSON.parse((fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({
      view: 'document-access',
      actor: 'owner',
      contentHash: 'content',
      purpose: 'read',
    });
    await assertHearingRecordDocumentAccess(prisma, ctx, attachment, 'distribute');
    expect(JSON.parse((fetch as jest.Mock).mock.calls[1][1].body).purpose).toBe('distribute');
  });
  it('denies missing owner provenance or a swapped client before fetching', async () => {
    query.mockResolvedValue([]);
    await expect(assertHearingRecordDocumentAccess(prisma, ctx, attachment)).rejects.toThrow(
      'ACCESS_OR_VERSION_CHANGED',
    );
    query.mockResolvedValue([row]);
    await expect(
      assertHearingRecordDocumentAccess(prisma, ctx, { ...attachment, clientId: 'other' }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed after permission withdrawal, a changed version or service outage', async () => {
    for (const response of [
      new Response('{}', { status: 403 }),
      new Response('{}', { status: 200 }),
    ]) {
      (fetch as jest.Mock).mockResolvedValue(response);
      await expect(assertHearingRecordDocumentAccess(prisma, ctx, attachment)).rejects.toThrow(
        'ACCESS_OR_VERSION_CHANGED',
      );
    }
    (fetch as jest.Mock).mockRejectedValue(Error('unavailable'));
    await expect(assertHearingRecordDocumentAccess(prisma, ctx, attachment)).rejects.toThrow(
      'ACCESS_OR_VERSION_CHANGED',
    );
  });
});
