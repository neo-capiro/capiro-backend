import { IntelligenceController } from './intelligence.controller.js';
import type { TenantContext } from '@capiro/shared';

/**
 * GET /api/intelligence/coming-up must forward the CURRENT USER to the
 * service so meetings are scoped by ownMeetingWhere — the same ownership
 * the engagement meetings endpoint enforces.
 */

const tenantContext: TenantContext = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  tenantSlug: 'capiro',
  userId: '00000000-0000-0000-0000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
};

function makeController() {
  const service = { getComingUp: jest.fn() } as any;
  const config = { get: () => 'off' } as any;
  const controller = new IntelligenceController(
    service,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    config,
  );
  return { controller, service };
}

describe('IntelligenceController coming-up integration', () => {
  it('forwards the current user id alongside the tenant id', async () => {
    const { controller, service } = makeController();
    service.getComingUp.mockResolvedValue({ items: [], totalThisWeek: 0 });

    const result = await controller.getComingUp(tenantContext);

    expect(service.getComingUp).toHaveBeenCalledWith(
      tenantContext.tenantId,
      tenantContext.userId,
    );
    expect(result).toEqual({ items: [], totalThisWeek: 0 });
  });
});