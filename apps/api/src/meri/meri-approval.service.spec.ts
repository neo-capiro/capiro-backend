import { BadRequestException } from '@nestjs/common';
import { MeriApprovalService } from './meri-approval.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MeriToolsService } from './meri-tools.service.js';
import type { TenantContext } from '@capiro/shared';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const FP = 'a'.repeat(64); // valid 64-char sha256 hex

function makePrisma(models: {
  meriActionApproval?: { findUnique?: jest.Mock; upsert?: jest.Mock; findMany?: jest.Mock };
  meriPendingAction?: {
    findUnique?: jest.Mock;
    upsert?: jest.Mock;
    updateMany?: jest.Mock;
  };
}) {
  const tx = {
    meriActionApproval: models.meriActionApproval ?? {},
    meriPendingAction: models.meriPendingAction ?? {},
  };
  const withTenant = jest.fn((_t: string, fn: (tx: unknown) => unknown) => fn(tx));
  return { prisma: { withTenant } as unknown as PrismaService, withTenant };
}

function makeTools(executeFromAuthenticatedUser?: jest.Mock) {
  return {
    executeFromAuthenticatedUser: executeFromAuthenticatedUser ?? jest.fn(),
  } as unknown as MeriToolsService;
}

describe('MeriApprovalService', () => {
  describe('fingerprint validation', () => {
    it('rejects a non-sha256 fingerprint on check, recordPending, and approve', async () => {
      const { prisma } = makePrisma({});
      const svc = new MeriApprovalService(prisma, makeTools());
      await expect(svc.check(ctx, 'not-a-hash')).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.check(ctx, 'A'.repeat(64))).rejects.toBeInstanceOf(BadRequestException); // uppercase
      await expect(
        svc.recordPending(ctx, { fingerprint: 'short', tool: 'send_email', input: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.approve(ctx, { fingerprint: 'short', tool: 'send_email' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('check', () => {
    it('is tenant-scoped and returns approved only for an approved row', async () => {
      const findUnique = jest.fn().mockResolvedValue({ status: 'approved' });
      const { prisma, withTenant } = makePrisma({ meriActionApproval: { findUnique } });
      const svc = new MeriApprovalService(prisma, makeTools());

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
      const { prisma } = makePrisma({
        meriActionApproval: { findUnique: jest.fn().mockResolvedValue(null) },
      });
      expect(await new MeriApprovalService(prisma, makeTools()).check(ctx, FP)).toEqual({
        approved: false,
      });
    });

    it('returns approved:false for a non-approved status', async () => {
      const { prisma } = makePrisma({
        meriActionApproval: { findUnique: jest.fn().mockResolvedValue({ status: 'revoked' }) },
      });
      expect(await new MeriApprovalService(prisma, makeTools()).check(ctx, FP)).toEqual({
        approved: false,
      });
    });
  });

  describe('recordPending', () => {
    it('upserts the exact tool+input under the fingerprint', async () => {
      const findUnique = jest.fn().mockResolvedValue(null);
      const upsert = jest.fn().mockResolvedValue({ id: 'x' });
      const { prisma, withTenant } = makePrisma({
        meriPendingAction: { findUnique, upsert },
      });
      const svc = new MeriApprovalService(prisma, makeTools());

      const res = await svc.recordPending(ctx, {
        fingerprint: FP,
        tool: 'update_client_profile',
        input: { clientId: 'c1', description: 'x' },
      });
      expect(res).toEqual({ recorded: true });
      expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
      const arg = upsert.mock.calls[0]?.[0];
      expect(arg.create).toMatchObject({
        tenantId: 'tenant-1',
        userId: 'user-1',
        fingerprint: FP,
        tool: 'update_client_profile',
        input: { clientId: 'c1', description: 'x' },
      });
    });

    it('never overwrites a row that has already been consumed', async () => {
      const findUnique = jest.fn().mockResolvedValue({ consumedAt: new Date() });
      const upsert = jest.fn();
      const { prisma } = makePrisma({ meriPendingAction: { findUnique, upsert } });
      const svc = new MeriApprovalService(prisma, makeTools());

      const res = await svc.recordPending(ctx, {
        fingerprint: FP,
        tool: 'update_client_profile',
        input: { clientId: 'c1' },
      });
      expect(res).toEqual({ recorded: false });
      expect(upsert).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('upserts an approved row scoped to the caller (self-approve records approvedBy)', async () => {
      const upsert = jest.fn().mockResolvedValue({ id: 'x' });
      const updateMany = jest.fn().mockResolvedValue({ count: 0 }); // no pending action cached
      const { prisma, withTenant } = makePrisma({
        meriActionApproval: { upsert },
        meriPendingAction: { updateMany },
      });
      const svc = new MeriApprovalService(prisma, makeTools());

      const res = await svc.approve(ctx, { fingerprint: FP, tool: 'send_email' });
      expect(res).toEqual({ approved: true, fingerprint: FP, executed: false });
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

    it('B4.1: replays the cached input directly when a pending action exists — no model round-trip', async () => {
      const upsert = jest.fn().mockResolvedValue({ id: 'x' });
      const updateMany = jest.fn().mockResolvedValue({ count: 1 }); // claimed it
      const findUnique = jest
        .fn()
        .mockResolvedValue({
          tool: 'update_client_profile',
          input: { clientId: 'c1', name: 'Acme' },
        });
      const executeFromAuthenticatedUser = jest.fn().mockResolvedValue({ ok: true });
      const { prisma } = makePrisma({
        meriActionApproval: { upsert },
        meriPendingAction: { updateMany, findUnique },
      });
      const svc = new MeriApprovalService(prisma, makeTools(executeFromAuthenticatedUser));

      const res = await svc.approve(ctx, { fingerprint: FP, tool: 'update_client_profile' });
      expect(res).toEqual({
        approved: true,
        fingerprint: FP,
        executed: true,
        result: { ok: true },
      });
      // The EXACT cached input is replayed verbatim — never re-derived.
      expect(executeFromAuthenticatedUser).toHaveBeenCalledWith(ctx, 'update_client_profile', {
        clientId: 'c1',
        name: 'Acme',
      });
      // Claimed atomically (consumedAt: null → now), never a second time.
      expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
        where: { tenantId: 'tenant-1', userId: 'user-1', fingerprint: FP, consumedAt: null },
      });
    });

    it('loses the claim race (double-click / two tabs) and reports executed:false instead of double-running', async () => {
      const upsert = jest.fn().mockResolvedValue({ id: 'x' });
      const updateMany = jest.fn().mockResolvedValue({ count: 0 }); // someone else already claimed it
      const executeFromAuthenticatedUser = jest.fn();
      const { prisma } = makePrisma({
        meriActionApproval: { upsert },
        meriPendingAction: { updateMany },
      });
      const svc = new MeriApprovalService(prisma, makeTools(executeFromAuthenticatedUser));

      const res = await svc.approve(ctx, { fingerprint: FP, tool: 'update_client_profile' });
      expect(res).toEqual({ approved: true, fingerprint: FP, executed: false });
      expect(executeFromAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('surfaces a genuine execution failure (e.g. a stale/bad clientId) as executionError, not a silent success', async () => {
      const upsert = jest.fn().mockResolvedValue({ id: 'x' });
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const findUnique = jest
        .fn()
        .mockResolvedValue({ tool: 'update_client_profile', input: { clientId: 'ghost' } });
      const executeFromAuthenticatedUser = jest
        .fn()
        .mockRejectedValue(new Error('Client not found'));
      const { prisma } = makePrisma({
        meriActionApproval: { upsert },
        meriPendingAction: { updateMany, findUnique },
      });
      const svc = new MeriApprovalService(prisma, makeTools(executeFromAuthenticatedUser));

      const res = await svc.approve(ctx, { fingerprint: FP, tool: 'update_client_profile' });
      expect(res).toEqual({
        approved: true,
        fingerprint: FP,
        executed: false,
        executionError: 'Client not found',
      });
    });
  });
});
