import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryReviewRevisionService } from './memory-review-revision.service.js';
import type { MemoryReviewWorkflowService } from './memory-review-workflow.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSER = '22222222-2222-4222-8222-222222222222';
const PREDECESSOR = '33333333-3333-4333-8333-333333333333';
const SUCCESSOR = '44444444-4444-4444-8444-444444444444';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: PROPOSER,
  clerkUserId: 'proposer',
  role: 'user_admin',
};

const source = {
  id: PREDECESSOR,
  clientId: null,
  proposedBy: PROPOSER,
  sourceKind: 'settings_sections',
  scope: 'firm',
  payload: {
    key: 'settings-file:firm-soul:firm',
    value: '[{"key":"mission","body":"Original"}]',
    source: 'settings_memory_editor',
    scope: 'firm',
    ownerUserId: null,
    clientId: null,
    canonicalItem: {
      type: 'firm-soul',
      slug: 'firm',
      title: 'Firm Soul',
      sections: [
        { key: 'mission', heading: 'Mission', owner: 'human', body: 'Original' },
      ],
    },
  },
  provenance: { tool: 'save_memory', tenantId: TENANT, userId: PROPOSER },
};

const subject = {
  id: PREDECESSOR,
  tenantId: TENANT,
  clientId: null,
  ownerUserId: PROPOSER,
  proposedByUserId: PROPOSER,
  memoryClass: 'institutional_authoritative' as const,
  scope: 'firm' as const,
  status: 'pending_review',
  legalHold: false,
  clientStatus: null,
};

const workflowSnapshot = {
  requestId: '55555555-5555-4555-8555-555555555555',
  status: 'pending' as const,
  submittedBy: { userId: PROPOSER, name: 'Pat Proposer' },
  assignedReviewer: {
    userId: '66666666-6666-4666-8666-666666666666',
    name: 'Riley Reviewer',
  },
  decidedBy: null,
  feedbackReason: null,
  createdAt: '2026-08-06T04:00:00.000Z',
  decidedAt: null,
  viewerIsSubmitter: true,
  viewerIsAssignedReviewer: false,
  capabilities: { requestChanges: false, reassign: true },
};

function harness(input: {
  proposedBy?: string;
  allowed?: boolean;
  functionError?: Error;
} = {}) {
  const sourceRow = { ...source, proposedBy: input.proposedBy ?? source.proposedBy };
  const queryRaw = jest
    .fn<(...args: unknown[]) => Promise<unknown[]>>()
    .mockResolvedValueOnce([sourceRow])
    .mockImplementationOnce(async () => {
      if (input.functionError) throw input.functionError;
      return [
        {
          candidate_id: SUCCESSOR,
          root_candidate_id: PREDECESSOR,
          candidate_revision_number: 2,
        },
      ];
    });
  const auditCreate = jest.fn(async () => ({}));
  const tx = { $queryRaw: queryRaw, auditLog: { create: auditCreate } };
  const prisma = {
    withTenantUser: jest.fn(
      async (
        _tenantId: string,
        _userId: string,
        work: (value: typeof tx) => unknown,
      ) => work(tx),
    ),
  } as unknown as PrismaService;
  const loadCandidateInTx = jest
    .fn<(...args: unknown[]) => Promise<typeof subject>>()
    .mockResolvedValueOnce(subject)
    .mockResolvedValueOnce({ ...subject, id: SUCCESSOR });
  const evaluateInTx = jest.fn(async () =>
    input.allowed === false
      ? ({ allowed: false as const, reason: 'ethical_wall' as const })
      : ({ allowed: true as const, basis: 'tenant_read' as const }),
  );
  const authorization = {
    loadCandidateInTx,
    evaluateInTx,
  } as unknown as MemoryAuthorizationService;
  const ensureAndDescribeInTx = jest.fn(async () => workflowSnapshot);
  const workflow = { ensureAndDescribeInTx } as unknown as MemoryReviewWorkflowService;
  return {
    service: new MemoryReviewRevisionService(prisma, authorization, workflow),
    queryRaw,
    auditCreate,
    evaluateInTx,
    ensureAndDescribeInTx,
  };
}

const revisedSections = [
  { key: 'mission', heading: 'Mission', owner: 'human' as const, body: 'Revised mission.' },
];

describe('MemoryReviewRevisionService', () => {
  it('creates one immutable successor, preserves active memory, and opens fresh review', async () => {
    const h = harness();
    const result = await h.service.revise(ctx, PREDECESSOR, { sections: revisedSections });

    expect(result).toMatchObject({
      predecessorCandidateId: PREDECESSOR,
      candidateId: SUCCESSOR,
      rootCandidateId: PREDECESSOR,
      revisionNumber: 2,
      activeMemoryUnchanged: true,
      workflow: { status: 'pending', assignedReviewer: { name: 'Riley Reviewer' } },
    });
    expect(h.evaluateInTx).toHaveBeenCalledWith(expect.anything(), ctx, subject, 'propose');
    expect(h.ensureAndDescribeInTx).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.objectContaining({
        id: SUCCESSOR,
        proposedByUserId: PROPOSER,
        sourceKind: 'settings_sections',
        title: 'Firm Soul',
      }),
      expect.objectContaining({ id: SUCCESSOR }),
    );
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'memory.review.revision_submitted',
        entityId: SUCCESSOR,
        after: expect.objectContaining({
          predecessorCandidateId: PREDECESSOR,
          revisionNumber: 2,
          sectionBodiesChanged: 1,
          payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    });
    expect(JSON.stringify(h.auditCreate.mock.calls[0]?.[0])).not.toContain('Revised mission.');
  });

  it('rejects anybody other than the original proposer before cloning', async () => {
    const h = harness({ proposedBy: '77777777-7777-4777-8777-777777777777' });
    await expect(
      h.service.revise(ctx, PREDECESSOR, { sections: revisedSections }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.evaluateInTx).not.toHaveBeenCalled();
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates wall and client-status policy before resubmission', async () => {
    const h = harness({ allowed: false });
    await expect(
      h.service.revise(ctx, PREDECESSOR, { sections: revisedSections }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('maps concurrent successor and stale-workflow races to stable conflicts', async () => {
    for (const error of [
      new Error('MEMORY_REVISION_SUCCESSOR_EXISTS'),
      new Error('MEMORY_REVISION_CHANGES_NOT_REQUESTED'),
    ]) {
      const h = harness({ functionError: error });
      await expect(
        h.service.revise(ctx, PREDECESSOR, { sections: revisedSections }),
      ).rejects.toBeInstanceOf(ConflictException);
    }
  });
});
