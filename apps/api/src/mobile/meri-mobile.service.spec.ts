import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriMobileService } from './meri-mobile.service.js';

const ctx: TenantContext = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  tenantSlug: 'pilot',
  userId: '00000000-0000-0000-0000-000000000002',
  clerkUserId: 'user_clerk',
  role: 'standard_user',
};

function harness() {
  const tx = {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: ctx.userId,
        email: 'analyst@example.invalid',
        firstName: 'A',
        lastName: 'User',
      }),
    },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ id: ctx.tenantId, slug: ctx.tenantSlug, name: 'Pilot' }),
    },
    client: {
      findMany: jest.fn().mockResolvedValue([
        { id: '00000000-0000-0000-0000-000000000003', name: 'Allowed' },
      ]),
    },
    mobileDeviceToken: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue({
        id: '00000000-0000-0000-0000-000000000004',
        deviceId: 'device-1',
        environment: 'sandbox',
        appVersion: '1.0.0',
        updatedAt: new Date('2026-09-23T12:00:00.000Z'),
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn((_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    withTenantUser: jest.fn((_tenantId: string, _userId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  const flags = {
    isMeriMobileApiEnabled: jest.fn().mockResolvedValue(true),
    isMeriMobileCapabilityEnabled: jest.fn().mockResolvedValue(true),
    isMeriHermesRuntimeEnabled: jest.fn().mockResolvedValue(true),
  };
  const engagement = {
    listMeetings: jest.fn(),
    getMeeting: jest.fn(),
    updateMeeting: jest.fn(),
    updateMeetingNote: jest.fn(),
    updateMeetingDebrief: jest.fn(),
    updateMeetingPrep: jest.fn(),
    createAttachmentUploadUrl: jest.fn(),
    confirmAttachment: jest.fn(),
    listAttachments: jest.fn(),
  };
  const security = {
    securityEnvelope: jest.fn().mockResolvedValue({
      authorizedClientIds: ['00000000-0000-0000-0000-000000000003'],
      authorizedMailboxConnectionIds: [],
    }),
  };
  const service = new MeriMobileService(
    prisma as never,
    flags as never,
    engagement as never,
    security as never,
  );
  return { service, prisma, flags, engagement, security, tx };
}

describe('MeriMobileService', () => {
  it('fails closed before querying principal data', async () => {
    const { service, flags, prisma, security } = harness();
    flags.isMeriMobileApiEnabled.mockResolvedValue(false);

    await expect(service.bootstrap(ctx)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(security.securityEnvelope).not.toHaveBeenCalled();
  });

  it('builds bootstrap client choices only from the server authorization envelope', async () => {
    const { service, tx } = harness();

    const result = await service.bootstrap(ctx);

    expect(result.manifestIsAuthorization).toBe(false);
    expect(result.clients).toEqual([
      { id: '00000000-0000-0000-0000-000000000003', name: 'Allowed' },
    ]);
    expect(tx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['00000000-0000-0000-0000-000000000003'] },
          status: 'active',
        },
      }),
    );
  });

  it('bounds meeting pages and delegates authorization to the canonical Engagement service', async () => {
    const { service, engagement } = harness();
    engagement.listMeetings.mockResolvedValue([
      { id: '00000000-0000-0000-0000-000000000010', startsAt: new Date('2026-10-01T12:00:00Z'), updatedAt: new Date('2026-09-23T12:00:00Z') },
      { id: '00000000-0000-0000-0000-000000000011', startsAt: new Date('2026-10-02T12:00:00Z'), updatedAt: new Date('2026-09-23T13:00:00Z') },
    ]);

    const result = await service.listMeetings(ctx, { limit: 1 });

    expect(engagement.listMeetings).toHaveBeenCalledWith(ctx, expect.objectContaining({ limit: 2 }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.revision).toBe('2026-09-23T12:00:00.000Z');
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it('scopes device register and revoke to the authenticated tenant and user', async () => {
    const { service, prisma, tx } = harness();
    const token = 'ab'.repeat(32);

    const registered = await service.registerDevice(ctx, {
      deviceId: 'device-1',
      environment: 'sandbox',
      token,
      appVersion: '1.0.0',
    });
    const revoked = await service.revokeDevice(ctx, { deviceId: 'device-1', environment: 'sandbox' });

    expect(prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function));
    expect(tx.mobileDeviceToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_userId_deviceId_environment: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            deviceId: 'device-1',
            environment: 'sandbox',
          },
        },
      }),
    );
    expect(tx.mobileDeviceToken.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: ctx.tenantId, userId: ctx.userId }) }),
    );
    expect(registered).not.toHaveProperty('token');
    expect(revoked).toEqual({ revoked: true });
  });
});
