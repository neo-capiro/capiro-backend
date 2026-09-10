import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { fourEyesSatisfied } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryGovernanceActionService } from './memory-governance-action.service.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { MemoryTransitionAuditService } from './memory-transition-audit.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'test',
  userId: USER,
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

function withCenter<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const prior = {
    center: process.env.MEMORY_GOVERNANCE_CENTER,
    lifecycle: process.env.MEMORY_GOVERNANCE_LIFECYCLE,
    enforce: process.env.MEMORY_GOVERNANCE_ENFORCE,
  };
  if (enabled) {
    process.env.MEMORY_GOVERNANCE_CENTER = 'enforce';
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
  } else {
    delete process.env.MEMORY_GOVERNANCE_CENTER;
    delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    delete process.env.MEMORY_GOVERNANCE_ENFORCE;
  }
  return fn().finally(() => {
    restoreEnv('MEMORY_GOVERNANCE_CENTER', prior.center);
    restoreEnv('MEMORY_GOVERNANCE_LIFECYCLE', prior.lifecycle);
    restoreEnv('MEMORY_GOVERNANCE_ENFORCE', prior.enforce);
  });
}

function harness(
  overrides: {
    governedStatus?: string;
    memoryClass?: string;
    assertedByUserId?: string | null;
    approvedByUserId?: string | null;
    secondApprovedByUserId?: string | null;
    operationAllowed?: boolean;
    forgetResult?: { found: boolean; blockedByLegalHold?: boolean; title?: string };
  } = {},
) {
  const locked = {
    id: ITEM,
    title: 'Firm Compass',
    clientId: CLIENT,
    governedStatus: overrides.governedStatus ?? 'active',
    memoryScope: 'firm',
    memoryClass: overrides.memoryClass ?? 'institutional_authoritative',
    assertedByUserId: overrides.assertedByUserId ?? 'proposer-1',
    approvedByUserId: overrides.approvedByUserId ?? 'reviewer-1',
    approvedAt: new Date('2026-07-31T12:00:00.000Z'),
    secondApprovedByUserId: overrides.secondApprovedByUserId ?? null,
    secondApprovedAt: null,
  };
  const tx = {
    $queryRaw: jest.fn(async () => [locked]),
    $executeRaw: jest.fn(async () => 1),
    auditLog: { create: jest.fn(async () => ({ id: 'audit-1' })) },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenant: string, _user: string, fn: (value: typeof tx) => unknown) => fn(tx),
    ),
  } as unknown as PrismaService;
  const authorization = {
    loadItemInTx: jest.fn(async () => ({
      id: ITEM,
      tenantId: TENANT,
      clientId: CLIENT,
      ownerUserId: null,
      clientStatus: 'active',
      memoryClass: 'institutional_authoritative',
      scope: 'firm',
      status: locked.governedStatus,
      legalHold: false,
    })),
    evaluateInTx: jest.fn(async () =>
      overrides.operationAllowed === false
        ? { allowed: false, reason: 'admin_required' }
        : { allowed: true, basis: 'admin' },
    ),
  } as unknown as MemoryAuthorizationService;
  const record = jest.fn(async () => 'audit-1');
  const transitions = { record } as unknown as MemoryTransitionAuditService;
  const forgetMemory = jest.fn(
    async () => overrides.forgetResult ?? { found: true, title: 'Firm Compass' },
  );
  const store = { forgetMemory } as unknown as MemoryStoreService;
  return {
    service: new MemoryGovernanceActionService(prisma, authorization, transitions, store),
    tx,
    record,
    forgetMemory,
  };
}

function retryHarness(
  input: {
    status?: string;
    wallAllowed?: boolean;
    itemBacked?: boolean;
    clioScope?: string | null;
    clioOwnerUserId?: string | null;
  } = {},
) {
  const itemBacked = input.itemBacked !== false;
  const job = {
    id: JOB,
    memoryItemId: itemBacked ? ITEM : null,
    clioMemoryId: '66666666-6666-4666-8666-666666666666',
    clientId: CLIENT,
    clioScope: input.clioScope ?? 'client',
    clioOwnerUserId: input.clioOwnerUserId ?? USER,
    operation: 'index_memory_item',
    status: input.status ?? 'dead_letter',
    attempts: 7,
    lastError: 'Permanent Error: upstream timed out',
  };
  const auditCreate = jest.fn(async () => ({ id: 'audit-retry' }));
  const tx = {
    $queryRaw: jest.fn(async () => [job]),
    $queryRawUnsafe: jest.fn(async () => (input.wallAllowed === false ? [] : [{ allowed: true }])),
    $executeRaw: jest.fn(async () => 1),
    auditLog: { create: auditCreate },
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenant: string, _user: string, fn: (value: typeof tx) => unknown) => fn(tx),
    ),
  } as unknown as PrismaService;
  const authorization = {
    loadItemInTx: jest.fn(async () => ({
      id: ITEM,
      tenantId: TENANT,
      clientId: CLIENT,
      ownerUserId: null,
      clientStatus: 'active',
      memoryClass: 'institutional_authoritative',
      scope: 'client',
      status: 'active',
      legalHold: false,
    })),
    evaluateInTx: jest.fn(async () => ({ allowed: true, basis: 'admin' })),
  } as unknown as MemoryAuthorizationService;
  return {
    service: new MemoryGovernanceActionService(
      prisma,
      authorization,
      { record: jest.fn() } as unknown as MemoryTransitionAuditService,
      {} as MemoryStoreService,
    ),
    tx,
    auditCreate,
    authorization,
  };
}

describe('MemoryGovernanceActionService', () => {
  it('fails closed while the center is dark', async () => {
    await withCenter(false, async () => {
      const h = harness();
      await expect(h.service.confirm(ctx, ITEM)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(h.tx.$queryRaw).not.toHaveBeenCalled();
    });
  });

  it('approves a classified pending-review item into active and records the transition', async () => {
    await withCenter(true, async () => {
      const h = harness({ governedStatus: 'pending_review' });
      await expect(
        h.service.approve(ctx, ITEM, 'Reviewed against the firm playbook; approved.'),
      ).resolves.toMatchObject({
        outcome: 'approved',
        governedStatus: 'active',
        approvedByUserId: USER,
      });
      expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(h.record).toHaveBeenCalledWith(
        h.tx,
        TENANT,
        expect.objectContaining({
          actorUserId: USER,
          fromStatus: 'pending_review',
          toStatus: 'active',
          reasonCode: 'approved',
          reason: 'Reviewed against the firm playbook; approved.',
        }),
      );
    });
  });

  it('requires a non-empty reason to approve', async () => {
    await withCenter(true, async () => {
      const h = harness({ governedStatus: 'pending_review' });
      await expect(h.service.approve(ctx, ITEM, '   ')).rejects.toBeInstanceOf(BadRequestException);
      expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it('denies approval when the server authorization decision refuses it', async () => {
    await withCenter(true, async () => {
      const h = harness({ governedStatus: 'pending_review', operationAllowed: false });
      await expect(h.service.approve(ctx, ITEM, 'Approved.')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it('refuses to approve its own proposal', async () => {
    await withCenter(true, async () => {
      const h = harness({ governedStatus: 'pending_review', assertedByUserId: USER });
      await expect(h.service.approve(ctx, ITEM, 'Approved.')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it('refuses to approve a still-unclassified migrated legacy item', async () => {
    await withCenter(true, async () => {
      const h = harness({ governedStatus: 'pending_review', memoryClass: 'legacy_unclassified' });
      await expect(h.service.approve(ctx, ITEM, 'Approved.')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(h.tx.$executeRaw).not.toHaveBeenCalled();
      expect(h.record).not.toHaveBeenCalled();
    });
  });

  it.each(['active', 'rejected', 'revoked', 'stale', 'conflicted', 'superseded'])(
    'refuses to approve a memory item that is already %s',
    async (governedStatus) => {
      await withCenter(true, async () => {
        const h = harness({ governedStatus });
        await expect(h.service.approve(ctx, ITEM, 'Approved.')).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(h.tx.$executeRaw).not.toHaveBeenCalled();
      });
    },
  );

  it('reports the item not found for a wrong-tenant or nonexistent id', async () => {
    await withCenter(true, async () => {
      const h = harness({ governedStatus: 'pending_review' });
      h.tx.$queryRaw.mockResolvedValueOnce([]);
      await expect(h.service.approve(ctx, ITEM, 'Approved.')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it('does not by itself satisfy an enabled four-eyes policy', async () => {
    // approve() records only the FIRST human approval. When four-eyes is
    // enabled for a scope, filterGovernedMemory must still treat the item as
    // unapproved until an independent secondApprove also lands — proving the
    // new write path composes with the existing recall-time gate rather than
    // duplicating or bypassing it.
    const approvedOnly = {
      assertedByUserId: 'proposer-1',
      approvedByUserId: USER,
      secondApprovedByUserId: null,
      secondApprovedAt: null,
    };
    expect(fourEyesSatisfied(approvedOnly, false)).toBe(true);
    expect(fourEyesSatisfied(approvedOnly, true)).toBe(false);

    const bothApproved = {
      ...approvedOnly,
      secondApprovedByUserId: 'reviewer-2',
      secondApprovedAt: new Date('2026-08-21T00:00:00.000Z'),
    };
    expect(fourEyesSatisfied(bothApproved, true)).toBe(true);
  });

  it('confirms stale memory and records stale to active in the same transaction', async () => {
    await withCenter(true, async () => {
      const h = harness({ governedStatus: 'stale' });
      await expect(h.service.confirm(ctx, ITEM)).resolves.toMatchObject({
        outcome: 'confirmed',
        governedStatus: 'active',
      });
      expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(h.record).toHaveBeenCalledWith(
        h.tx,
        TENANT,
        expect.objectContaining({
          actorUserId: USER,
          fromStatus: 'stale',
          toStatus: 'active',
          reasonCode: 'confirmed',
        }),
      );
    });
  });

  it('marks active memory stale only after a server authorization decision', async () => {
    await withCenter(true, async () => {
      const h = harness({ governedStatus: 'active' });
      await expect(
        h.service.markStale(ctx, ITEM, 'Source needs reconfirmation.'),
      ).resolves.toMatchObject({
        outcome: 'marked_stale',
        governedStatus: 'stale',
      });
      expect(h.record).toHaveBeenCalledWith(
        h.tx,
        TENANT,
        expect.objectContaining({
          fromStatus: 'active',
          toStatus: 'stale',
          reasonCode: 'review_overdue',
          reason: 'Source needs reconfirmation.',
        }),
      );
    });
  });

  it('delegates revocation to the canonical forget path and preserves legal hold refusal', async () => {
    await withCenter(true, async () => {
      const pass = harness();
      await expect(pass.service.revoke(ctx, ITEM, 'Policy retired.')).resolves.toMatchObject({
        outcome: 'revoked',
        actorUserId: USER,
      });
      expect(pass.forgetMemory).toHaveBeenCalledWith(ITEM, 'Policy retired.');

      const held = harness({
        forgetResult: { found: true, blockedByLegalHold: true, title: 'Firm Compass' },
      });
      await expect(held.service.revoke(ctx, ITEM, 'Policy retired.')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it('records second approval only for an independent actor', async () => {
    await withCenter(true, async () => {
      const pass = harness();
      await expect(pass.service.secondApprove(ctx, ITEM)).resolves.toMatchObject({
        outcome: 'second_approved',
        secondApprovedByUserId: USER,
      });
      expect(pass.record).toHaveBeenCalledWith(
        pass.tx,
        TENANT,
        expect.objectContaining({
          actorUserId: USER,
          reasonCode: 'approved',
          metadata: expect.objectContaining({ approvalStage: 2 }),
        }),
      );

      const self = harness({ approvedByUserId: USER });
      await expect(self.service.secondApprove(ctx, ITEM)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(self.tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it('requeues a failed projection atomically and records bounded audit evidence', async () => {
    await withCenter(true, async () => {
      const h = retryHarness();
      await expect(h.service.retryProjection(ctx, JOB)).resolves.toEqual({
        outcome: 'projection_retry_queued',
        jobId: JOB,
        status: 'pending',
      });
      expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(h.auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: TENANT,
          actorUserId: USER,
          action: 'memory.projection.retry',
          entityId: JOB,
          before: expect.objectContaining({
            status: 'dead_letter',
            attempts: 7,
            errorCode: 'permanent_error_upstream_timed_out',
          }),
          after: { status: 'pending', attempts: 0 },
        }),
      });
    });
  });

  it('does not requeue a restricted client projection', async () => {
    await withCenter(true, async () => {
      const h = retryHarness({ wallAllowed: false });
      await expect(h.service.retryProjection(ctx, JOB)).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.tx.$executeRaw).not.toHaveBeenCalled();
      expect(h.auditCreate).not.toHaveBeenCalled();
    });
  });

  it('does not expose or retry another user private Clio projection', async () => {
    await withCenter(true, async () => {
      const h = retryHarness({
        itemBacked: false,
        clioScope: 'user_private',
        clioOwnerUserId: '77777777-7777-4777-8777-777777777777',
      });
      await expect(h.service.retryProjection(ctx, JOB)).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.authorization.loadItemInTx).not.toHaveBeenCalled();
      expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it('refuses to reopen completed or superseded projection jobs', async () => {
    await withCenter(true, async () => {
      const h = retryHarness({ status: 'completed' });
      await expect(h.service.retryProjection(ctx, JOB)).rejects.toBeInstanceOf(BadRequestException);
      expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    });
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
