import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PortfolioProposalStore } from './portfolio-proposal.store.js';
import { parsePortfolio, proposalSchema } from './portfolio.contracts.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'fixture-actor',
  tenantSlug: 'fixture',
  role: 'user_admin',
} as const;
const clientId = '30000000-0000-4000-8000-000000000003';
const input = parsePortfolio(proposalSchema, {
  kind: 'capability',
  payload: {
    name: 'Fixture service',
    type: 'service',
    lifecycle: 'planned',
    description: 'Recorded test fixture',
  },
  evidence: [
    {
      url: 'https://company.example/service',
      title: 'Fixture document',
      excerpt: 'Test evidence, not a real attributed quote.',
      observedAt: '2026-01-01T00:00:00.000Z',
      sourceType: 'company',
    },
  ],
});
const row = {
  id: '40000000-0000-4000-8000-000000000004',
  tenantId: ctx.tenantId,
  clientId,
  capabilityId: null,
  kind: 'capability',
  dedupeKey: 'fixture',
  status: 'proposed',
  payload: input.payload,
  evidence: input.evidence,
  version: 1,
  reviewHistory: [],
  reviewedByUserId: null,
  reviewedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
function fixture() {
  const tx = {
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ role: 'user_admin' }) },
    $queryRaw: jest.fn().mockResolvedValue([{ role: 'user_admin', version: 1, primary: null }]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    clientCapability: { findFirst: jest.fn().mockResolvedValue({ id: 'cap' }) },
    engagementAttachment: { findFirst: jest.fn().mockResolvedValue(null) },
    clientPortfolioProposal: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = { withTenantUser: jest.fn(async (_tenant, _user, work) => work(tx)) };
  return { tx, prisma, store: new PortfolioProposalStore(prisma as never) };
}
describe('portfolio staging authority and review', () => {
  it('uses canonical current actor/client/wall authorization before reading', async () => {
    const { store, tx, prisma } = fixture();
    const work = jest.fn().mockResolvedValue('ok');
    await expect(store.withClient(ctx, clientId, false, work)).resolves.toBe('ok');
    expect(prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('client_memory_access'),
      ctx.tenantId,
      clientId,
      ctx.userId,
    );
  });
  it('preserves ordinary standard-user capability editing while taking an exclusive client lock', async () => {
    const { store, tx } = fixture();
    const actor = { ...ctx, role: 'standard_user' as const };
    tx.tenantMembership.findFirst.mockResolvedValue({ role: 'standard_user' });
    tx.$queryRaw.mockResolvedValue([{ role: 'standard_user', version: 1, primary: null }]);
    const work = jest.fn().mockResolvedValue('allowed');
    await expect(store.withClient(actor, clientId, true, work)).resolves.toBe('allowed');
    expect(work).toHaveBeenCalledTimes(1);
  });
  it.each(['missing_actor', 'revoked_actor', 'walled', 'cross_client'])(
    'denies %s before domain reads or writes',
    async (kind) => {
      const { store, tx } = fixture();
      const work = jest.fn();
      if (kind === 'missing_actor') tx.tenantMembership.findFirst.mockResolvedValue(null);
      if (kind === 'revoked_actor')
        tx.$queryRaw.mockResolvedValueOnce([{ version: 1 }]).mockResolvedValueOnce([]);
      if (kind === 'walled') tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
      if (kind === 'cross_client') tx.$queryRaw.mockResolvedValue([]);
      await expect(store.withClient(ctx, clientId, true, work)).rejects.toBeInstanceOf(
        kind.includes('actor') ? ForbiddenException : NotFoundException,
      );
      expect(work).not.toHaveBeenCalled();
    },
  );
  it('never resurfaces a rejected proposal on retry/source refresh', async () => {
    const { store, tx } = fixture();
    const rejected = { ...row, status: 'rejected' };
    tx.clientPortfolioProposal.findUnique.mockResolvedValue(rejected);
    await expect(store.propose(tx as never, ctx, clientId, input)).resolves.toEqual(rejected);
    expect(tx.clientPortfolioProposal.create).not.toHaveBeenCalled();
  });
  it('rejects stale versions before applying canonical writes', async () => {
    const { store, tx } = fixture();
    const apply = jest.fn();
    await expect(
      store.review(
        tx as never,
        ctx,
        row as never,
        { expectedVersion: 2, action: 'approve' },
        apply,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(apply).not.toHaveBeenCalled();
  });
  it('requires explicit restore before approving a rejection', async () => {
    const { store, tx } = fixture();
    const apply = jest.fn();
    await expect(
      store.review(
        tx as never,
        ctx,
        { ...row, status: 'rejected' } as never,
        { expectedVersion: 1, action: 'approve' },
        apply,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(apply).not.toHaveBeenCalled();
  });
  it('retains original evidence and appends actor/time on approval', async () => {
    const { store, tx } = fixture();
    const apply = jest.fn();
    const result = await store.review(
      tx as never,
      ctx,
      row as never,
      { expectedVersion: 1, action: 'approve' },
      apply,
    );
    expect(result.evidence).toEqual(input.evidence);
    expect(apply).toHaveBeenCalledWith(input);
    expect(tx.clientPortfolioProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ version: 1 }),
        data: expect.objectContaining({
          status: 'approved',
          reviewHistory: [expect.objectContaining({ action: 'approve', actorUserId: ctx.userId })],
        }),
      }),
    );
  });
  it('does not confirm missing practitioner-reviewed sector references', async () => {
    const { store, tx } = fixture();
    const apply = jest.fn();
    const sector = {
      ...row,
      kind: 'sector_anchor',
      status: 'draft',
      payload: {
        sector: 'health',
        agency: 'Fixture',
        account: 'Fixture',
        program: 'Fixture',
        maturity: { current: 'research', steps: ['research'] },
      },
    };
    await expect(
      store.review(
        tx as never,
        ctx,
        sector as never,
        { expectedVersion: 1, action: 'approve' },
        apply,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(apply).not.toHaveBeenCalled();
  });
  it('rejects foreign/restricted/missing evidence attachments', async () => {
    const { store, tx } = fixture();
    await expect(
      store.propose(tx as never, ctx, clientId, {
        ...input,
        evidence: [
          {
            ...input.evidence[0],
            url: undefined,
            attachmentId: '50000000-0000-4000-8000-000000000005',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.engagementAttachment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: ctx.tenantId, clientId, viewerMode: 'all' }),
      }),
    );
    expect(tx.clientPortfolioProposal.create).not.toHaveBeenCalled();
  });
});
