import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;

function harness(row: Record<string, unknown> | null, opts: {
  wallAllowed?: boolean;
  linked?: Array<{ id: string; slug: string | null; type: string | null }>;
} = {}) {
  const tx = {
    clioMemory: { findFirst: jest.fn(async () => row) },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: opts.wallAllowed ?? true }]),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      if (sql.text.includes('FROM memory_candidate mc')) return opts.linked ?? [];
      return [{ id: '33333333-3333-4333-8333-333333333333' }];
    }),
  };
  const candidates = { proposeSaveMemory: jest.fn(async () => ({ candidateId: 'candidate-1' })) };
  const service = Object.create(MeriService.prototype) as any;
  service.prisma = { withTenantUser: (_tenant: string, _user: string,
    run: (tx: unknown) => unknown) => run(tx) };
  service.memoryCandidates = candidates;
  return { service, tx, candidates };
}

describe('Meri legacy correction suggestion source authorization', () => {
  const prior = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  beforeEach(() => { process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'off'; });
  afterEach(() => {
    if (prior === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = prior;
  });
  const source = {
    id: '44444444-4444-4444-8444-444444444444',
    key: 'Budget', value: 'Old budget', scope: 'firm', clientId: null,
    ownerUserId: null, expiresAt: null, metadata: {}, source: 'conversation',
  };

  it('refuses a known private UUID before copying fields or proposing a candidate', async () => {
    const { service, tx, candidates } = harness({ ...source, scope: 'user_private',
      ownerUserId: '55555555-5555-4555-8555-555555555555' });
    await expect(service.suggestMemoryCorrection(ctx, source.id, { value: 'New budget' }))
      .rejects.toThrow(NotFoundException);
    expect(tx.clioMemory.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ scope: { in: ['firm', 'client'] } }),
    }));
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('refuses a walled client before proposing a candidate', async () => {
    const { service, tx, candidates } = harness({ ...source, scope: 'client',
      clientId: '66666666-6666-4666-8666-666666666666' }, { wallAllowed: false });
    await expect(service.suggestMemoryCorrection(ctx, source.id, { value: 'New budget' }))
      .rejects.toThrow(NotFoundException);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('refuses Settings and custom canonical items on the generic candidate route', async () => {
    const settings = harness({ ...source, source: 'settings_memory_editor' });
    await expect(settings.service.suggestMemoryCorrection(ctx, source.id, { value: 'New budget' }))
      .rejects.toThrow('canonical version review');
    expect(settings.candidates.proposeSaveMemory).not.toHaveBeenCalled();

    const linked = harness(source, { linked: [{ id: 'canonical-1', slug: 'firm-settings', type: 'firm-soul' }] });
    await expect(linked.service.suggestMemoryCorrection(ctx, source.id, { value: 'New budget' }))
      .rejects.toThrow('canonical version review');
    expect(linked.candidates.proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('keeps an authorized shared correction as a proposal', async () => {
    const { service, candidates } = harness(source);
    await expect(service.suggestMemoryCorrection(ctx, source.id, { value: 'New budget' }))
      .resolves.toEqual({ ok: true, state: 'pending_review', candidateId: 'candidate-1' });
    expect(candidates.proposeSaveMemory).toHaveBeenCalledWith(
      ctx.tenantId, ctx.userId, expect.objectContaining({
        scope: 'firm', ownerUserId: null, key: 'Budget', value: 'New budget',
      }), false, 'user_correction',
    );
  });
});
