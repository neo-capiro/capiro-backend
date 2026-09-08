import { extractCitationsFromToolResult } from '@capiro/shared';
import { MeriConversationEvidenceService } from './meri-conversation-evidence.service.js';
import { buildDocumentReadPage, parseDocumentReadInput } from './meri-document-read.helpers.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: class {} }));
jest.mock('../memory/memory-wall.helpers.js', () => ({
  clientMemoryAllowed: jest.fn(async () => true),
}));
const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;
const text = 'Meri supports meeting preparation. '.repeat(20);
const extracted = {
  attachmentId: 'doc-1',
  fileName: 'Capiro 2.0.pdf',
  contentType: 'application/pdf',
  contentHash: 'a'.repeat(64),
  source: 'pdf',
  text,
  section: 22,
  sectionKind: 'page',
  sectionCount: 22,
  sectionLabel: 'Page 22',
  disclosure: 'Visual extraction can omit layout.',
  readability: { method: 'openai_pdf', status: 'readable', limitations: ['Page only'] },
};
function page() {
  return buildDocumentReadPage(
    'client-1',
    parseDocumentReadInput({ documentId: 'doc-1', section: 22 }, 'client-1'),
    extracted as never,
  );
}
function fixture() {
  const citation = extractCitationsFromToolResult('read_client_documents', page(), 56, 1)[0]!;
  // Persisted metadata, then a distinct reload; references are not shared.
  const metadata = JSON.parse(JSON.stringify({ citations: [citation] }));
  const tx = {
    clioConversation: { findFirst: jest.fn(async () => ({ id: 'thread-1' })) },
    clioMessage: { findMany: jest.fn(async () => [{ role: 'assistant', metadata }]) },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, cb: (db: typeof tx) => unknown) =>
      cb(tx),
    ),
  };
  const engagement = {
    extractAttachmentText: jest.fn(async (_ctx: unknown, _id: string, options: any) =>
      options.contextSourceOnly ? { ...extracted, text: '' } : extracted,
    ),
  };
  return {
    service: new MeriConversationEvidenceService(prisma as never, engagement as never),
    citation,
    metadata,
    tx,
    engagement,
    prisma,
  };
}

beforeEach(() => jest.mocked(clientMemoryAllowed).mockResolvedValue(true));

describe('reauthorized document evidence across saved turns', () => {
  it('keeps the exact page, excerpt, limitations and [56] after persistence without invoking extraction again', async () => {
    const { service, citation, engagement, tx } = fixture();
    const first = await service.load(ctx, 'thread-1', 'client-1');
    const reloaded = await service.load(ctx, 'thread-1', 'client-1');
    expect(first).toEqual({ citations: [citation], unavailable: 0, omitted: 0 });
    expect(reloaded).toEqual(first);
    expect(first.citations[0]?.documentEvidence).toMatchObject({
      record: { payload: { text, section: 22, sectionLabel: 'Page 22' } },
      coverage: {
        disclosure: 'Visual extraction can omit layout.',
        readability: { method: 'openai_pdf' },
        complete: false,
      },
    });
    expect(engagement.extractAttachmentText).toHaveBeenCalledTimes(2);
    expect(engagement.extractAttachmentText).toHaveBeenLastCalledWith(
      ctx,
      'doc-1',
      expect.objectContaining({ clientId: 'client-1', contextSourceOnly: true }),
    );
    expect(tx.clioConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
          clientId: 'client-1',
          archivedAt: null,
        }),
      }),
    );
  });

  it('preserves an older saved snippet and exact page reference without starting visual extraction', async () => {
    const { service, metadata, engagement } = fixture();
    delete metadata.citations[0].documentEvidence;
    const result = await service.load(ctx, 'thread-1', 'client-1');
    expect(result.citations[0]).toMatchObject({
      n: 56,
      documentEvidence: {
        record: { payload: { section: 22, text: metadata.citations[0].snippet } },
        coverage: {
          fullExcerptAvailable: false,
          legacySnippetOnly: true,
          extractionMetadata: null,
        },
      },
    });
    expect(result.citations[0]?.documentEvidence?.coverage.note).toContain('section=22');
    expect(engagement.extractAttachmentText).toHaveBeenCalledTimes(1);
    expect(engagement.extractAttachmentText.mock.calls[0]?.[2]).toMatchObject({
      contextSourceOnly: true,
      clientId: 'client-1',
    });
  });

  it.each(['revoked', 'changed', 'wall', 'conversation'])(
    'does not admit %s source evidence',
    async (reason) => {
      const { service, engagement, tx } = fixture();
      if (reason === 'revoked')
        engagement.extractAttachmentText.mockRejectedValue(new Error('Attachment not found'));
      if (reason === 'changed')
        engagement.extractAttachmentText.mockResolvedValue({
          ...extracted,
          contentHash: 'b'.repeat(64),
        });
      if (reason === 'wall') jest.mocked(clientMemoryAllowed).mockResolvedValue(false);
      if (reason === 'conversation') tx.clioConversation.findFirst.mockResolvedValue(null as never);
      expect((await service.load(ctx, 'thread-1', 'client-1')).citations).toEqual([]);
      if (reason === 'wall' || reason === 'conversation')
        expect(engagement.extractAttachmentText).not.toHaveBeenCalled();
    },
  );

  it('never restores institutional memory or assistant claims as document evidence', async () => {
    const { service, metadata, engagement } = fixture();
    metadata.citations[0].tool = 'search_memory';
    expect((await service.load(ctx, 'thread-1', 'client-1')).citations).toEqual([]);
    expect(engagement.extractAttachmentText).not.toHaveBeenCalled();
  });

  it('research replay reauthorizes the captured observations rather than silently adding later conversation evidence', async () => {
    const { service, metadata, tx } = fixture();
    const snapshot = [{ role: 'assistant', metadata: JSON.parse(JSON.stringify(metadata)) }];
    const result = await service.load(ctx, 'thread-1', 'client-1', undefined, snapshot);
    expect(result.citations[0]?.n).toBe(56);
    expect(tx.clioMessage.findMany).not.toHaveBeenCalled();
  });

  it('propagates cancellation without treating it as unavailable evidence', async () => {
    const { service, engagement } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(service.load(ctx, 'thread-1', 'client-1', controller.signal)).rejects.toThrow();
    expect(engagement.extractAttachmentText).not.toHaveBeenCalled();
  });
});
