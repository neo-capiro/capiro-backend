import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PortfolioRelationshipsService } from './portfolio-relationships.service.js';
import { PortfolioProposalStore } from './portfolio-proposal.store.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'fixture',
  tenantSlug: 'fixture',
  role: 'user_admin',
} as const;
const clientId = '30000000-0000-4000-8000-000000000003';
const capabilityId = '40000000-0000-4000-8000-000000000004';
const id = '50000000-0000-4000-8000-000000000005';
const targetId = '60000000-0000-4000-8000-000000000006';
const evidence = [
  {
    url: 'https://example.gov/fixture',
    title: 'Synthetic fixture',
    excerpt: 'Test evidence without a real office quotation.',
    observedAt: '2026-01-01T00:00:00.000Z',
    sourceType: 'official',
  },
];
function fixture() {
  const row = {
    id,
    tenantId: ctx.tenantId,
    clientId,
    capabilityId,
    kind: 'office_recommendation',
    status: 'proposed',
    version: 1,
    reviewHistory: [],
    evidence,
    payload: {
      memberId: 'fixture-member',
      sourceDirectory: 'congress',
      officeTerm: 'congress:119',
      rationale: 'Test evidence',
      entryPoint: 'Fixture office',
      whyNot: 'No commitment established',
      stance: 'interested',
    },
  };
  const target = {
    id: targetId,
    tenantId: ctx.tenantId,
    clientId,
    relationshipStatus: 'uncontacted',
    history: [],
    version: 1,
    sourceDirectory: 'congress',
    memberId: 'fixture-member',
    officeTerm: 'congress:119',
  };
  const tx = {
    clientPortfolioProposal: {
      findFirst: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    congressMember: {
      findUnique: jest.fn().mockResolvedValue({ congresses: [119], isCurrent: true }),
    },
    clientCapability: { findFirst: jest.fn().mockResolvedValue({ id: capabilityId }) },
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ role: 'user_admin' }) },
    clientTarget: {
      findFirst: jest.fn().mockResolvedValue(target),
      update: jest.fn().mockResolvedValue(target),
    },
    clientTargetSupport: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'support' }),
      update: jest.fn(),
    },
  };
  const store = new PortfolioProposalStore({} as never);
  jest
    .spyOn(store, 'withClient')
    .mockImplementation(async (_ctx, _client, _write, work) => work(tx as never));
  const targets = { addTargetInTransaction: jest.fn().mockResolvedValue(target) };
  const service = new PortfolioRelationshipsService(store, targets as never, {} as never);
  return { service, tx, targets, row, target };
}
describe('canonical parent office and capability support', () => {
  it('creates a capability association with unknown stance without asserting office interest', async () => {
    const { service, tx, row } = fixture();
    row.payload.stance = 'unknown';
    await service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' });
    expect(tx.clientTargetSupport.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stance: 'unknown' }) }),
    );
  });

  beforeAll(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00Z')));
  afterAll(() => jest.useRealTimers());
  it('creates parent and child through the same authorized transaction on approval', async () => {
    const { service, tx, targets } = fixture();
    await service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' });
    expect(targets.addTargetInTransaction).toHaveBeenCalledWith(
      tx,
      ctx,
      clientId,
      expect.objectContaining({
        memberId: 'fixture-member',
        sourceDirectory: 'congress',
        officeTerm: 'congress:119',
      }),
    );
    expect(tx.clientTargetSupport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: ctx.tenantId,
          clientId,
          capabilityId,
          targetId,
          evidence,
          approvedByUserId: ctx.userId,
        }),
      }),
    );
  });
  it('does not create support if canonical parent creation fails', async () => {
    const { service, tx, targets } = fixture();
    targets.addTargetInTransaction.mockRejectedValue(new ConflictException('term conflict'));
    await expect(
      service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clientTargetSupport.create).not.toHaveBeenCalled();
    expect(tx.clientPortfolioProposal.updateMany).not.toHaveBeenCalled();
  });
  it('refuses social-only evidence before canonical relationship writes', async () => {
    const { service, tx, targets, row } = fixture();
    tx.clientPortfolioProposal.findFirst.mockResolvedValue({
      ...row,
      evidence: [{ ...evidence[0], url: 'https://social.example/post' }],
    });
    await expect(
      service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(targets.addTargetInTransaction).not.toHaveBeenCalled();
  });
  it('refuses office/term mismatch in canonical member history', async () => {
    const { service, tx, targets } = fixture();
    tx.congressMember.findUnique.mockResolvedValue({ congresses: [118], isCurrent: false });
    await expect(
      service.review(ctx, clientId, id, { expectedVersion: 1, action: 'approve' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(targets.addTargetInTransaction).not.toHaveBeenCalled();
  });
  it('cannot attach another client’s capability to the parent', async () => {
    const { service, tx } = fixture();
    tx.clientCapability.findFirst.mockResolvedValue(null);
    await expect(
      service.support(ctx, clientId, targetId, { capabilityId, stance: 'supportive', evidence }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.clientTargetSupport.create).not.toHaveBeenCalled();
  });
  it('does not write termEvidence as an undeclared ClientTarget column', async () => {
    const { service, tx } = fixture();
    await service.updateRelationship(ctx, clientId, targetId, {
      expectedVersion: 1,
      officeTerm: 'congress:119',
      termEvidence: evidence,
    });
    const data = tx.clientTarget.update.mock.calls[0]![0].data;
    expect(data.officeTerm).toBe('congress:119');
    expect(data).not.toHaveProperty('termEvidence');
    expect(data.history[0].termEvidence).toEqual(evidence);
  });
});
