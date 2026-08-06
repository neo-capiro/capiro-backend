import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCandidateService } from './memory-candidate.service.js';
import {
  MemoryCandidateReviewService,
  candidateKindForSource,
} from './memory-candidate-review.service.js';
import type { MemoryReviewWorkflowService } from './memory-review-workflow.service.js';
import { clientMemoryReviewEnabled, memoryReviewSurfaceEnabled } from './memory-review-switch.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: USER,
  clerkUserId: 'user_standard',
  role: 'standard_user',
};

function withGovernance<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const priorClientReview = process.env.MEMORY_CLIENT_REVIEW;
  const priorLifecycle = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  const priorEnforce = process.env.MEMORY_GOVERNANCE_ENFORCE;
  if (enabled) {
    process.env.MEMORY_CLIENT_REVIEW = 'enforce';
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  } else {
    delete process.env.MEMORY_CLIENT_REVIEW;
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;
  }
  return fn().finally(() => {
    if (priorClientReview === undefined) delete process.env.MEMORY_CLIENT_REVIEW;
    else process.env.MEMORY_CLIENT_REVIEW = priorClientReview;
    if (priorLifecycle === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = priorLifecycle;
    if (priorEnforce === undefined) delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    else process.env.MEMORY_GOVERNANCE_ENFORCE = priorEnforce;
  });
}

function harness(input: {
  approveAllowed?: boolean;
  reviewAllowed?: boolean;
  scope?: 'client' | 'firm';
  sourceKind?: string;
  assignedToViewer?: boolean;
  workflowStatus?: 'pending' | 'changes_requested';
}) {
  const scope = input.scope ?? 'client';
  const sourceKind = input.sourceKind ?? 'settings_sections';
  const payload = {
    key: 'settings-file:client-soul:client-1',
    value: '[{"key":"priorities"}]',
    canonicalItem: {
      type: 'client-soul',
      slug: 'client-1',
      title: 'Client Soul',
      sections: [
        {
          key: 'priorities',
          heading: 'Priorities',
          owner: 'human',
          body: 'Protect the FY27 request.',
        },
      ],
    },
  };
  const row = {
    id: 'candidate-1',
    clientId: scope === 'client' ? CLIENT : null,
    proposedBy: 'proposer-1',
    sourceKind,
    scope,
    createdAt: new Date('2026-07-31T12:00:00.000Z'),
  };
  const findFirst = jest.fn(async (args: { select?: Record<string, boolean> }) =>
    args.select?.sourceKind ? { sourceKind } : { payload },
  );
  const tx = {
    memoryCandidate: {
      findMany: jest.fn(async () => [row]),
      findFirst,
    },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: (value: typeof tx) => unknown) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
  const authorization = {
    loadCandidateInTx: jest.fn(async () => ({
      id: row.id,
      tenantId: TENANT,
      clientId: row.clientId,
      ownerUserId: row.proposedBy,
      proposedByUserId: row.proposedBy,
      memoryClass: scope === 'client' ? 'client_steering' : 'institutional_authoritative',
      scope,
      status: 'pending_review',
      legalHold: false,
      clientStatus: scope === 'client' ? 'active' : null,
    })),
    evaluateInTx: jest.fn(
      async (_tx: unknown, _ctx: unknown, _subject: unknown, operation: string) =>
        operation === 'approve'
          ? input.approveAllowed
            ? { allowed: true, basis: 'explicit_grant' }
            : { allowed: false, reason: 'missing_grant' }
          : input.reviewAllowed
            ? { allowed: true, basis: 'explicit_grant' }
            : { allowed: false, reason: 'missing_grant' },
    ),
  } as unknown as MemoryAuthorizationService;
  const approve = jest.fn(async () => ({ memoryId: 'memory-1' }));
  const reject = jest.fn(async () => undefined);
  const candidates = { approve, reject } as unknown as MemoryCandidateService;
  const approveVersion = jest.fn(async () => ({
    candidateId: row.id,
    outcome: 'activated' as const,
    memoryItemId: 'item-2',
    controllingItemId: 'item-2',
  }));
  const rejectVersion = jest.fn(async () => ({
    candidateId: row.id,
    outcome: 'rejected' as const,
  }));
  const versions = {
    approveCandidate: approveVersion,
    rejectCandidate: rejectVersion,
  } as unknown as ImmutableMemoryVersionService;
  const workflowSnapshot = {
    requestId: 'request-1',
    status: input.workflowStatus ?? ('pending' as const),
    submittedBy: { userId: row.proposedBy, name: 'Pat Proposer' },
    assignedReviewer:
      input.assignedToViewer === false
        ? { userId: 'other-reviewer', name: 'Other Reviewer' }
        : { userId: USER, name: 'Riley Reviewer' },
    decidedBy: null,
    feedbackReason: input.workflowStatus === 'changes_requested' ? 'Add the source.' : null,
    createdAt: '2026-07-31T12:00:00.000Z',
    decidedAt: null,
    viewerIsSubmitter: false,
    viewerIsAssignedReviewer: input.assignedToViewer !== false,
    capabilities: { requestChanges: input.assignedToViewer !== false, reassign: false },
  };
  const ensureAndDescribeInTx = jest.fn(async () => workflowSnapshot);
  const requestChanges = jest.fn(async () => ({
    ...workflowSnapshot,
    status: 'changes_requested' as const,
    feedbackReason: 'Add the source.',
    capabilities: { requestChanges: false, reassign: false },
  }));
  const assignReviewer = jest.fn(async () => workflowSnapshot);
  const assertAssignedForDecision = jest.fn(async () => undefined);
  const completeDecision = jest.fn(async () => workflowSnapshot);
  const workflow = {
    ensureAndDescribeInTx,
    requestChanges,
    assignReviewer,
    assertAssignedForDecision,
    completeDecision,
  } as unknown as MemoryReviewWorkflowService;
  return {
    service: new MemoryCandidateReviewService(
      prisma,
      authorization,
      candidates,
      versions,
      workflow,
    ),
    approve,
    reject,
    approveVersion,
    rejectVersion,
    ensureAndDescribeInTx,
    requestChanges,
    assignReviewer,
    assertAssignedForDecision,
    completeDecision,
    authorization,
    tx,
    findFirst,
  };
}

describe('memory review switch', () => {
  it('arms only on exact values and requires all three server controls', () => {
    expect(clientMemoryReviewEnabled('enforce')).toBe(true);
    expect(clientMemoryReviewEnabled(' ENFORCE ')).toBe(true);
    for (const value of [undefined, '', 'true', 'on', '1', 'enabled']) {
      expect(clientMemoryReviewEnabled(value)).toBe(false);
    }
    expect(
      memoryReviewSurfaceEnabled({
        MEMORY_CLIENT_REVIEW: 'enforce',
        MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_ENFORCE: 'enforce',
      }),
    ).toBe(true);
    expect(
      memoryReviewSurfaceEnabled({
        MEMORY_CLIENT_REVIEW: 'enforce',
        MEMORY_GOVERNANCE_LIFECYCLE: 'off',
        MEMORY_GOVERNANCE_ENFORCE: 'enforce',
      }),
    ).toBe(false);
  });
});

describe('candidateKindForSource', () => {
  it('maps immutable version source kinds and defaults every other source', () => {
    expect(candidateKindForSource('memory_correction')).toBe('correction');
    expect(candidateKindForSource('memory_restore')).toBe('restore');
    expect(candidateKindForSource('memory_contradiction')).toBe('contradiction');
    expect(candidateKindForSource('settings_sections')).toBe('standard');
  });
});

describe('MemoryCandidateReviewService', () => {
  it('stays dark until client review, lifecycle, and authorization are all explicitly armed', async () => {
    await withGovernance(false, async () => {
      const h = harness({ approveAllowed: true });
      await expect(h.service.listReviewable(ctx)).resolves.toEqual({
        enabled: false,
        candidates: [],
      });
      expect(h.tx.memoryCandidate.findMany).not.toHaveBeenCalled();
      await expect(h.service.approve(ctx, 'candidate-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(h.approve).not.toHaveBeenCalled();
    });
  });

  it('shows content only to the named reviewer and includes human workflow identities', async () => {
    await withGovernance(true, async () => {
      const h = harness({
        approveAllowed: true,
        reviewAllowed: true,
        sourceKind: 'memory_correction',
      });
      const result = await h.service.listReviewable(ctx);
      expect(result.candidates).toEqual([
        expect.objectContaining({
          id: 'candidate-1',
          candidateKind: 'correction',
          workflow: expect.objectContaining({
            submittedBy: { userId: 'proposer-1', name: 'Pat Proposer' },
            assignedReviewer: { userId: USER, name: 'Riley Reviewer' },
          }),
          capabilities: {
            approve: true,
            reject: true,
            requestChanges: true,
            reassign: false,
          },
          proposal: expect.objectContaining({
            canonicalItem: expect.objectContaining({ title: 'Client Soul' }),
          }),
        }),
      ]);
      expect(h.ensureAndDescribeInTx).toHaveBeenCalled();
    });
  });

  it('withholds a candidate from an authorized but unassigned reviewer', async () => {
    await withGovernance(true, async () => {
      const h = harness({
        approveAllowed: true,
        reviewAllowed: true,
        assignedToViewer: false,
      });
      await expect(h.service.listReviewable(ctx)).resolves.toEqual({
        enabled: true,
        candidates: [],
      });
    });
  });

  it('withholds candidates and never loads their proposal bodies when unauthorized', async () => {
    await withGovernance(true, async () => {
      const h = harness({ approveAllowed: false, reviewAllowed: false });
      await expect(h.service.listReviewable(ctx)).resolves.toEqual({
        enabled: true,
        candidates: [],
      });
      expect(h.findFirst).not.toHaveBeenCalled();
      expect(h.ensureAndDescribeInTx).not.toHaveBeenCalled();
    });
  });

  it('delegates request changes to the durable workflow service', async () => {
    await withGovernance(true, async () => {
      const h = harness({ approveAllowed: true, reviewAllowed: true });
      await expect(
        h.service.requestChanges(ctx, 'candidate-1', 'Add the source.'),
      ).resolves.toMatchObject({
        status: 'changes_requested',
        feedbackReason: 'Add the source.',
      });
      expect(h.requestChanges).toHaveBeenCalledWith(ctx, 'candidate-1', 'Add the source.');
    });
  });

  it('delegates administrator reassignment to the workflow service', async () => {
    await withGovernance(true, async () => {
      const h = harness({ approveAllowed: true, reviewAllowed: true });
      await h.service.assignReviewer(ctx, 'candidate-1', 'reviewer-2', 'Coverage changed.');
      expect(h.assignReviewer).toHaveBeenCalledWith(
        ctx,
        'candidate-1',
        'reviewer-2',
        'Coverage changed.',
      );
    });
  });

  it('delegates standard approval and rejection to the generic atomic candidate path', async () => {
    await withGovernance(true, async () => {
      const h = harness({ approveAllowed: true, reviewAllowed: true });
      await expect(h.service.approve(ctx, 'candidate-1')).resolves.toEqual({
        candidateId: 'candidate-1',
        candidateKind: 'standard',
        outcome: 'activated',
        memoryId: 'memory-1',
      });
      await expect(
        h.service.reject(ctx, 'candidate-1', 'Not supported by the source.'),
      ).resolves.toEqual({
        candidateId: 'candidate-1',
        candidateKind: 'standard',
        outcome: 'rejected',
      });
      expect(h.approve).toHaveBeenCalledWith(TENANT, 'candidate-1', USER, ctx);
      expect(h.reject).toHaveBeenCalledWith(TENANT, 'candidate-1', USER, ctx);
      expect(h.assertAssignedForDecision).toHaveBeenCalledWith(ctx, 'candidate-1', 'approve');
      expect(h.assertAssignedForDecision).toHaveBeenCalledWith(ctx, 'candidate-1', 'review');
      expect(h.completeDecision).toHaveBeenCalledWith(ctx, 'candidate-1', 'approved');
      expect(h.completeDecision).toHaveBeenCalledWith(
        ctx,
        'candidate-1',
        'rejected',
        'Not supported by the source.',
      );
      expect(h.approveVersion).not.toHaveBeenCalled();
    });
  });

  it('routes immutable correction approval and rejection to the version service', async () => {
    await withGovernance(true, async () => {
      const h = harness({ sourceKind: 'memory_correction' });
      await expect(h.service.approve(ctx, 'candidate-1')).resolves.toEqual({
        candidateKind: 'correction',
        candidateId: 'candidate-1',
        outcome: 'activated',
        memoryItemId: 'item-2',
        controllingItemId: 'item-2',
      });
      await expect(
        h.service.reject(ctx, 'candidate-1', 'Source is no longer correct.'),
      ).resolves.toEqual({
        candidateKind: 'correction',
        candidateId: 'candidate-1',
        outcome: 'rejected',
      });
      expect(h.approveVersion).toHaveBeenCalledWith(ctx, 'candidate-1');
      expect(h.rejectVersion).toHaveBeenCalledWith(
        ctx,
        'candidate-1',
        'Source is no longer correct.',
      );
      expect(h.approve).not.toHaveBeenCalled();
    });
  });

  it('requires a rejection reason for every candidate kind', async () => {
    await withGovernance(true, async () => {
      const h = harness({ sourceKind: 'memory_restore' });
      await expect(h.service.reject(ctx, 'candidate-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(h.rejectVersion).not.toHaveBeenCalled();
    });
  });
});
