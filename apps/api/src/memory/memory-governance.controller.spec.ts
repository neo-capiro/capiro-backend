import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { MemoryGovernanceService } from './memory-governance.service.js';
import {
  MemoryGovernanceController,
  normalizeMemoryGovernanceBucket,
} from './memory-governance.controller.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_admin',
  role: 'user_admin',
};

describe('MemoryGovernanceController', () => {
  it('is administrator-only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MemoryGovernanceController)).toEqual(['user_admin']);
  });

  it('accepts only the controlled bucket vocabulary', () => {
    expect(normalizeMemoryGovernanceBucket(undefined)).toBe('all');
    expect(normalizeMemoryGovernanceBucket('review_due')).toBe('review_due');
    expect(() => normalizeMemoryGovernanceBucket('restricted-client')).toThrow(
      BadRequestException,
    );
  });

  it('delegates only server context, ids, and bounded user reasons', async () => {
    const governance = {
      overview: jest.fn(async () => ({ enabled: true })),
      listItems: jest.fn(async () => ({ enabled: true, items: [] })),
      getItem: jest.fn(async () => ({ enabled: true, item: { id: 'item-1' } })),
      listTransitions: jest.fn(async () => ({ enabled: true, transitions: [] })),
      projectionHealth: jest.fn(async () => ({ enabled: true, counts: {} })),
      retryProjection: jest.fn(async () => ({ outcome: 'projection_retry_queued' })),
      listClients: jest.fn(async () => ({ enabled: true, clients: [] })),
      confirm: jest.fn(async () => ({ outcome: 'confirmed' })),
      markStale: jest.fn(async () => ({ outcome: 'marked_stale' })),
      revoke: jest.fn(async () => ({ outcome: 'revoked' })),
      secondApprove: jest.fn(async () => ({ outcome: 'second_approved' })),
    } as unknown as MemoryGovernanceService;
    const controller = new MemoryGovernanceController(governance);

    await controller.overview(ctx);
    await controller.listItems(ctx, 'active', '25');
    await controller.getItem(ctx, 'item-1');
    await controller.listTransitions(ctx, '50');
    await controller.projectionHealth(ctx);
    await controller.retryProjection(ctx, 'job-1');
    await controller.listClients(ctx);
    await controller.confirm(ctx, 'item-1');
    await controller.markStale(ctx, 'item-1', { reason: 'Needs reconfirmation.' });
    await controller.revoke(ctx, 'item-1', { reason: 'No longer applicable.' });
    await controller.secondApprove(ctx, 'item-1');

    expect(governance.overview).toHaveBeenCalledWith(ctx);
    expect(governance.listItems).toHaveBeenCalledWith(ctx, 'active', 25);
    expect(governance.getItem).toHaveBeenCalledWith(ctx, 'item-1');
    expect(governance.listTransitions).toHaveBeenCalledWith(ctx, 50);
    expect(governance.projectionHealth).toHaveBeenCalledWith(ctx);
    expect(governance.retryProjection).toHaveBeenCalledWith(ctx, 'job-1');
    expect(governance.listClients).toHaveBeenCalledWith(ctx);
    expect(governance.confirm).toHaveBeenCalledWith(ctx, 'item-1');
    expect(governance.markStale).toHaveBeenCalledWith(
      ctx,
      'item-1',
      'Needs reconfirmation.',
    );
    expect(governance.revoke).toHaveBeenCalledWith(ctx, 'item-1', 'No longer applicable.');
    expect(governance.secondApprove).toHaveBeenCalledWith(ctx, 'item-1');
  });
});
