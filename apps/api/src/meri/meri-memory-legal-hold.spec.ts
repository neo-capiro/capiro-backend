import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MeriService } from './meri.service.js';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';

/**
 * Regression coverage for the ChatDrawer "Things Meri learned" panel's
 * forget/edit path (DELETE/PATCH /api/clio/memory/:id → MeriService.forget-
 * Memory/updateMemory). This path used to have NO legal-hold check at all and
 * wrote NO audit_logs entry, unlike the chat-tool forget_memory/correct_memory
 * verbs (memory-store.service.ts) which refuse under legal hold and tombstone
 * every change. Both methods now match that governance parity.
 *
 * Role is capiro_admin (not standard_user, its original value): forgetMemory/
 * updateMemory now route shared-scope mutation through the Phase 0
 * evaluateMemoryMutation policy, which correctly requires admin for the
 * fixture's scope:'firm' row (memory-mutation-auth.ts, "standard user cannot
 * mutate shared firm/client memory"). On origin/main, forgetMemory used a
 * much simpler owner-only check for user_private rows and no role check at
 * all otherwise, so this fixture's original standard_user role was correct
 * there; a standard_user is now unauthorized before ever reaching the
 * legal-hold branch this file exists to test. Confirmed this policy tightening
 * is a real, intentional change on this branch (not a test bug) by diffing
 * against origin/main's forgetMemory, which has no evaluateMemoryMutation
 * call at all.
 */
const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'acme',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'capiro_admin',
};

function buildService(opts: {
  clioMemoryRow: Record<string, unknown> | null;
  legalHold: boolean;
  projectionId?: string | null;
  wallAllowed?: boolean;
  linked?: Array<{ id: string; slug: string | null; type: string | null }>;
}) {
  const projectionId = opts.projectionId === undefined ? 'projection-1' : opts.projectionId;
  const tx = {
    clioMemory: {
      findFirst: jest.fn().mockResolvedValue(opts.clioMemoryRow),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      if (sql.text.includes('FROM clio_memory') && sql.text.includes('FOR UPDATE')) {
        return opts.clioMemoryRow ? [opts.clioMemoryRow] : [];
      }
      if (sql.text.includes('FROM memory_candidate mc')) return opts.linked ?? [];
      if (sql.text.includes('FROM memory_items')) {
        return projectionId ? [{ id: projectionId, legal_hold: opts.legalHold }] : [];
      }
      return [];
    }),
    $queryRawUnsafe: jest.fn(async () => [{ allowed: opts.wallAllowed ?? true }]),
    $executeRaw: jest.fn(async () => 1),
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
  const row = { id: 'm1', scope: 'firm', ownerUserId: null, clientId: null, key: 'k', value: 'v' };

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
    // scope/ownerUserId are re-asserted in the mutation query itself, not just
    // the earlier read (defense-in-depth against a TOCTOU between the two).
    expect(tx.clioMemory.deleteMany).toHaveBeenCalledWith({
      where: { id: 'm1', tenantId: 't1', scope: 'firm', ownerUserId: null, clientId: null },
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
    expect(memoryIngest.removeClioMemory).toHaveBeenCalledWith('t1', 'm1', 'projection-1');
    const reads = tx.$queryRaw.mock.calls.map(([strings, ...values]) =>
      Prisma.sql(strings, ...values).text,
    );
    expect(reads[0]).toContain('FROM clio_memory');
    expect(reads[0]).toContain('FOR UPDATE');
    expect(reads.findIndex((sql) => sql.includes('FROM memory_items'))).toBeGreaterThan(0);
    const revoked = tx.$executeRaw.mock.calls.map(([strings, ...values]) =>
      Prisma.sql(strings, ...values).text,
    );
    expect(revoked).toEqual(expect.arrayContaining([expect.stringContaining("status = 'revoked'")]));
  });

  it('404s when the row does not exist (no legal-hold/audit calls at all)', async () => {
    const { service, tx } = buildService({ clioMemoryRow: null, legalHold: false });
    await expect(service.forgetMemory(ctx, 'missing')).rejects.toThrow(NotFoundException);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
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

  it('denies a walled client even to an admin before deleting or inspecting projections', async () => {
    const { service, tx } = buildService({
      clioMemoryRow: { ...row, scope: 'client', clientId: 'c1' },
      legalHold: false, wallAllowed: false,
    });
    await expect(service.forgetMemory(ctx, 'm1')).rejects.toThrow(NotFoundException);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.clioMemory.deleteMany).not.toHaveBeenCalled();
  });

  it('fails the transaction if client scope changes after authorization', async () => {
    const { service, tx } = buildService({
      clioMemoryRow: { ...row, scope: 'client', clientId: 'c1' }, legalHold: false,
    });
    tx.clioMemory.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.forgetMemory(ctx, 'm1')).rejects.toThrow(NotFoundException);
    expect(tx.clioMemory.deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ clientId: 'c1' }) });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses Settings memory even if a derived shadow exists and candidate history is absent', async () => {
    const { service, tx } = buildService({
      clioMemoryRow: { ...row, source: 'settings_memory_editor' }, legalHold: false,
    });
    await expect(service.forgetMemory(ctx, 'm1')).rejects.toThrow('canonical version review');
    expect(tx.clioMemory.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses governed metadata with no authoritative committed-item link', async () => {
    const { service, tx } = buildService({
      clioMemoryRow: { ...row, source: 'conversation',
        metadata: { governance: { canonicalType: 'note' } } },
      legalHold: false,
    });
    await expect(service.forgetMemory(ctx, 'm1')).rejects.toThrow('canonical version review');
    expect(tx.clioMemory.deleteMany).not.toHaveBeenCalled();
  });

  it('accepts a governed source only when its committed item is the exact derived projection', async () => {
    const { service, tx } = buildService({
      clioMemoryRow: { ...row, metadata: { governance: { canonicalType: 'client-compass' } } },
      legalHold: false,
      linked: [{ id: 'projection-1', slug: 'clio:m1', type: 'client-compass' }],
    });
    await expect(service.forgetMemory(ctx, 'm1')).resolves.toEqual({ ok: true, id: 'm1' });
    expect(tx.clioMemory.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a linked custom canonical item outside the derived projection', async () => {
    const { service, tx } = buildService({
      clioMemoryRow: row, legalHold: false,
      linked: [{ id: 'canonical-1', slug: 'firm-settings', type: 'firm-soul' }],
    });
    await expect(service.forgetMemory(ctx, 'm1')).rejects.toThrow('canonical version review');
    expect(tx.clioMemory.deleteMany).not.toHaveBeenCalled();
  });

  it('revokes the canonical row and keeps cleanup queued when fast removal fails', async () => {
    const prior = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    try {
      const { service, tx, memoryIngest } = buildService({ clioMemoryRow: row, legalHold: false });
      const cleanupOutbox = {
        enqueue: jest.fn(async () => undefined),
        markIndexedOnFastPath: jest.fn(async () => undefined),
      };
      (service as unknown as { cleanupOutbox: typeof cleanupOutbox }).cleanupOutbox = cleanupOutbox;
      jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      memoryIngest.removeClioMemory.mockRejectedValueOnce(new Error('projection delete failed'));

      await expect(service.forgetMemory(ctx, 'm1')).resolves.toEqual({ ok: true, id: 'm1' });
      await new Promise<void>((done) => setImmediate(done));
      const revoked = tx.$executeRaw.mock.calls.map(([strings, ...values]) =>
        Prisma.sql(strings, ...values).text,
      );
      expect(revoked).toEqual(expect.arrayContaining([
        expect.stringContaining("governed_status = 'revoked'"),
      ]));
      expect(cleanupOutbox.enqueue).toHaveBeenCalledWith(
        tx, ctx.tenantId, expect.objectContaining({
          memoryItemId: 'projection-1', operation: 'revoke_projections',
        }),
      );
      expect(cleanupOutbox.markIndexedOnFastPath).not.toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
      else process.env.MEMORY_GOVERNANCE_LIFECYCLE = prior;
    }
  });

  it('refuses deletion without a projection subject before a backfill can race it', async () => {
    const { service, tx } = buildService({ clioMemoryRow: row, legalHold: false, projectionId: null });
    const cleanupOutbox = { enqueue: jest.fn(async () => undefined),
      markIndexedOnFastPath: jest.fn(async () => undefined) };
    (service as unknown as { cleanupOutbox: typeof cleanupOutbox }).cleanupOutbox = cleanupOutbox;
    await expect(service.forgetMemory(ctx, 'm1')).rejects.toThrow('not ready for safe deletion');
    expect(tx.clioMemory.deleteMany).not.toHaveBeenCalled();
    expect(cleanupOutbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('MeriService.updateMemory — legal hold + audit trail', () => {
  const row = { id: 'm1', scope: 'firm', ownerUserId: null, clientId: null,
    key: 'k', value: 'old', metadata: {} };

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
    const reads = tx.$queryRaw.mock.calls.map(([strings, ...values]) =>
      Prisma.sql(strings, ...values).text,
    );
    expect(reads[0]).toContain('FROM clio_memory');
    expect(reads[0]).toContain('FOR UPDATE');
    expect(reads.findIndex((sql) => sql.includes('FROM memory_items'))).toBeGreaterThan(0);
  });

  it('denies a walled client edit before touching the projection', async () => {
    const { service, tx } = buildService({
      clioMemoryRow: { ...row, scope: 'client', clientId: 'c1' },
      legalHold: false, wallAllowed: false,
    });
    await expect(service.updateMemory(ctx, 'm1', 'new value')).rejects.toThrow(NotFoundException);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.clioMemory.updateMany).not.toHaveBeenCalled();
  });

  it('fails an edit if the client changed after the wall check', async () => {
    const { service, tx } = buildService({
      clioMemoryRow: { ...row, scope: 'client', clientId: 'c1' }, legalHold: false,
    });
    tx.clioMemory.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.updateMemory(ctx, 'm1', 'new value')).rejects.toThrow(NotFoundException);
    expect(tx.clioMemory.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ clientId: 'c1' }),
    }));
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects an empty/whitespace-only value before ever checking legal hold', async () => {
    const { service, tx } = buildService({ clioMemoryRow: row, legalHold: false });
    await expect(service.updateMemory(ctx, 'm1', '   ')).rejects.toThrow(
      'Memory value must be a non-empty string',
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
