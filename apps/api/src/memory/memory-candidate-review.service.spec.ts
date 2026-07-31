import { describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import type { MemoryCandidateService } from './memory-candidate.service.js';
import { MemoryCandidateReviewService } from './memory-candidate-review.service.js';

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
  const priorLifecycle = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  const priorEnforce = process.env.MEMORY_GOVERNANCE_ENFORCE;
  if (enabled) {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  } else {
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;
  }
  return fn().finally(() => {
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
}) {
  const scope = input.scope ?? 'client';
  const row = {
    id: 'candidate-1',
    clientId: scope === 'client' ? CLIENT : null,
    proposedBy: 'proposer-1',
    sourceKind: 'settings_sections',
    scope,
    createdAt: new Date('2026-07-31T12:00:00.000Z'),
    payloadJsonb: {
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
    },
  };
  const tx = {
    memoryCandidate: {
      findMany: jest.fn(async () => [row]),
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
  return {
    service: new MemoryCandidateReviewService(prisma, authorization, candidates),
    approve,
    reject,
    authorization,
    tx,
  };
}

describe('MemoryCandidateReviewService', () => {
  it('stays dark until lifecycle and authorization are both explicitly armed', async () => {
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

  it('shows a client candidate to a standard user with an approve grant', async () => {
    await withGovernance(true, async () => {
      const h = harness({ approveAllowed: true, reviewAllowed: false });
      const result = await h.service.listReviewable(ctx);
      expect(result.enabled).toBe(true);
      expect(result.candidates).toEqual([
        expect.objectContaining({
          id: 'candidate-1',
          scope: 'client',
          clientId: CLIENT,
          capabilities: { approve: true, reject: false },
          proposal: expect.objectContaining({
            canonicalItem: expect.objectContaining({ title: 'Client Soul' }),
          }),
        }),
      ]);
    });
  });

  it('withholds candidates for which the server grants neither review nor approval', async () => {
    await withGovernance(true, async () => {
      const h = harness({ approveAllowed: false, reviewAllowed: false });
      await expect(h.service.listReviewable(ctx)).resolves.toEqual({
        enabled: true,
        candidates: [],
      });
    });
  });

  it('delegates approval and rejection with the exact server-resolved context', async () => {
    await withGovernance(true, async () => {
      const h = harness({ approveAllowed: true, reviewAllowed: true });
      await expect(h.service.approve(ctx, 'candidate-1')).resolves.toEqual({
        memoryId: 'memory-1',
      });
      await expect(h.service.reject(ctx, 'candidate-1')).resolves.toBeUndefined();
      expect(h.approve).toHaveBeenCalledWith(TENANT, 'candidate-1', USER, ctx);
      expect(h.reject).toHaveBeenCalledWith(TENANT, 'candidate-1', USER, ctx);
    });
  });
});
