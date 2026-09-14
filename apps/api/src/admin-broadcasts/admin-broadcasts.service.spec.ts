import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminBroadcastsService } from './admin-broadcasts.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF_TENANT = '99999999-9999-4999-8999-999999999999';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const U1 = '33333333-3333-4333-8333-333333333333';
const U2 = '44444444-4444-4444-8444-444444444444';
const OUTSIDER = '55555555-5555-4555-8555-555555555555';
const B1 = '66666666-6666-4666-8666-666666666666';

const admin: TenantContext = {
  tenantId: STAFF_TENANT,
  tenantSlug: 'capiro-internal',
  userId: ADMIN,
  clerkUserId: 'user_admin',
  role: 'capiro_admin',
};

const member: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'acme',
  userId: U1,
  clerkUserId: 'user_u1',
  role: 'standard_user',
};

function user(id: string, email: string) {
  return { id, email, firstName: null, lastName: null };
}

function makeTx() {
  const detail = {
    id: B1,
    tenantId: TENANT,
    title: 'Maintenance',
    body: 'Tonight 9pm ET',
    audience: 'all_users',
    createdAt: new Date('2026-09-14T12:00:00Z'),
    archivedAt: null,
    createdByUserId: ADMIN,
    createdBy: user(ADMIN, 'staff@capiro.ai'),
    recipients: [
      { userId: U1, acknowledgedAt: null, user: user(U1, 'u1@acme.com') },
      { userId: U2, acknowledgedAt: new Date('2026-09-14T13:00:00Z'), user: user(U2, 'u2@acme.com') },
    ],
  };
  return {
    detail,
    tenant: { findUnique: jest.fn(async () => ({ id: TENANT })) },
    tenantMembership: {
      findMany: jest.fn(async () => [
        { userId: U1, role: 'user_admin', status: 'active', user: user(U1, 'u1@acme.com') },
        { userId: U2, role: 'standard_user', status: 'invited', user: user(U2, 'u2@acme.com') },
      ]),
    },
    adminBroadcast: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => detail),
      create: jest.fn(async (_args: unknown) => ({ id: B1 })),
      update: jest.fn(async () => ({ id: B1 })),
    },
    adminBroadcastRecipient: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async () => ({ acknowledgedAt: new Date('2026-09-14T14:00:00Z') })),
      groupBy: jest.fn(async () => []),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
}

type Tx = ReturnType<typeof makeTx>;

function makeService(tx: Tx) {
  const prisma = {
    withSystem: jest.fn(async (fn: (t: Tx) => Promise<unknown>) => fn(tx)),
    withTenant: jest.fn(async (_tenantId: string, fn: (t: Tx) => Promise<unknown>) => fn(tx)),
  };
  return { service: new AdminBroadcastsService(prisma as unknown as PrismaService), prisma };
}

describe('AdminBroadcastsService — staff paths (withSystem)', () => {
  let tx: Tx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('all_users snapshots every active + invited member as a recipient and audit-logs the send', async () => {
    const { service, prisma } = makeService(tx);
    const out = await service.createBroadcast(admin, {
      tenantId: TENANT,
      title: '  Maintenance ',
      body: 'Tonight 9pm ET',
      audience: 'all_users',
    });

    expect(prisma.withSystem).toHaveBeenCalledTimes(1);
    expect(tx.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, status: { in: ['active', 'invited'] } },
      }),
    );
    const createArgs = tx.adminBroadcast.create.mock.calls[0]![0] as {
      data: {
        title: string;
        createdByUserId: string;
        recipients: { createMany: { data: Array<{ tenantId: string; userId: string }> } };
      };
    };
    expect(createArgs.data.title).toBe('Maintenance');
    expect(createArgs.data.createdByUserId).toBe(ADMIN);
    expect(createArgs.data.recipients.createMany.data).toEqual([
      { tenantId: TENANT, userId: U1 },
      { tenantId: TENANT, userId: U2 },
    ]);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT,
        actorUserId: ADMIN,
        actorRole: 'capiro_admin',
        action: 'broadcast.create',
        entityId: B1,
        after: { title: 'Maintenance', audience: 'all_users', recipientCount: 2 },
      }),
    });
    expect(out.recipientCount).toBe(2);
    expect(out.acknowledgedCount).toBe(1);
    expect(out.recipients.map((r) => r.email)).toEqual(['u1@acme.com', 'u2@acme.com']);
  });

  it('selected_users only accepts current members of that tenant', async () => {
    const { service } = makeService(tx);
    await expect(
      service.createBroadcast(admin, {
        tenantId: TENANT,
        title: 'Hi',
        body: 'There',
        audience: 'selected_users',
        userIds: [U1, OUTSIDER],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.adminBroadcast.create).not.toHaveBeenCalled();

    await service.createBroadcast(admin, {
      tenantId: TENANT,
      title: 'Hi',
      body: 'There',
      audience: 'selected_users',
      userIds: [U2, U2],
    });
    const createArgs = tx.adminBroadcast.create.mock.calls[0]![0] as {
      data: { recipients: { createMany: { data: Array<{ userId: string }> } } };
    };
    expect(createArgs.data.recipients.createMany.data).toEqual([{ tenantId: TENANT, userId: U2 }]);
  });

  it('rejects an empty selection, an empty title/body, and an unknown tenant', async () => {
    const { service } = makeService(tx);
    await expect(
      service.createBroadcast(admin, {
        tenantId: TENANT,
        title: 'Hi',
        body: 'There',
        audience: 'selected_users',
        userIds: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createBroadcast(admin, { tenantId: TENANT, title: '   ', body: 'x', audience: 'all_users' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    tx.tenant.findUnique.mockResolvedValueOnce(null as never);
    await expect(service.listBroadcasts(TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listBroadcasts joins the acknowledged count per broadcast', async () => {
    const { service } = makeService(tx);
    tx.adminBroadcast.findMany.mockResolvedValueOnce([
      { ...tx.detail, _count: { recipients: 2 } },
    ] as never);
    tx.adminBroadcastRecipient.groupBy.mockResolvedValueOnce([
      { broadcastId: B1, _count: { _all: 1 } },
    ] as never);
    const out = await service.listBroadcasts(TENANT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: B1, recipientCount: 2, acknowledgedCount: 1 });
    expect(tx.adminBroadcastRecipient.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, acknowledgedAt: { not: null } } }),
    );
  });

  it('archive is idempotent and audit-logged once', async () => {
    const { service } = makeService(tx);
    await service.archiveBroadcast(admin, B1);
    expect(tx.adminBroadcast.update).toHaveBeenCalledWith({
      where: { id: B1 },
      data: { archivedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'broadcast.archive', entityId: B1, tenantId: TENANT }),
    });

    tx.adminBroadcast.update.mockClear();
    tx.auditLog.create.mockClear();
    tx.adminBroadcast.findUnique.mockResolvedValueOnce({
      ...tx.detail,
      archivedAt: new Date(),
    } as never);
    await service.archiveBroadcast(admin, B1);
    expect(tx.adminBroadcast.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('members list excludes removed memberships and sorts by display name', async () => {
    const { service } = makeService(tx);
    const out = await service.listTenantMembers(TENANT);
    expect(tx.tenantMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, status: { in: ['active', 'invited'] } } }),
    );
    expect(out.map((m) => m.email)).toEqual(['u1@acme.com', 'u2@acme.com']);
    expect(out[1]).toMatchObject({ status: 'invited', role: 'standard_user' });
  });
});

describe('AdminBroadcastsService — user paths (withTenant, own rows only)', () => {
  let tx: Tx;
  beforeEach(() => {
    tx = makeTx();
  });

  it('pending lists only unacknowledged, unarchived rows addressed to the caller, oldest first', async () => {
    const { service, prisma } = makeService(tx);
    tx.adminBroadcastRecipient.findMany.mockResolvedValueOnce([
      { broadcast: { id: B1, title: 'Maintenance', body: 'Tonight', createdAt: new Date() } },
    ] as never);
    const out = await service.listPendingForUser(member);
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(tx.adminBroadcastRecipient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          userId: U1,
          acknowledgedAt: null,
          broadcast: { archivedAt: null },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(out).toEqual([expect.objectContaining({ id: B1, title: 'Maintenance' })]);
  });

  it('acknowledge stamps the caller’s own recipient row once and 404s for non-recipients', async () => {
    const { service } = makeService(tx);
    await expect(service.acknowledge(member, B1)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.adminBroadcastRecipient.update).not.toHaveBeenCalled();

    tx.adminBroadcastRecipient.findFirst.mockResolvedValueOnce({
      id: 'r1',
      acknowledgedAt: null,
    } as never);
    const first = await service.acknowledge(member, B1);
    expect(tx.adminBroadcastRecipient.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT, userId: U1, broadcastId: B1 } }),
    );
    expect(tx.adminBroadcastRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1' }, data: { acknowledgedAt: expect.any(Date) } }),
    );
    expect(first.ok).toBe(true);

    const already = new Date('2026-09-14T13:00:00Z');
    tx.adminBroadcastRecipient.update.mockClear();
    tx.adminBroadcastRecipient.findFirst.mockResolvedValueOnce({
      id: 'r1',
      acknowledgedAt: already,
    } as never);
    const second = await service.acknowledge(member, B1);
    expect(tx.adminBroadcastRecipient.update).not.toHaveBeenCalled();
    expect(second.acknowledgedAt).toBe(already);
  });
});
