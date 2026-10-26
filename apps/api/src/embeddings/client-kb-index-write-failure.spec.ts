import { ClientKbService } from './client-kb.service.js';
import { embedAndUpsert } from './embedder.js';

jest.mock('./embedder.js', () => ({
  embedAndUpsert: jest.fn(),
  normalize: (value: string) => value,
}));

/**
 * MG-06 truthfulness: a failed index WRITE.
 *
 * indexAttachment purges the document's chunks BEFORE it re-embeds them, so a
 * provider/DB failure inside the chunk loop leaves this run's partial chunks as
 * the only searchable residue. At that point the row must not keep advertising
 * the previous run's completed extraction (extraction_status/extraction
 * metadata), a half-written index must not stay searchable, and the attempt must
 * not hold the row's claim hostage while it retries. Attempt identity itself
 * (two overlapping attempts) is covered by client-kb-index-claim.spec.ts.
 */
function fixture() {
  const attachment = {
    id: 'document-1',
    clientId: 'client-1',
    fileName: 'Evidence.pdf',
    contentType: 'application/pdf',
    meetingId: null,
    s3Key: 'tenant/doc',
    viewerMode: 'all',
    lifecycleStatus: 'ready',
    scanStatus: 'clean',
    supersededByAttachmentId: null,
  };
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const update = jest.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
    updates.push(args);
    return {};
  });
  const purge = jest.fn().mockResolvedValue(1);
  // MG-06 attempt claim. `drift` lets a test move the source revision the lock
  // re-reads; the claim CAS and the row lock both read this state.
  const state = { token: null as string | null, generation: 0, drift: null as string | null };
  const query = jest.fn(async (sql: string, ...params: unknown[]) => {
    if (sql.includes('SET index_claim_token')) {
      state.token = String(params[1]);
      return [{ token: state.token, generation: state.generation }];
    }
    return [
      {
        ...attachment,
        s3Key: state.drift ?? attachment.s3Key,
        indexClaimToken: state.token,
        indexSourceGeneration: state.generation,
      },
    ];
  });
  const service = Object.create(ClientKbService.prototype) as ClientKbService;
  Object.assign(service, {
    config: { get: jest.fn().mockReturnValue(false) },
    prisma: {
      withTenant: jest.fn(async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          engagementAttachment: {
            findFirst: jest.fn(async () => ({
              ...attachment,
              indexClaimToken: state.token,
              indexSourceGeneration: state.generation,
            })),
            update,
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          $queryRawUnsafe: query,
          $executeRawUnsafe: purge,
        }),
      ),
    },
    countClientChunks: jest.fn().mockResolvedValue(0),
    clientName: jest.fn().mockResolvedValue('Client'),
    // Long enough for several chunks, so the provider fails after the first
    // chunk has already been written.
    extractAttachmentTextForKb: jest
      .fn()
      .mockResolvedValue({ text: 'Evidence word '.repeat(1200), truncated: false }),
  });
  return { service, attachment, state, updates, update, purge, query };
}

describe('client document indexing write failure', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records a truthful failed state, removes partial chunks and releases the claim', async () => {
    const f = fixture();
    jest
      .mocked(embedAndUpsert)
      .mockResolvedValueOnce('inserted')
      .mockRejectedValueOnce(new Error('bedrock throttled'));

    await expect(f.service.indexAttachment('tenant', 'document-1')).rejects.toThrow(
      'bedrock throttled',
    );

    // The failure stays visible to the caller (never swallowed).
    expect(jest.mocked(embedAndUpsert).mock.calls.length).toBeGreaterThan(1);
    // The previous run's success is not left advertised, the claim is released,
    // and a bounded retry is scheduled instead of waiting out the lease.
    expect(f.update).toHaveBeenLastCalledWith({
      where: { id: 'document-1' },
      data: expect.objectContaining({
        indexedAt: null,
        extractionStatus: 'failed',
        indexClaimToken: null,
        indexClaimExpiresAt: null,
        indexNextAttemptAt: expect.any(Date),
        extractionMetadata: expect.objectContaining({
          indexedChunks: 0,
          reason: 'index_write_failed',
        }),
      }),
    });
    // Two purges: the pre-embed purge and the residue cleanup after the failure.
    expect(f.purge).toHaveBeenCalledTimes(2);
  });

  it('does not purge or stamp when the source moved before the attempt could start work', async () => {
    const f = fixture();
    // The lock re-reads a row whose s3 object already changed, so this attempt
    // never owns the new revision's evidence.
    f.state.drift = 'tenant/rewritten';
    jest.mocked(embedAndUpsert).mockRejectedValue(new Error('bedrock throttled'));

    const outcome = await f.service.indexAttachment('tenant', 'document-1');

    expect(outcome).toBe('skipped');
    expect(jest.mocked(embedAndUpsert)).not.toHaveBeenCalled();
    expect(f.purge).not.toHaveBeenCalled();
    expect(f.updates).toHaveLength(0);
  });

  it('does not start a second attempt while this document already has a live claim', async () => {
    const f = fixture();
    // A live attempt elsewhere: the compare-and-set returns no row.
    f.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SET index_claim_token')) return [];
      return [{ ...f.attachment, indexClaimToken: 'other-attempt', indexSourceGeneration: 0 }];
    });

    expect(await f.service.indexAttachment('tenant', 'document-1')).toBe('skipped');
    expect(jest.mocked(embedAndUpsert)).not.toHaveBeenCalled();
    expect(f.purge).not.toHaveBeenCalled();
    expect(f.updates).toHaveLength(0);
  });
});
