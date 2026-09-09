import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';

// Exercise the canonical queue projections and their authorization ordering;
// the collaborators' policy rules are unchanged and supplied explicitly below.
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./memory-candidate.service.js', () => ({ MemoryCandidateService: class {} }));
jest.mock('./immutable-memory-version.service.js', () => ({ ImmutableMemoryVersionService: class {} }));
jest.mock('./memory-authorization.service.js', () => ({ MemoryAuthorizationService: class {} }));
jest.mock('./memory-review-workflow.service.js', () => ({ MemoryReviewWorkflowService: class {} }));
jest.mock('./memory-ingest.service.js', () => ({ MemoryIngestService: class {} }));
jest.mock('./memory-transition-audit.service.js', () => ({ MemoryTransitionAuditService: class {} }));
jest.mock('./memory-cleanup-outbox.service.js', () => ({ MemoryCleanupOutboxService: class {} }));
jest.mock('./memory-review-switch.js', () => ({ memoryReviewSurfaceEnabled: () => true }));

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_test', tenantSlug: 'test', role: 'standard_user',
} satisfies TenantContext;

function row(id: string, clientId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id, clientId, scope: clientId ? 'client' : 'firm', proposedBy: 'proposer',
    sourceKind: 'chat', createdAt: new Date('2026-09-09T00:00:00Z'),
    status: 'pending', decidedAt: null, contradictsMemoryItemId: null, conflictStatus: null,
    ...overrides,
  };
}

function harness(rows: ReturnType<typeof row>[]) {
  const denied = new Set<string>();
  const unassigned = new Set<string>();
  const walled = new Set<string>();
  const names = new Map([['l3', 'L3 Harris'], ['anduril', 'Anduril'], ['hidden', 'Hidden client']]);
  const tx = {
    memoryCandidate: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn().mockImplementation(async ({ where, select }) => {
        if (select.payload) return { payload: { key: `Proposal ${where.id}`, value: 'Actual content' } };
        return rows.find((candidate) => candidate.id === where.id) ?? null;
      }),
    },
    client: {
      findMany: jest.fn().mockImplementation(async ({ where }) =>
        where.id.in.filter((id: string) => names.has(id)).map((id: string) => ({ id, name: names.get(id) }))),
    },
    $queryRawUnsafe: jest.fn().mockImplementation(async (_sql, _tenant, clientId) => [{ allowed: !walled.has(clientId) }]),
  };
  const prisma = { withTenantUser: jest.fn().mockImplementation(async (_tenant, _user, run) => run(tx)) };
  const authorization = {
    loadCandidateInTx: jest.fn().mockImplementation(async (_tx, _tenant, id) => rows.find((candidate) => candidate.id === id)),
    evaluateInTx: jest.fn().mockImplementation(async (_tx, _ctx, subject) => ({ allowed: !denied.has(subject.id) })),
  };
  const workflow = {
    ensureAndDescribeInTx: jest.fn().mockImplementation(async (_tx, _ctx, subject) => ({
      status: 'pending', assignedReviewer: { userId: unassigned.has(subject.id) ? 'someone-else' : ctx.userId },
      capabilities: { requestChanges: true, reassign: false },
    })),
    assertAssignedForDecision: jest.fn().mockResolvedValue(undefined),
    completeDecision: jest.fn().mockResolvedValue(undefined),
  };
  const candidates = { approve: jest.fn().mockResolvedValue({ memoryId: 'memory-record' }), reject: jest.fn().mockResolvedValue(undefined) };
  const review = new MemoryCandidateReviewService(prisma as never, authorization as never, candidates as never, {} as never, workflow as never);
  const own = new GovernedMemoryCandidateService(prisma as never, {} as never, {} as never, {} as never, {} as never, authorization as never);
  return { tx, prisma, denied, unassigned, walled, review, own, candidates, workflow, names };
}

describe('governed memory queue target labels', () => {
  it('adds actual client names after authorization and reviewer assignment, without picker filtering', async () => {
    const h = harness([row('proposal-l3', 'l3'), row('proposal-anduril', 'anduril'), row('firm-proposal', null), row('denied', 'hidden'), row('unassigned', 'unassigned-client')]);
    h.denied.add('denied');
    h.unassigned.add('unassigned');
    const response = await h.review.listReviewable(ctx);
    expect(response.candidates.map(({ id, clientId, clientName }) => ({ id, clientId, clientName }))).toEqual([
      { id: 'proposal-l3', clientId: 'l3', clientName: 'L3 Harris' },
      { id: 'proposal-anduril', clientId: 'anduril', clientName: 'Anduril' },
      { id: 'firm-proposal', clientId: null, clientName: null },
    ]);
    expect(h.tx.client.findMany).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, id: { in: ['l3', 'anduril'] } }, select: { id: true, name: true },
    });
    expect(h.tx.memoryCandidate.findMany.mock.calls[0][0].where).toEqual({ tenantId: ctx.tenantId, status: 'pending' });
    expect(h.tx.memoryCandidate.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'denied' }) }));
    expect(h.prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function));
  });

  it('returns no labels or candidates to a denied reviewer', async () => {
    const h = harness([row('denied', 'hidden')]);
    h.denied.add('denied');
    expect((await h.review.listReviewable(ctx)).candidates).toEqual([]);
    expect(h.tx.client.findMany).not.toHaveBeenCalled();
  });

  it('preserves missing client identity as unavailable instead of borrowing another label', async () => {
    const h = harness([row('known', 'l3'), row('missing', 'deleted-client')]);
    expect((await h.review.listReviewable(ctx)).candidates.map((candidate) => candidate.clientName)).toEqual(['L3 Harris', null]);
  });

  it('redacts a restricted owned proposal name and body while retaining the canonical withdrawal capability', async () => {
    const h = harness([row('own-l3', 'l3'), row('own-hidden', 'hidden'), row('own-firm', null)]);
    h.walled.add('hidden');
    const response = await h.own.listOwnProposals(ctx);
    expect(response.candidates[0]).toMatchObject({ id: 'own-l3', clientId: 'l3', clientName: 'L3 Harris', restricted: false });
    expect(response.candidates[1]).toMatchObject({ id: 'own-hidden', clientId: 'hidden', clientName: null, restricted: true, proposal: null, capabilities: { withdraw: true } });
    expect(response.candidates[2]).toMatchObject({ scope: 'firm', clientName: null });
    expect(h.tx.client.findMany).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, id: { in: ['l3'] } }, select: { id: true, name: true },
    });
    expect(h.tx.memoryCandidate.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'own-hidden' }) }));
  });

  it('does not query client names for a fully restricted owned queue', async () => {
    const h = harness([row('own-hidden', 'hidden')]);
    h.walled.add('hidden');
    expect((await h.own.listOwnProposals(ctx)).candidates[0]?.clientName).toBeNull();
    expect(h.tx.client.findMany).not.toHaveBeenCalled();
  });

  it('retains the requested candidate ID through canonical approval and rejection', async () => {
    const h = harness([row('proposal-l3', 'l3'), row('proposal-anduril', 'anduril')]);
    await h.review.approve(ctx, 'proposal-l3');
    expect(h.workflow.assertAssignedForDecision).toHaveBeenCalledWith(ctx, 'proposal-l3', 'approve');
    expect(h.candidates.approve).toHaveBeenCalledWith(ctx.tenantId, 'proposal-l3', ctx.userId, ctx);
    await h.review.reject(ctx, 'proposal-anduril', 'Source is outdated');
    expect(h.workflow.assertAssignedForDecision).toHaveBeenCalledWith(ctx, 'proposal-anduril', 'review');
    expect(h.candidates.reject).toHaveBeenCalledWith(ctx.tenantId, 'proposal-anduril', ctx.userId, ctx);
    expect(h.workflow.completeDecision).toHaveBeenCalledWith(ctx, 'proposal-anduril', 'rejected', 'Source is outdated');
  });

  it('preserves server authorization denial before any review mutation', async () => {
    const h = harness([row('proposal-l3', 'l3')]);
    h.workflow.assertAssignedForDecision.mockRejectedValue(new ForbiddenException('Independent reviewer required'));
    await expect(h.review.approve(ctx, 'proposal-l3')).rejects.toThrow('Independent reviewer required');
    await expect(h.review.reject(ctx, 'proposal-l3', 'A reason')).rejects.toThrow('Independent reviewer required');
    expect(h.candidates.approve).not.toHaveBeenCalled();
    expect(h.candidates.reject).not.toHaveBeenCalled();
    expect(h.workflow.completeDecision).not.toHaveBeenCalled();
  });
});
