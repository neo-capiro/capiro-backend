import { BadRequestException, GoneException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MeriApprovalService } from './meri-approval.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const FP = 'a'.repeat(64);

function makePrisma() {
  const findMany = jest.fn().mockResolvedValue([]);
  const withTenant = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ meriActionApproval: { findMany } }),
  );
  return {
    prisma: { withTenant } as unknown as PrismaService,
    withTenant,
    findMany,
  };
}

describe('MeriApprovalService legacy containment', () => {
  it('rejects malformed fingerprints on the compatibility check', async () => {
    const { prisma } = makePrisma();
    const service = new MeriApprovalService(prisma);
    await expect(service.check(ctx, 'not-a-hash')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('never treats a historical fingerprint row as executable approval', async () => {
    const { prisma, withTenant } = makePrisma();
    const service = new MeriApprovalService(prisma);
    await expect(service.check(ctx, FP)).resolves.toEqual({ approved: false });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('returns 410 for browser-controlled pending action creation', async () => {
    const { prisma } = makePrisma();
    const service = new MeriApprovalService(prisma);
    await expect(
      service.recordPending(ctx, {
        fingerprint: FP,
        tool: 'send_email',
        input: { to: 'victim@example.com', body: 'browser supplied' },
      }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('returns 410 for fingerprint-only approval and never invokes a tool', async () => {
    const { prisma } = makePrisma();
    const service = new MeriApprovalService(prisma);
    await expect(service.approve(ctx, { fingerprint: FP, tool: 'send_email' })).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('keeps historical rows tenant/user scoped and read-only for audit', async () => {
    const { prisma, withTenant, findMany } = makePrisma();
    const service = new MeriApprovalService(prisma);
    await service.list(ctx, 500);
    expect(withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, fingerprint: true, tool: true, status: true, createdAt: true },
    });
  });
});
