import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ResearchPortfoliosService } from './research-portfolios.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const portfolioId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const otherUserId = '44444444-4444-4444-8444-444444444444';
const clientId = '55555555-5555-4555-8555-555555555555';
const now = new Date('2026-09-25T20:00:00.000Z');
const ctx = { tenantId, userId, role: 'standard_user' } as TenantContext;

function harness(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  const tx = {
    researchPortfolio: {
      findFirst: jest.fn().mockResolvedValue({
        id: portfolioId,
        lifecycle: 'active',
        revision: 1,
        grants: [{ role }],
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ revision: 2 }),
    },
    researchPortfolioEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'event-1', occurredAt: now }),
    },
    researchPortfolioGrant: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'grant-1' }),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(2),
    },
    researchPortfolioClientLink: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'link-1' }),
      delete: jest.fn().mockResolvedValue({}),
    },
    researchPortfolioMember: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'member-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    tenantMembership: {
      findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
    },
    client: {
      findFirst: jest.fn().mockResolvedValue({ id: clientId }),
    },
    programElement: {
      findUnique: jest.fn(async ({ where }: any) => ({
        peCode: where.peCode,
        title: 'Canonical PE',
        service: 'ARMY',
        serviceCode: null,
        appropriationType: 'RDT&E',
        source: 'jbook',
        sourceConfidence: 0.95,
        firstSeenFy: 2026,
        raw: {},
      })),
    },
    capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
    federalAward: {
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        awardUniqueId: 'CONT_AWD_123',
        piid: 'CONT_AWD_123',
        contractorName: 'Resolved award',
        awardingAgency: 'DoD',
        awardingSubTier: 'Army',
        fundingTas: null,
        peCode: null,
        fundingFy: 2026,
        description: null,
      })),
    },
    $queryRaw: jest.fn<any, any>().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, work: (transaction: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  return {
    tx,
    prisma,
    service: new ResearchPortfoliosService(prisma as never),
  };
}

describe('ResearchPortfoliosService Phase 1 authorization and recovery', () => {
  it.each([
    ['owner', 'owner'],
    ['owner', 'editor'],
    ['owner', 'viewer'],
    ['editor', 'editor'],
    ['editor', 'viewer'],
    ['viewer', 'viewer'],
  ] as const)('allows %s to perform %s reads/writes', async (actual, required) => {
    const h = harness(actual);
    await expect(
      (h.service as any).loadAuthorized(h.tx, ctx, portfolioId, required),
    ).resolves.toMatchObject({ role: actual });
  });

  it.each([
    ['viewer', 'editor'],
    ['viewer', 'owner'],
    ['editor', 'owner'],
  ] as const)('denies %s when %s access is required', async (actual, required) => {
    const h = harness(actual);
    await expect(
      (h.service as any).loadAuthorized(h.tx, ctx, portfolioId, required),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('hides revoked, absent, and cross-tenant portfolios behind a 404', async () => {
    const h = harness();
    h.tx.researchPortfolio.findFirst.mockResolvedValueOnce(null);
    await expect(
      (h.service as any).loadAuthorized(h.tx, ctx, portfolioId, 'viewer'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('blocks writes while archived but permits the separate restore path', async () => {
    const h = harness('editor');
    h.tx.researchPortfolio.findFirst.mockResolvedValueOnce({
      id: portfolioId,
      lifecycle: 'archived',
      revision: 1,
      grants: [{ role: 'editor' }],
    });
    await expect(
      h.service.update(ctx, portfolioId, {
        idempotencyKey: 'update-1',
        expectedRevision: 1,
        name: 'Blocked',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
  });

  it('rejects stale revisions without recording success', async () => {
    const h = harness('editor');
    h.tx.researchPortfolio.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      h.service.update(ctx, portfolioId, {
        idempotencyKey: 'update-2',
        expectedRevision: 9,
        purpose: 'stale',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.researchPortfolioEvent.create).not.toHaveBeenCalled();
  });

  it('requires grant recipients to be active members of the same tenant', async () => {
    const h = harness('owner');
    h.tx.tenantMembership.findFirst.mockResolvedValueOnce(null);
    await expect(
      h.service.upsertGrant(ctx, portfolioId, otherUserId, {
        idempotencyKey: 'grant-1',
        expectedRevision: 1,
        principalType: 'user',
        role: 'viewer',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prevents removal of the final owner', async () => {
    const h = harness('owner');
    h.tx.researchPortfolioGrant.findUnique.mockResolvedValueOnce({ id: 'grant-1', role: 'owner' });
    h.tx.researchPortfolioGrant.count.mockResolvedValueOnce(1);
    await expect(
      h.service.deleteGrant(ctx, portfolioId, userId, {
        idempotencyKey: 'grant-delete-1',
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.tx.researchPortfolioGrant.delete).not.toHaveBeenCalled();
  });

  it('applies the client ethical wall before creating a client link', async () => {
    const h = harness('editor');
    h.tx.$queryRawUnsafe.mockResolvedValueOnce([{ allowed: false }]);
    await expect(
      h.service.createClientLink(ctx, portfolioId, {
        idempotencyKey: 'client-link-1',
        expectedRevision: 1,
        clientId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.researchPortfolioClientLink.create).not.toHaveBeenCalled();
  });

  it('replays the same idempotent receipt and conflicts on different content', async () => {
    const h = harness();
    h.tx.researchPortfolioEvent.findUnique.mockResolvedValue({
      id: 'event-1',
      tenantId,
      portfolioId,
      actorUserId: userId,
      occurredAt: now,
      aggregateRevision: 3,
      payloadFingerprint: 'same-fingerprint',
      payload: { outcomes: [] },
    });
    await expect(
      (h.service as any).replay(h.tx, ctx, 'same-key', 'same-fingerprint'),
    ).resolves.toMatchObject({ replayed: true, eventId: 'event-1', resultingRevision: 3 });
    await expect(
      (h.service as any).replay(h.tx, ctx, 'same-key', 'different-fingerprint'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('adds a typed manual member and records a real receipt', async () => {
    const h = harness('editor');
    await expect(
      h.service.createMember(ctx, portfolioId, {
        idempotencyKey: 'member-create-1',
        expectedRevision: 1,
        targetKind: 'program_element',
        targetId: '0605053A',
        label: 'Example PE',
      }),
    ).resolves.toMatchObject({ replayed: false, resultingRevision: 2 });
    expect(h.tx.researchPortfolioMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ targetKind: 'program_element', targetId: '0605053A' }),
      }),
    );
  });

  it('rejects an invented canonical target unless the original input is preserved as unresolved', async () => {
    const h = harness('editor');
    h.tx.programElement.findUnique.mockResolvedValueOnce(null as never);
    await expect(
      h.service.createMember(ctx, portfolioId, {
        idempotencyKey: 'member-create-missing',
        expectedRevision: 1,
        targetKind: 'program_element',
        targetId: 'NOT-A-REAL-PE',
        label: 'Invented',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.tx.researchPortfolioMember.create).not.toHaveBeenCalled();
  });

  it('excludes and reinstates typed members with reasons in one decision receipt', async () => {
    const h = harness('editor');
    h.tx.researchPortfolioMember.findMany.mockResolvedValueOnce([
      { id: 'member-1', targetId: '0605053A' },
      { id: 'member-2', targetId: 'award-2' },
    ]);
    await h.service.decideMembers(ctx, portfolioId, {
      idempotencyKey: 'member-decisions-1',
      expectedRevision: 1,
      decisions: [
        { memberId: 'member-1', disposition: 'excluded', reason: 'Out of scope' },
        { memberId: 'member-2', disposition: 'included', reason: 'Reviewed and reinstated' },
      ],
    });
    expect(h.tx.researchPortfolioMember.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ disposition: 'excluded' }) }),
    );
    expect(h.tx.researchPortfolioMember.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ disposition: 'included' }) }),
    );
  });

  it('resolves preserved unresolved input to a canonical typed target', async () => {
    const h = harness('editor');
    h.tx.researchPortfolioMember.findFirst.mockResolvedValueOnce({
      id: 'member-1',
      disposition: 'unresolved',
    });
    await h.service.resolveMember(ctx, portfolioId, 'member-1', {
      idempotencyKey: 'member-resolve-1',
      expectedRevision: 1,
      targetKind: 'award',
      targetId: '66666666-6666-4666-8666-666666666666',
      label: 'Resolved award',
    });
    expect(h.tx.researchPortfolioMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetKind: 'award',
          targetId: '66666666-6666-4666-8666-666666666666',
          disposition: 'included',
        }),
      }),
    );
  });
});

describe('Research portfolio current authority on durable replay and client links', () => {
  async function committedUpdate() {
    const h = harness('editor');
    const input = {
      idempotencyKey: 'authority-update-1',
      expectedRevision: 1,
      name: 'Reviewed update',
    };
    await h.service.update(ctx, portfolioId, input);
    const data = h.tx.researchPortfolioEvent.create.mock.calls[0][0].data;
    h.tx.researchPortfolioEvent.findUnique.mockResolvedValue({
      id: 'event-1',
      occurredAt: now,
      ...data,
    });
    h.tx.researchPortfolio.updateMany.mockClear();
    h.tx.researchPortfolioEvent.create.mockClear();
    return { h, input };
  }

  it('masks denied client links while preserving independently allowed links', async () => {
    const h = harness('viewer');
    const links = [
      {
        id: 'denied-link',
        clientId,
        client: { name: 'Denied client' },
        linkedByUserId: userId,
        createdAt: now,
      },
      {
        id: 'allowed-link',
        clientId: otherUserId,
        client: { name: 'Allowed client' },
        linkedByUserId: userId,
        createdAt: now,
      },
    ];
    (h.tx.researchPortfolioClientLink as any).findMany = jest.fn().mockResolvedValue(links);
    h.tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ allowed: false }])
      .mockResolvedValueOnce([{ allowed: true }]);
    await expect(h.service.listClientLinks(ctx, portfolioId)).resolves.toEqual([
      expect.objectContaining({ id: 'allowed-link', clientName: 'Allowed client' }),
    ]);
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('rejects a committed replay after the actor loses the portfolio grant', async () => {
    const { h, input } = await committedUpdate();
    h.tx.researchPortfolio.findFirst.mockResolvedValue(null as never);
    await expect(h.service.update(ctx, portfolioId, input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a different actor using an identical key and content', async () => {
    const { h, input } = await committedUpdate();
    await expect(
      h.service.update({ ...ctx, userId: otherUserId }, portfolioId, input),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
  });

  it.each(['active', 'archived'] as const)(
    'replays the same actor receipt after revision drift while %s',
    async (lifecycle) => {
      const { h, input } = await committedUpdate();
      h.tx.researchPortfolio.findFirst.mockResolvedValue({
        id: portfolioId,
        lifecycle,
        revision: 7,
        grants: [{ role: 'editor' }],
      });
      await expect(h.service.update(ctx, portfolioId, input)).resolves.toMatchObject({
        replayed: true,
        actorUserId: userId,
        resultingRevision: 2,
      });
      expect(h.tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
      expect(h.tx.researchPortfolioEvent.create).not.toHaveBeenCalled();
      if (lifecycle === 'archived') {
        h.tx.researchPortfolioEvent.findUnique.mockResolvedValue(null);
        await expect(
          h.service.update(ctx, portfolioId, { ...input, idempotencyKey: 'fresh-archived-key' }),
        ).rejects.toBeInstanceOf(ConflictException);
      }
    },
  );

  it('still requires the operation role on replay', async () => {
    const { h, input } = await committedUpdate();
    h.tx.researchPortfolio.findFirst.mockResolvedValue({
      id: portfolioId,
      lifecycle: 'active',
      revision: 7,
      grants: [{ role: 'viewer' }],
    });
    await expect(h.service.update(ctx, portfolioId, input)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('still rejects changed replay content', async () => {
    const { h, input } = await committedUpdate();
    await expect(
      h.service.update(ctx, portfolioId, { ...input, name: 'Different request' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.researchPortfolio.updateMany).not.toHaveBeenCalled();
  });

  it('reauthorizes create replay and preserves authorized retry after revision drift', async () => {
    const h = harness('owner');
    (h.tx.researchPortfolio as any).create = jest
      .fn()
      .mockResolvedValue({ id: portfolioId, revision: 1 });
    (h.tx.researchPortfolioGrant as any).create = jest
      .fn()
      .mockResolvedValue({ id: 'grant-created' });
    const input = { idempotencyKey: 'authority-create-1', name: 'Created portfolio' };
    await h.service.create(ctx, input);
    const data = h.tx.researchPortfolioEvent.create.mock.calls[0][0].data;
    h.tx.researchPortfolioEvent.findUnique.mockResolvedValue({
      id: 'event-1',
      occurredAt: now,
      ...data,
    });
    h.tx.researchPortfolio.findFirst.mockResolvedValue({
      id: portfolioId,
      lifecycle: 'active',
      revision: 7,
      grants: [{ role: 'viewer' }],
    });
    await expect(h.service.create(ctx, input)).resolves.toMatchObject({
      replayed: true,
      resultingRevision: 1,
    });
    await expect(h.service.create({ ...ctx, userId: otherUserId }, input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    h.tx.researchPortfolio.findFirst.mockResolvedValue(null as never);
    await expect(h.service.create(ctx, input)).rejects.toBeInstanceOf(NotFoundException);
    expect((h.tx.researchPortfolio as any).create).toHaveBeenCalledTimes(1);
  });
});

describe('Research portfolio grant mutation serialization', () => {
  it('locks the tenant-scoped parent before checking current grant authority', async () => {
    const h = harness('owner');
    await h.service.update(ctx, portfolioId, {
      idempotencyKey: 'locked-update',
      expectedRevision: 1,
      name: 'Serialized update',
    });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const query = h.tx.$queryRaw.mock.calls[0][0] as any;
    expect(query.sql).toContain('FOR UPDATE');
    expect(query.values).toEqual([portfolioId, tenantId]);
    const lockOrder = h.tx.$queryRaw.mock.invocationCallOrder[0];
    const authorityOrder = h.tx.researchPortfolio.findFirst.mock.invocationCallOrder[0];
    const replayOrder = h.tx.researchPortfolioEvent.findUnique.mock.invocationCallOrder[0];
    expect([lockOrder, authorityOrder, replayOrder]).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    );
    if (lockOrder === undefined || authorityOrder === undefined || replayOrder === undefined)
      throw new Error('Expected lock, authority and replay calls to all occur');
    expect(lockOrder).toBeLessThan(authorityOrder);
    expect(authorityOrder).toBeLessThan(replayOrder);
  });
  it('reauthorizes after a waited-for parent lock and rejects the former owner', async () => {
    const h = harness('owner');
    let releaseLock!: () => void;
    h.tx.$queryRaw.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve;
        }),
    );
    const result = h.service.deleteGrant(ctx, portfolioId, otherUserId, {
      idempotencyKey: 'waiting-owner-delete',
      expectedRevision: 2,
    });
    await Promise.resolve();
    expect(h.tx.researchPortfolio.findFirst).not.toHaveBeenCalled();
    h.tx.researchPortfolio.findFirst.mockResolvedValue(null as never);
    releaseLock();
    await expect(result).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.researchPortfolioGrant.count).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioGrant.delete).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioEvent.create).not.toHaveBeenCalled();
  });
});
