import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { EngagementService } from '../../engagement/engagement.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SaveHearingRecapDto } from './hearing-recap.controller.js';
import { HearingRecapService } from './hearing-recap.service.js';

const ctx = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  clerkUserId: 'user-1',
  userId: '22222222-2222-2222-2222-222222222222',
} as unknown as TenantContext;

function harness(opts: { session?: boolean; existing?: boolean } = {}) {
  const createAttachmentFromBuffer = jest.fn(async (_ctx, input) => ({
    id: '33333333-3333-3333-3333-333333333333',
    fileName: input.fileName,
  }));
  const supersedeAttachment = jest.fn(async () => undefined);
  const tx = {
    client: {
      findFirst: jest.fn(async () => ({ id: 'client-1', name: 'Canonical Client' })),
    },
    engagementAttachment: {
      findFirst: jest.fn(async () =>
        opts.existing
          ? {
              id: '44444444-4444-4444-4444-444444444444',
              fileName: 'Existing.docx',
              createdAt: new Date(),
              indexedAt: null,
            }
          : null,
      ),
    },
    $queryRaw: jest.fn(async () =>
      opts.session === false ? [] : [{ id: 'session-1', title: 'Source hearing' }],
    ),
  };
  const prisma = {
    withTenant: async (_tenantId: string, fn: (scoped: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaService;
  const engagement = {
    createAttachmentFromBuffer,
    supersedeAttachment,
  } as unknown as EngagementService;
  return {
    svc: new HearingRecapService(engagement, prisma),
    tx,
    createAttachmentFromBuffer,
    supersedeAttachment,
  };
}

describe('SaveHearingRecapDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  });

  it('accepts the session contract without trusting a browser-supplied client name', async () => {
    await expect(
      pipe.transform(
        { sessionId: 'session-1', title: 'Hearing recap', markdown: 'Source anchored' },
        { type: 'body', metatype: SaveHearingRecapDto },
      ),
    ).resolves.toBeInstanceOf(SaveHearingRecapDto);
  });

  it('rejects clientName because client identity is server-owned', async () => {
    await expect(
      pipe.transform(
        {
          sessionId: 'session-1',
          title: 'Hearing recap',
          markdown: 'Content',
          clientName: 'Spoofed Client',
        },
        { type: 'body', metatype: SaveHearingRecapDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('HearingRecapService', () => {
  it('renders with the canonical client and writes hearing-session provenance', async () => {
    const h = harness();
    await h.svc.save(ctx, 'client-1', {
      sessionId: 'session-1',
      title: 'Hearing recap',
      markdown: '# Recap',
    });
    expect(h.createAttachmentFromBuffer).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        source: 'hearing_recap',
        sourceEntityType: 'hearing_session',
        sourceEntityId: 'session-1',
      }),
    );
  });

  it('enforces the tenant and private-session creator boundary in SQL', async () => {
    const h = harness();
    await h.svc.save(ctx, 'client-1', {
      sessionId: 'session-1',
      title: 'Hearing recap',
      markdown: '# Recap',
    });
    const call = h.tx.$queryRaw.mock.calls[0];
    expect(call).toBeDefined();
    const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain('FROM intel_live_hearing_session');
    expect(sql).toContain('tenant_id =');
    expect(sql).toContain("source_type::text IN ('hearing', 'markup')");
    expect(sql).toContain('created_by =');
    expect(values).toEqual(['session-1', ctx.tenantId, ctx.clerkUserId]);
  });

  it('is idempotent when a current recap already exists', async () => {
    const h = harness({ existing: true });
    const result = await h.svc.save(ctx, 'client-1', {
      sessionId: 'session-1',
      title: 'Hearing recap',
      markdown: '# Recap',
    });
    expect(result.reused).toBe(true);
    expect(h.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });

  it('supersedes the current recap only when the caller names that exact document', async () => {
    const h = harness({ existing: true });
    await h.svc.save(ctx, 'client-1', {
      sessionId: 'session-1',
      title: 'Updated hearing recap',
      markdown: '# Updated recap',
      replaceAttachmentId: '44444444-4444-4444-4444-444444444444',
    });
    expect(h.supersedeAttachment).toHaveBeenCalledWith(
      ctx,
      '44444444-4444-4444-4444-444444444444',
      '33333333-3333-3333-3333-333333333333',
    );
  });

  it('rejects an inaccessible session before writing a document', async () => {
    const h = harness({ session: false });
    await expect(
      h.svc.save(ctx, 'client-1', {
        sessionId: 'foreign-session',
        title: 'Hearing recap',
        markdown: 'Content',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
});
