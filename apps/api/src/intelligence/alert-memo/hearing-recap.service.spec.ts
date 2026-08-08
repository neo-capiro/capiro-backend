import type { TenantContext } from '@capiro/shared';
import { HearingRecapService } from './hearing-recap.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_clerk_1',
  role: 'standard_user',
} as TenantContext;
const clientId = '00000000-0000-4000-8000-000000000003';
const sessionId = 'session-1';

function prismaFor(existing: { id: string; fileName: string } | null = null) {
  const tx = {
    client: {
      findFirst: jest.fn().mockResolvedValue({ id: clientId, name: 'Client' }),
    },
    engagementAttachment: {
      findFirst: jest.fn().mockResolvedValue(
        existing
          ? {
              ...existing,
              createdAt: new Date('2026-08-01T00:00:00.000Z'),
              indexedAt: null,
            }
          : null,
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: sessionId, title: 'Hearing' }]),
  };
  return {
    tx,
    prisma: {
      withTenant: jest.fn(
        async (
          _tenantId: string,
          run: (transaction: typeof tx) => Promise<unknown>,
        ) => run(tx),
      ),
    },
  };
}

describe('HearingRecapService document boundary', () => {
  it('reuses the current recap without creating another document', async () => {
    const { prisma } = prismaFor({ id: 'attachment-1', fileName: 'Existing.docx' });
    const documents = {
      createAttachmentFromBuffer: jest.fn(),
      supersedeAttachment: jest.fn(),
    };
    const service = new HearingRecapService(documents as never, prisma as never);

    await expect(
      service.save(ctx, clientId, {
        sessionId,
        title: 'Existing recap',
        markdown: '# Existing',
      }),
    ).resolves.toMatchObject({
      reused: true,
      document: { attachmentId: 'attachment-1', fileName: 'Existing.docx' },
    });
    expect(documents.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });

  it('writes source-bound provenance and supersedes only the named current recap', async () => {
    const { prisma } = prismaFor({ id: 'attachment-old', fileName: 'Old.docx' });
    const documents = {
      createAttachmentFromBuffer: jest.fn().mockResolvedValue({
        id: 'attachment-new',
        fileName: 'Updated recap.docx',
      }),
      supersedeAttachment: jest.fn().mockResolvedValue({ ok: true }),
    };
    const service = new HearingRecapService(documents as never, prisma as never);

    const result = await service.save(ctx, clientId, {
      sessionId,
      title: 'Updated recap',
      markdown: '# Updated recap\n\nGrounded summary.',
      replaceAttachmentId: 'attachment-old',
    });

    expect(documents.createAttachmentFromBuffer).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId,
        source: 'hearing_recap',
        sourceEntityType: 'hearing_session',
        sourceEntityId: sessionId,
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: expect.any(Buffer),
      }),
    );
    expect(documents.supersedeAttachment).toHaveBeenCalledWith(
      ctx,
      'attachment-old',
      'attachment-new',
    );
    expect(result).toMatchObject({
      reused: false,
      document: { attachmentId: 'attachment-new' },
    });
  });
});
