import { BadRequestException } from '@nestjs/common';
import { MeriApprovalService } from './meri-approval.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContext } from '@capiro/shared';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const FP = 'a'.repeat(64); // valid 64-char sha256 hex

function makePrisma(model: { findUnique?: jest.Mock; upsert?: jest.Mock; findMany?: jest.Mock }) {
  const tx = { meriActionApproval: model };
  const withTenant = jest.fn((_t: string, fn: (tx: unknown) => unknown) => fn(tx));
  return { prisma: { withTenant } as unknown as PrismaService, withTenant };
}

describe('MeriApprovalService', () => {
  describe('fingerprint validation', () => {
    it('rejects a non-sha256 fingerprint on check and approve', async () => {
      const { prisma } = makePrisma({});
      const svc = new MeriApprovalService(prisma);
      await expect(svc.check(ctx, 'not-a-hash')).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.check(ctx, 'A'.repeat(64))).rejects.toBeInstanceOf(BadRequestException); // uppercase
      await expect(
        svc.approve(ctx, { fingerprint: 'short', tool: 'send_email' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('check', () => {
    it('is tenant-scoped and returns approved only for an approved row', async () => {
      const findUnique = jest.fn().mockResolvedValue({ status: 'approved' });
      const { prisma, withTenant } = makePrisma({ findUnique });
      const svc = new MeriApprovalService(prisma);

      expect(await svc.check(ctx, FP)).toEqual({ approved: true });
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      expect(findUnique).toHaveBeenCalledWith({
        where: {
          tenantId_userId_fingerprint: { tenantId: 'tenant-1', userId: 'user-1', fingerprint: FP },
        },
        select: { status: true },
      });
    });

    it('returns approved:false when no row exists', async () => {
      const { prisma } = makePrisma({ findUnique: jest.fn().mockResolvedValue(null) });
      expect(await new MeriApprovalService(prisma).check(ctx, FP)).toEqual({ approved: false });
    });

    it('returns approved:false for a non-approved status', async () => {
      const { prisma } = makePrisma({
        findUnique: jest.fn().mockResolvedValue({ status: 'revoked' }),
      });
      expect(await new MeriApprovalService(prisma).check(ctx, FP)).toEqual({ approved: false });
    });
  });

  describe('approve', () => {
    it('upserts an approved row scoped to the caller (self-approve records approvedBy)', async () => {
      const upsert = jest.fn().mockResolvedValue({ id: 'x' });
      const { prisma, withTenant } = makePrisma({ upsert });
      const svc = new MeriApprovalService(prisma);

      const res = await svc.approve(ctx, { fingerprint: FP, tool: 'send_email' });
      expect(res).toEqual({ approved: true, fingerprint: FP });
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      const arg = upsert.mock.calls[0]?.[0];
      expect(arg.create).toMatchObject({
        tenantId: 'tenant-1',
        userId: 'user-1',
        fingerprint: FP,
        tool: 'send_email',
        status: 'approved',
        approvedBy: 'user-1',
      });
    });
  });
});
