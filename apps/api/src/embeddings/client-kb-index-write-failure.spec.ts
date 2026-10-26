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
 * metadata), and a half-written index must not stay searchable: the visible
 * state has to say the index is not current.
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
  // Every lock re-read returns the same current row unless a test says otherwise.
  const lock = jest.fn().mockResolvedValue([attachment]);
  const service = Object.create(ClientKbService.prototype) as ClientKbService;
  Object.assign(service, {
    config: { get: jest.fn().mockReturnValue(false) },
    prisma: {
      withTenant: jest.fn(async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          engagementAttachment: { findFirst: jest.fn().mockResolvedValue(attachment), update },
          $queryRawUnsafe: lock,
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
  return { service, attachment, updates, update, purge, lock };
}

describe('client document indexing write failure', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records a truthful failed state and removes partial chunks when the index write fails', async () => {
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
    // The previous run's success is not left advertised.
    expect(f.update).toHaveBeenLastCalledWith({
      where: { id: 'document-1' },
      data: expect.objectContaining({
        indexedAt: null,
        extractionStatus: 'failed',
        extractionMetadata: expect.objectContaining({
          indexedChunks: 0,
          reason: 'index_write_failed',
        }),
      }),
    });
    // Two purges: the pre-embed purge and the residue cleanup after the failure.
    expect(f.purge).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a newer source state when the document changed before the failure stamp', async () => {
    const f = fixture();
    // Locks 1-2 (pre-work reset, pre-embed purge) see the current row; the lock
    // taken for the failure stamp sees a source revision that already moved on.
    f.lock
      .mockResolvedValueOnce([f.attachment])
      .mockResolvedValueOnce([f.attachment])
      .mockResolvedValue([{ ...f.attachment, s3Key: 'tenant/rewritten' }]);
    jest.mocked(embedAndUpsert).mockRejectedValue(new Error('bedrock throttled'));

    await expect(f.service.indexAttachment('tenant', 'document-1')).rejects.toThrow(
      'bedrock throttled',
    );

    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]!.data).toEqual({ indexedAt: null });
    expect(f.purge).toHaveBeenCalledTimes(1);
  });
});
