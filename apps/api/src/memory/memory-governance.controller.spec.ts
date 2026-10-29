import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { MemoryGovernanceService } from './memory-governance.service.js';
import {
  MemoryGovernanceController,
  normalizeMemoryGovernanceBucket,
} from './memory-governance.controller.js';

const VERSION = 'mv1:123:' + 'a'.repeat(32);
const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

describe('MemoryGovernanceController', () => {
  it.each([
    'approve',
    'confirm',
    'markStale',
    'revoke',
    'secondApprove',
    'retryProjection',
  ] as const)('requires a server-observed version for %s', async (action) => {
    const controller = new MemoryGovernanceController({} as MemoryGovernanceService);
    for (const value of [undefined, '', '1', 'mv1:123:wrong']) {
      const body = { reason: 'Reviewed.', expectedVersion: value as unknown as string };
      await expect(controller[action](ctx, 'item-1', body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('is administrator-only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MemoryGovernanceController)).toEqual(['user_admin']);
  });

  it('accepts only the controlled bucket vocabulary', () => {
    expect(normalizeMemoryGovernanceBucket(undefined)).toBe('all');
    expect(normalizeMemoryGovernanceBucket('review_due')).toBe('review_due');
    expect(() => normalizeMemoryGovernanceBucket('restricted-client')).toThrow(BadRequestException);
  });

  it('delegates only server context, ids, and bounded user reasons', async () => {
    const governance = {
      overview: jest.fn(async () => ({ enabled: true })),
      listItems: jest.fn(async () => ({ enabled: true, items: [] })),
      getItem: jest.fn(async () => ({ enabled: true, item: { id: 'item-1' } })),
      listTransitions: jest.fn(async () => ({ enabled: true, transitions: [] })),
      projectionHealth: jest.fn(async () => ({ enabled: true, counts: {} })),
      getProjectionJob: jest.fn(async () => ({ enabled: true, job: { id: 'job-1' } })),
      retryProjection: jest.fn(async () => ({ outcome: 'projection_retry_queued' })),
      listClients: jest.fn(async () => ({ enabled: true, clients: [] })),
      approve: jest.fn(async () => ({ outcome: 'approved' })),
      confirm: jest.fn(async () => ({ outcome: 'confirmed' })),
      markStale: jest.fn(async () => ({ outcome: 'marked_stale' })),
      revoke: jest.fn(async () => ({ outcome: 'revoked' })),
      secondApprove: jest.fn(async () => ({ outcome: 'second_approved' })),
    } as unknown as MemoryGovernanceService;
    const controller = new MemoryGovernanceController(governance);

    await controller.overview(ctx);
    await controller.listItems(ctx, 'active', '25');
    await controller.listItems(ctx, 'active', '25', 'crm_finding_accepted');
    await controller.getItem(ctx, 'item-1');
    await controller.listTransitions(ctx, '50');
    await controller.projectionHealth(ctx);
    await controller.getProjectionJob(ctx, 'job-1');
    await controller.retryProjection(ctx, 'job-1', { expectedVersion: VERSION });
    await controller.listClients(ctx);
    await controller.approve(ctx, 'item-1', {
      expectedVersion: VERSION,
      reason: 'Reviewed and approved as firm identity.',
    });
    await controller.confirm(ctx, 'item-1', { expectedVersion: VERSION });
    await controller.markStale(ctx, 'item-1', {
      expectedVersion: VERSION,
      reason: 'Needs reconfirmation.',
    });
    await controller.revoke(ctx, 'item-1', {
      expectedVersion: VERSION,
      reason: 'No longer applicable.',
    });
    await controller.secondApprove(ctx, 'item-1', { expectedVersion: VERSION });

    expect(governance.overview).toHaveBeenCalledWith(ctx);
    expect(governance.listItems).toHaveBeenCalledWith(ctx, 'active', 25, undefined, undefined);
    expect(governance.listItems).toHaveBeenCalledWith(
      ctx,
      'active',
      25,
      'crm_finding_accepted',
      undefined,
    );
    expect(governance.getItem).toHaveBeenCalledWith(ctx, 'item-1');
    expect(governance.listTransitions).toHaveBeenCalledWith(ctx, 50, undefined);
    expect(governance.projectionHealth).toHaveBeenCalledWith(ctx);
    expect(governance.getProjectionJob).toHaveBeenCalledWith(ctx, 'job-1');
    expect(governance.retryProjection).toHaveBeenCalledWith(ctx, 'job-1', VERSION);
    expect(governance.listClients).toHaveBeenCalledWith(ctx);
    expect(governance.approve).toHaveBeenCalledWith(
      ctx,
      'item-1',
      'Reviewed and approved as firm identity.',
      VERSION,
    );
    expect(governance.confirm).toHaveBeenCalledWith(ctx, 'item-1', VERSION);
    expect(governance.markStale).toHaveBeenCalledWith(
      ctx,
      'item-1',
      'Needs reconfirmation.',
      VERSION,
    );
    expect(governance.revoke).toHaveBeenCalledWith(ctx, 'item-1', 'No longer applicable.', VERSION);
    expect(governance.secondApprove).toHaveBeenCalledWith(ctx, 'item-1', VERSION);
  });
});
