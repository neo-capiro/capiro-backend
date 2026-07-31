import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfig } from '../config/config.schema.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import type { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSER = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const CANDIDATE = '55555555-5555-4555-8555-555555555555';

const proposerCtx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: PROPOSER,
  clerkUserId: 'user_proposer',
  role: 'standard_user',
};

const reviewerCtx: TenantContext = {
  ...proposerCtx,
  userId: REVIEWER,
  clerkUserId: 'user_reviewer',
};

function withReviewSurface<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const prior = {
    lifecycle: process.env.MEMORY_GOVERNANCE_LIFECYCLE,
    enforce: process.env.MEMORY_GOVERNANCE_ENFORCE,
    review: process.env.MEMORY_CLIENT_REVIEW,
  };
  if (enabled) {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
    process.env.MEMORY_CLIENT_REVIEW = 'enforce';
  } else {
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    delete process.env.MEMORY_CLIENT_REVIEW;
  }
  return fn().finally(() => {
    if (prior.lifecycle === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = prior.lifecycle;
    if (prior.enforce === undefined) delete process.env.MEMORY_GOVERNANCE_ENFORCE;
    else process.env.MEMORY_GOVERNANCE_ENFORCE = prior.enforce;
    if (prior.review === undefined) delete process.env.MEMORY_CLIENT_REVIEW;
    else process.env.MEMORY_CLIENT_REVIEW = prior.review;
  });
}

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as { raw?: string[] }).raw)
    ? (strings as { raw: string[] }).raw.join('?')
    : String(strings);
}

function harness(options: {
  proposedBy?: string;
  scope?: 'firm' | 'client';
  wallAllowed?: boolean;
  reviewerAllowed?: boolean;
} = {}) {
  const state = {
    status: 'pending',
    governedStatus: 'pending_review',
    proposedBy: options.proposedBy ?? PROPOSER,
    scope: options.scope ?? 'client',
    clientId: options.scope === 'firm' ? null : CLIENT,
    sourceKind: 'settings_sections',
    decidedBy: null as string | null,
  };
  const audits: Array<Record<string, unknown>> = [];
  const payload = {
    key: 'settings-file:client-soul:client-1',
    value: 'proposed value',
    canonicalItem: null,
  };
  const findFirst = jest.fn(async () => ({ payload }));

  const tx = {
    memoryCandidate: {
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        state.status = String(args.data.status ?? state.status);
        state.governedStatus = String(args.data.governedStatus ?? state.governedStatus);
        state.decidedBy = (args.data.decidedBy as string | null) ?? state.decidedBy;
        return {};
      }),
      findMany: jest.fn(async () =>
        state.status === 'pending'
          ? [
              {
                id: CANDIDATE,
                clientId: state.clientId,
                proposedBy: state.proposedBy,
                sourceKind: state.sourceKind,
                scope: state.scope,
                createdAt: new Date('2026-07-31T12:00:00.000Z'),
              },
            ]
          : [],
      ),
      findFirst,
    },
    memoryTransitionAudit: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return { id: `audit-${audits.length}` };
      }),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      if (/FOR UPDATE/i.test(sql)) {
        return state.status === 'pending'
          ? [
              {
                id: CANDIDATE,
                proposedBy: state.proposedBy,
                scope: state.scope,
                sourceKind: state.sourceKind,
                clientId: state.clientId,
              },
            ]
          : [];
      }
      if (/governed_status/i.test(sql)) {
        return [
          {
            scope: state.scope,
            source_kind: state.sourceKind,
            client_id: state.clientId,
            governed_status: state.governedStatus,
            expires_at: null,
          },
        ];
      }
      return [];
    }),
    $queryRawUnsafe: jest.fn(async () =>
      options.wallAllowed === false ? [] : [{ allowed: true }],
    ),
  };

  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, fn: (value: typeof tx) => unknown) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
  const authorization = {
    loadCandidateInTx: jest.fn(async () => ({
      id: CANDIDATE,
      tenantId: TENANT,
      clientId: state.clientId,
      ownerUserId: state.proposedBy,
      proposedByUserId: state.proposedBy,
      memoryClass: state.scope === 'client' ? 'client_steering' : 'institutional_authoritative',
      scope: state.scope,
      status: 'pending_review',
      legalHold: false,
      clientStatus: state.scope === 'client' ? 'active' : null,
    })),
    evaluateInTx: jest.fn(async () =>
      options.reviewerAllowed === false
        ? { allowed: false, reason: 'missing_grant' }
        : { allowed: true, basis: 'explicit_grant' },
    ),
  } as unknown as MemoryAuthorizationService;

  const service = new GovernedMemoryCandidateService(
    prisma,
    {} as MemoryIngestService,
    { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
    new MemoryTransitionAuditService(),
    {} as MemoryCleanupOutboxService,
    authorization,
  );

  return { service, state, audits, tx, authorization, findFirst };
}

describe('GovernedMemoryCandidateService Phase 13 dispositions', () => {
  it('lets the proposer withdraw atomically with distinct status and audit reason', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await expect(h.service.withdraw(proposerCtx, CANDIDATE)).resolves.toBeUndefined();
      expect(h.state).toMatchObject({
        status: 'withdrawn',
        governedStatus: 'rejected',
        decidedBy: PROPOSER,
      });
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]).toMatchObject({
        reasonCode: 'withdrawn_by_proposer',
        actorUserId: PROPOSER,
        fromStatus: 'pending_review',
        toStatus: 'rejected',
      });
      expect(JSON.stringify(h.audits)).not.toContain('proposed value');
    });
  });

  it('denies withdrawal by anybody other than the proposer', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await expect(h.service.withdraw(reviewerCtx, CANDIDATE)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.state.status).toBe('pending');
      expect(h.audits).toHaveLength(0);
    });
  });

  it('forces an admin or granted proposer to use withdraw instead of reviewer rejection', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await expect(
        h.service.reject(TENANT, CANDIDATE, PROPOSER, proposerCtx),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.authorization.evaluateInTx).not.toHaveBeenCalled();
      expect(h.state.status).toBe('pending');
    });
  });

  it('lets an independent authorized reviewer reject with a distinct audit reason', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await expect(
        h.service.reject(TENANT, CANDIDATE, REVIEWER, reviewerCtx),
      ).resolves.toBeUndefined();
      expect(h.state.status).toBe('rejected');
      expect(h.audits[0]).toMatchObject({
        reasonCode: 'rejected_by_reviewer',
        actorUserId: REVIEWER,
      });
    });
  });

  it('cannot withdraw a terminal candidate twice', async () => {
    await withReviewSurface(true, async () => {
      const h = harness();
      await h.service.withdraw(proposerCtx, CANDIDATE);
      await expect(h.service.withdraw(proposerCtx, CANDIDATE)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.audits).toHaveLength(1);
    });
  });

  it('redacts a walled proposal body but still lets its proposer withdraw it', async () => {
    await withReviewSurface(true, async () => {
      const h = harness({ wallAllowed: false });
      const listed = await h.service.listOwnPending(proposerCtx);
      expect(listed).toEqual({
        enabled: true,
        candidates: [
          expect.objectContaining({
            id: CANDIDATE,
            restricted: true,
            proposal: null,
            capabilities: { withdraw: true },
          }),
        ],
      });
      expect(h.findFirst).not.toHaveBeenCalled();
      await expect(h.service.withdraw(proposerCtx, CANDIDATE)).resolves.toBeUndefined();
    });
  });

  it('stays dark and mutation-free until the review surface is explicitly armed', async () => {
    await withReviewSurface(false, async () => {
      const h = harness();
      await expect(h.service.listOwnPending(proposerCtx)).resolves.toEqual({
        enabled: false,
        candidates: [],
      });
      await expect(h.service.withdraw(proposerCtx, CANDIDATE)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(h.tx.memoryCandidate.update).not.toHaveBeenCalled();
    });
  });
});
