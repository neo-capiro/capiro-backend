import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MeriService } from './meri.service.js';
import type { TenantContext } from '@capiro/shared';

/**
 * Regression coverage for the ChatDrawer "Things Meri learned" panel's
 * forget/edit path (DELETE/PATCH /api/clio/memory/:id → MeriService.forget-
 * Memory/updateMemory). This path used to have NO legal-hold check at all and
 * wrote NO audit_logs entry, unlike the chat-tool forget_memory/correct_memory
 * verbs (memory-store.service.ts) which refuse under legal hold and tombstone
 * every change. Both methods now match that governance parity.
 */
const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'acme',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'standard_user',
};

function buildService(opts: { clioMemoryRow: Record<string, unknown> | null; legalHold: boolean }) {
  const tx = {
    clioMemory: {
      findFirst: jest.fn().mockResolvedValue(opts.clioMemoryRow),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([{ legal_hold: opts.legalHold }]),
  };
  const prisma = {
    withTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(tx)),
    withTenantUser: jest.fn((_tenantId: string, _userId: string, fn: (tx: unknown) => unknown) =>
      fn(tx),
    ),
  };
  const memoryIngest = {
    removeClioMemory: jest.fn().mockResolvedValue(undefined),
    projectClioMemory: jest.fn().mockResolvedValue(undefined),
  };
  const service = new MeriService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    memoryIngest as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, tx, prisma, memoryIngest };
}

describe('MeriService.forgetMemory — legal hold + audit tombstone', () => {
  const row = { id: 'm1', scope: 'firm', ownerUserId: null, key: 'k', value: 'v' };

  it('refuses when the projected memory_items row is under legal hold', async () => {
    const { service, tx, memoryIngest } = buildService({ clioMemoryRow: row, legalHold: true });
    await expect(service.forgetMemory(ctx, 'm1')).rejects.toThrow(ForbiddenException);
    expect(tx.clioMemory.deleteMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(memoryIngest.removeClioMemory).not.toHaveBeenCalled();
  });

  it('deletes + writes an audit_logs tombstone when not held', async () => {
    const { service, tx, memoryIngest } = buildService({ clioMemoryRow: row, legalHold: false });
    const out = await service.forgetMemory(ctx, 'm1');
    expect(out).toEqual({ ok: true, id: 'm1' });
    expect(tx.clioMemory.deleteMany).toHaveBeenCalledWith({
      where: { id: 'm1', tenantId: 't1' },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 't1',
        actorUserId: 'u1',
        action: 'memory.forget',
        entityType: 'clio_memory',
        entityId: 'm1',
        before: { key: 'k', value: 'v', scope: 'firm' },
      }),
    });
    expect(memoryIngest.removeClioMemory).toHaveBeenCalledWith('t1', 'm1');
  });

  it('404s when the row does not exist (no legal-hold/audit calls at all)', async () => {
    const { service, tx } = buildService({ clioMemoryRow: null, legalHold: false });
    await expect(service.forgetMemory(ctx, 'missing')).rejects.toThrow(NotFoundException);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.clioMemory.deleteMany).not.toHaveBeenCalled();
  });

  it("404s on another user's private memory (never leaks existence via a different error)", async () => {
    const { service } = buildService({
      clioMemoryRow: {
        id: 'm1',
        scope: 'user_private',
        ownerUserId: 'someone-else',
        key: 'k',
        value: 'v',
      },
      legalHold: false,
    });
    await expect(service.forgetMemory(ctx, 'm1')).rejects.toThrow(NotFoundException);
  });
});

describe('MeriService.updateMemory — legal hold + audit trail', () => {
  const row = { id: 'm1', scope: 'firm', ownerUserId: null, key: 'k', value: 'old', metadata: {} };

  it('refuses an edit when the projected memory_items row is under legal hold', async () => {
    const { service, tx, memoryIngest } = buildService({ clioMemoryRow: row, legalHold: true });
    await expect(service.updateMemory(ctx, 'm1', 'new value')).rejects.toThrow(ForbiddenException);
    expect(tx.clioMemory.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(memoryIngest.projectClioMemory).not.toHaveBeenCalled();
  });

  it('updates + writes a before/after audit entry when not held', async () => {
    const { service, tx, memoryIngest } = buildService({ clioMemoryRow: row, legalHold: false });
    const out = await service.updateMemory(ctx, 'm1', 'new value');
    expect(out).toEqual({ ok: true, id: 'm1', value: 'new value' });
    expect(tx.clioMemory.updateMany).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'memory.edit',
        entityType: 'clio_memory',
        entityId: 'm1',
        before: { key: 'k', value: 'old' },
        after: { key: 'k', value: 'new value' },
      }),
    });
    expect(memoryIngest.projectClioMemory).toHaveBeenCalledWith('t1', 'm1');
  });

  it('rejects an empty/whitespace-only value before ever checking legal hold', async () => {
    const { service, tx } = buildService({ clioMemoryRow: row, legalHold: false });
    await expect(service.updateMemory(ctx, 'm1', '   ')).rejects.toThrow(
      'Memory value must be a non-empty string',
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
