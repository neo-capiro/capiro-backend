import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryGovernanceActionService } from './memory-governance-action.service.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { MemoryTransitionAuditService } from './memory-transition-audit.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';

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

function harness(overrides: {
  governedStatus?: string;
  assertedByUserId?: string | null;
  approvedByUserId?: string | null;
  secondApprovedByUserId?: string | null;
  operationAllowed?: boolean;
  forgetResult?: { found: boolean; blockedByLegalHold?: boolean; title?: string };
} = {}) {
  const locked = {
    id: ITEM,
    title: 'Firm Compass',
    clientId: CLIENT,
    governedStatus: overrides.governedStatus ?? 'active',
    memoryScope: 'firm',
    assertedByUserId: overrides.assertedByUserId ?? 'proposer-1',
    approvedByUserId: overrides.approvedByUserId ?? 'reviewer-1',
    approvedAt: new Date('2026-07-31T12:00:00.000Z'),
    secondApprovedByUserId: overrides.secondApprovedByUserId ?? null,
    secondApprovedAt: null,
  };
  const tx = {
    $queryRaw: jest.fn(async () => [locked]),
    $executeRaw: jest.fn(async () => 1),
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, fn: (value: typeof tx) => unknown) =>
      fn(tx),
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
  const forgetMemory = jest.fn(async () => overrides.forgetResult ?? { found: true, title: 'Firm Compass' });
  const store = { forgetMemory } as unknown as MemoryStoreService;
  return {
    service: new MemoryGovernanceActionService(prisma, authorization, transitions, store),
    tx,
    record,
    forgetMemory,
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
      await expect(h.service.markStale(ctx, ITEM, 'Source needs reconfirmation.')).resolves.toMatchObject({
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
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
