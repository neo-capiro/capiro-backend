import { FeedController } from './feed.controller.js';

jest.mock('../auth/tenant.guard.js', () => ({ TenantGuard: class {} }));
jest.mock('./tracker-v2.guard.js', () => ({ TrackerV2Guard: class {} }));
jest.mock('./feed.service.js', () => ({ FeedService: class {}, RECOGNISED_WORK_FILTERS: ['all'] }));

describe('Bill 360 event history source family', () => {
  it.each([
    ['119-hr-1', 'bill'],
    ['ca-2026-ab1', 'state_bill'],
    ['tx-2025x1-hb1', 'state_bill'],
  ])('reads %s from the %s feed while retaining scope and pagination', async (billId, sourceType) => {
    const page = { items: [{ id: 'event-1' }], hasMore: true, nextCursor: 'next' };
    const getFeed = jest.fn().mockResolvedValue(page);
    const controller = new FeedController({ getFeed } as never);
    const response = await controller.getBillEvents(
      { tenantId: 'tenant-a', clerkUserId: 'user-a' } as never,
      'client-a', billId, 'critical', 'reviewed',
      '2026-09-01T00:00:00Z', '2026-09-06T00:00:00Z', 'date', 'cursor-1', '25',
    );
    expect(getFeed).toHaveBeenCalledWith('tenant-a', 'client-a', {
      sourceTypes: [sourceType], sourceRef: billId,
      severities: ['critical'], statuses: ['reviewed'],
      since: new Date('2026-09-01T00:00:00Z'), until: new Date('2026-09-06T00:00:00Z'),
      order: 'date', cursor: 'cursor-1', limit: 25,
      userId: undefined, workStates: undefined,
    });
    expect(response).toBe(page);
  });
});
