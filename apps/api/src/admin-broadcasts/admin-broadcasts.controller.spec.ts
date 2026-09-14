import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { AdminBroadcastsService } from './admin-broadcasts.service.js';
import { AdminBroadcastsController } from './admin-broadcasts.controller.js';
import { MeBroadcastsController } from './me-broadcasts.controller.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const B1 = '66666666-6666-4666-8666-666666666666';

const staff: TenantContext = {
  tenantId: '99999999-9999-4999-8999-999999999999',
  tenantSlug: 'capiro-internal',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_admin',
  role: 'capiro_admin',
};

const member: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'acme',
  userId: '33333333-3333-4333-8333-333333333333',
  clerkUserId: 'user_u1',
  role: 'client_portal_user',
};

function makeService() {
  return {
    listTenantMembers: jest.fn(async () => []),
    listBroadcasts: jest.fn(async () => []),
    createBroadcast: jest.fn(async () => ({ id: B1 })),
    getBroadcast: jest.fn(async () => ({ id: B1 })),
    archiveBroadcast: jest.fn(async () => ({ id: B1, archivedAt: new Date() })),
    listPendingForUser: jest.fn(async () => []),
    acknowledge: jest.fn(async () => ({ ok: true, acknowledgedAt: new Date() })),
  };
}

describe('AdminBroadcastsController (capiro-admin/broadcasts)', () => {
  it('delegates every staff route with the caller context and validated ids', async () => {
    const service = makeService();
    const controller = new AdminBroadcastsController(service as unknown as AdminBroadcastsService);

    await controller.listTenantMembers(TENANT);
    await controller.list(TENANT);
    await controller.create(staff, {
      tenantId: TENANT,
      title: 'Maintenance',
      body: 'Tonight',
      audience: 'selected_users',
      userIds: [member.userId],
    });
    await controller.detail(B1);
    await controller.archive(staff, B1);

    expect(service.listTenantMembers).toHaveBeenCalledWith(TENANT);
    expect(service.listBroadcasts).toHaveBeenCalledWith(TENANT);
    expect(service.createBroadcast).toHaveBeenCalledWith(staff, {
      tenantId: TENANT,
      title: 'Maintenance',
      body: 'Tonight',
      audience: 'selected_users',
      userIds: [member.userId],
    });
    expect(service.getBroadcast).toHaveBeenCalledWith(B1);
    expect(service.archiveBroadcast).toHaveBeenCalledWith(staff, B1);
  });
});

describe('MeBroadcastsController (me/broadcasts)', () => {
  it('scopes pending + acknowledge to the caller only', async () => {
    const service = makeService();
    const controller = new MeBroadcastsController(service as unknown as AdminBroadcastsService);

    await controller.pending(member);
    await expect(controller.acknowledge(member, B1)).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );

    expect(service.listPendingForUser).toHaveBeenCalledWith(member);
    expect(service.acknowledge).toHaveBeenCalledWith(member, B1);
  });
});
