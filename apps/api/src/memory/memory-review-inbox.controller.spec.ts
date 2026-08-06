import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { MemoryReviewInboxService } from './memory-review-inbox.service.js';
import { MemoryReviewInboxController } from './memory-review-inbox.controller.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user',
  role: 'standard_user',
};

describe('MemoryReviewInboxController', () => {
  it('delegates body-free lists, protected detail, and recipient read state', async () => {
    const list = jest.fn(async () => ({
      enabled: true,
      view: 'needs_my_review',
      items: [],
      nextCursor: null,
    }));
    const summary = jest.fn(async () => ({
      enabled: true,
      counts: {},
      truncated: false,
    }));
    const detail = jest.fn(async () => ({ candidateId: 'candidate' }));
    const detailByReviewRequest = jest.fn(async () => ({
      reviewRequestId: 'request',
    }));
    const listNotifications = jest.fn(async () => ({
      enabled: true,
      items: [],
      nextCursor: null,
    }));
    const unreadNotificationCount = jest.fn(async () => ({
      enabled: true,
      count: 0,
    }));
    const markNotificationRead = jest.fn(async () => undefined);
    const markAllNotificationsRead = jest.fn(async () => 2);
    const controller = new MemoryReviewInboxController({
      list,
      summary,
      detail,
      detailByReviewRequest,
      listNotifications,
      unreadNotificationCount,
      markNotificationRead,
      markAllNotificationsRead,
    } as unknown as MemoryReviewInboxService);

    await controller.list(ctx, 'history', 'cursor', '10');
    await controller.summary(ctx);
    await controller.detail(ctx, '33333333-3333-4333-8333-333333333333');
    await controller.detailByRequest(
      ctx,
      '44444444-4444-4444-8444-444444444444',
    );
    await controller.notifications(ctx, 'cursor', '10');
    await controller.unreadCount(ctx);
    await controller.readOne(ctx, '55555555-5555-4555-8555-555555555555');
    await expect(controller.readAll(ctx)).resolves.toEqual({ ok: true, updated: 2 });

    expect(list).toHaveBeenCalledWith(ctx, {
      view: 'history',
      cursor: 'cursor',
      limit: '10',
    });
    expect(detailByReviewRequest).toHaveBeenCalledWith(
      ctx,
      '44444444-4444-4444-8444-444444444444',
    );
    expect(markNotificationRead).toHaveBeenCalledWith(
      ctx,
      '55555555-5555-4555-8555-555555555555',
    );
  });
});
