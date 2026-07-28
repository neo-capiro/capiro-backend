import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { EngagementService } from '../../engagement/engagement.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SaveHearingRecapDto } from './hearing-recap.controller.js';
import { HearingRecapService } from './hearing-recap.service.js';

const ctx = {
  tenantId: 'tenant-1',
  clerkUserId: 'user-1',
  userId: 'db-user-1',
} as unknown as TenantContext;

function makeHarness(sessionExists = true) {
  const createAttachmentFromBuffer = jest.fn(async (_ctx: TenantContext, input: Record<string, unknown>) => ({
    id: 'attachment-1',
    fileName: input.fileName as string,
  }));
  const supersedeAttachment = jest.fn(async () => undefined);
  const engagement = {
    createAttachmentFromBuffer,
    supersedeAttachment,
  } as unknown as EngagementService;
  const sql: string[] = [];
  const params: unknown[][] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      sql.push(strings.join('?'));
      params.push(values);
      return sessionExists ? [{ id: 'session-1' }] : [];
    }),
  };
  const prisma = {
    withTenant: async <T>(_tenantId: string, fn: (inner: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
  return {
    svc: new HearingRecapService(engagement, prisma),
    createAttachmentFromBuffer,
    supersedeAttachment,
    queryRaw: tx.$queryRaw,
    sql,
    params,
  };
}

describe('SaveHearingRecapDto', () => {
  // Exactly the global pipe from apps/api/src/main.ts — the previous web path
  // posted a hearing recap to alert-memo/save, which this configuration rejected
  // outright because that DTO requires an alertId.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  });

  it('accepts a session-shaped recap without an alertId', async () => {
    await expect(
      pipe.transform(
        {
          sessionId: 'session-1',
          title: 'Hearing recap — Armed Services',
          markdown: '# Hearing recap\n\nSource-anchored content.',
          clientName: 'Acme Defense',
        },
        { type: 'body', metatype: SaveHearingRecapDto },
      ),
    ).resolves.toBeInstanceOf(SaveHearingRecapDto);
  });

  it('rejects a missing sessionId instead of accepting an untraceable document', async () => {
    await expect(
      pipe.transform(
        {
          title: 'Hearing recap',
          markdown: 'Content',
          clientName: 'Acme Defense',
        },
        { type: 'body', metatype: SaveHearingRecapDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects alert-governance fields that do not belong to the recap contract', async () => {
    await expect(
      pipe.transform(
        {
          sessionId: 'session-1',
          title: 'Hearing recap',
          markdown: 'Content',
          clientName: 'Acme Defense',
          alertId: 'spoofed-alert',
        },
        { type: 'body', metatype: SaveHearingRecapDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('HearingRecapService', () => {
  it('proves the hearing belongs to the tenant and files a real DOCX', async () => {
    const h = makeHarness(true);

    const result = await h.svc.save(ctx, 'client-1', {
      sessionId: 'session-1',
      title: 'Hearing recap — Armed Services',
      markdown: '# Hearing recap\n\n## Key moments\n\nStatement [segment:seg-1]',
      clientName: 'Acme Defense',
    });

    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(h.createAttachmentFromBuffer).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        source: 'hearing_recap',
        buffer: expect.any(Buffer),
      }),
    );
    expect(result).toMatchObject({
      sessionId: 'session-1',
      document: { attachmentId: 'attachment-1' },
    });
  });

  it('enforces the private-session boundary in the ownership query itself', async () => {
    const h = makeHarness(true);

    await h.svc.save(ctx, 'client-1', {
      sessionId: 'session-1',
      title: 'Hearing recap',
      markdown: 'Content',
      clientName: 'Acme Defense',
    });

    // Public proceedings are firm-visible; a private meeting/webinar/agency
    // session is only filable by its creator, matching intel-api's read boundary.
    // Without the created_by leg, any same-tenant user could export another
    // user's private session into a client document.
    expect(h.sql[0]).toContain('FROM intel_live_hearing_session');
    expect(h.sql[0]).toContain('tenant_id =');
    expect(h.sql[0]).toContain("source_type::text IN ('hearing', 'markup')");
    expect(h.sql[0]).toContain('created_by =');
    expect(h.params[0]).toEqual(['session-1', 'tenant-1', 'user-1']);
  });

  it('refuses to file a recap for a session outside the tenant', async () => {
    const h = makeHarness(false);
    await expect(
      h.svc.save(ctx, 'client-1', {
        sessionId: 'foreign-session',
        title: 'Hearing recap',
        markdown: 'Content',
        clientName: 'Acme Defense',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });

  it('supersedes rather than destructively deleting an earlier recap', async () => {
    const h = makeHarness(true);
    await h.svc.save(ctx, 'client-1', {
      sessionId: 'session-1',
      title: 'Updated hearing recap',
      markdown: 'Updated content',
      clientName: 'Acme Defense',
      replaceAttachmentId: 'attachment-old',
    });
    expect(h.supersedeAttachment).toHaveBeenCalledWith(ctx, 'attachment-old', 'attachment-1');
  });
});
