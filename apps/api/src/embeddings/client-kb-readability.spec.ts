import { ClientKbService } from './client-kb.service.js';
import { embedAndUpsert } from './embedder.js';

jest.mock('./embedder.js', () => ({
  embedAndUpsert: jest.fn().mockResolvedValue(undefined),
  normalize: (value: string) => value,
}));

function fixture() {
  const update = jest.fn().mockResolvedValue({});
  const findFirst = jest.fn().mockResolvedValue({
    id: 'document-1',
    clientId: 'client-1',
    fileName: 'Scanned.pdf',
    contentType: 'application/pdf',
    meetingId: null,
    s3Key: 'tenant/doc',
  });
  const extractAttachmentTextForKb = jest.fn();
  const purge = jest.fn().mockResolvedValue(undefined);
  const service = Object.create(ClientKbService.prototype) as ClientKbService;
  Object.assign(service, {
    prisma: {
      withTenant: jest.fn(async (_tenant, fn) =>
        fn({ engagementAttachment: { findFirst, update } }),
      ),
    },
    countClientChunks: jest.fn().mockResolvedValue(0),
    clientName: jest.fn().mockResolvedValue('Client'),
    extractAttachmentTextForKb,
    purge,
  });
  return { service, update, extractAttachmentTextForKb, purge };
}

describe('client document indexing readability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not mark filename-only search entries as indexed document text', async () => {
    const f = fixture();
    f.extractAttachmentTextForKb.mockResolvedValue({
      text: '\n \n',
      truncated: false,
      pages: 22,
      pagesRead: 22,
    });
    await f.service.indexAttachment('tenant', 'document-1');
    expect(embedAndUpsert).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenLastCalledWith({
      where: { id: 'document-1' },
      data: {
        indexedAt: null,
        extractionStatus: 'empty',
        extractionMetadata: expect.objectContaining({
          chars: 0,
          contentScope: 'metadata_only',
          indexedChunks: 0,
          needsVisualRead: true,
          pages: 22,
        }),
      },
    });
  });

  it('reports successful text indexing with extraction bounds', async () => {
    const f = fixture();
    f.extractAttachmentTextForKb.mockResolvedValue({
      text: 'Actual page evidence',
      truncated: true,
      pages: 151,
      pagesRead: 150,
    });
    await f.service.indexAttachment('tenant', 'document-1');
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          indexedAt: expect.any(Date),
          extractionStatus: 'truncated',
          extractionMetadata: expect.objectContaining({
            chars: 20,
            contentScope: 'extractable_text_only',
            indexedChunks: 1,
            truncated: true,
            pagesRead: 150,
          }),
        },
      }),
    );
  });

  it('retains prior chunks on a transient extraction failure and clears the success badge', async () => {
    const f = fixture();
    f.extractAttachmentTextForKb.mockRejectedValue(new Error('S3 unavailable'));
    await expect(f.service.indexAttachment('tenant', 'document-1')).rejects.toThrow(
      'S3 unavailable',
    );
    expect(f.purge).not.toHaveBeenCalled();
    expect(embedAndUpsert).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          indexedAt: null,
          extractionStatus: 'failed',
        }),
      }),
    );
  });
});
