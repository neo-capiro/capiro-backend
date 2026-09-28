import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service';

const ctx = {
  tenantId: 'tenant-1',
  userId: 'reader-1',
  tenantSlug: 'tenant',
  clerkUserId: 'clerk-reader-1',
  role: 'standard_user',
} as TenantContext;

function debrief(overrides: Record<string, unknown> = {}) {
  return {
    id: 'debrief-1',
    tenantId: 'tenant-1',
    meetingId: 'meeting-1',
    clientId: 'stale-child-client',
    authorUserId: 'reader-1',
    bodyCiphertext: 'ciphertext',
    iv: 'iv',
    authTag: 'tag',
    keyVersion: 'v1',
    confidential: true,
    accessLevel: 'tenant_admins_and_author',
    status: 'approved',
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    author: {
      id: 'reader-1',
      email: 'reader@example.com',
      firstName: 'Reader',
      lastName: 'One',
    },
    meeting: {
      id: 'meeting-1',
      clientId: 'client-1',
      subject: 'Client review',
      startsAt: new Date('2026-09-19T14:00:00.000Z'),
    },
    ...overrides,
  };
}

function harness(current: ReturnType<typeof debrief> | null) {
  const candidate = debrief();
  const tx = {
    client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
    meetingDebrief: {
      findMany: jest.fn().mockResolvedValue([candidate]),
      findFirst: jest.fn().mockResolvedValue(current),
    },
  };
  const decrypt = jest.fn().mockReturnValue('EXACT DECRYPTED BODY');
  const service = Object.assign(Object.create(EngagementService.prototype), {
    prisma: {
      withTenant: jest.fn(async (_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
    },
    notesCrypto: { decrypt },
  }) as EngagementService;
  return { service, tx, decrypt };
}

const query = {
  clientId: 'client-1',
  debriefId: null,
  from: null,
  to: null,
  limit: 25,
  listAfter: null,
};

describe('Engagement canonical exact debrief owner read', () => {
  it('uses current parent client/lifecycle and rechecks before returning decrypted content', async () => {
    const h = harness(debrief());
    const result = await h.service.readClientDebriefsExact(ctx, query);

    expect(h.tx.meetingDebrief.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 'tenant-1',
        status: 'approved',
        meeting: expect.objectContaining({
          clientId: 'client-1',
          client: { status: { not: 'archived' } },
          status: { notIn: ['pending', 'deleted', 'archived'] },
        }),
      }),
      take: 50,
    }));
    expect(h.tx.meetingDebrief.findFirst).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: 'debrief-1',
      clientId: 'client-1',
      body: 'EXACT DECRYPTED BODY',
    });
    expect(h.decrypt).toHaveBeenCalledTimes(1);
    expect(h.tx.client.findFirst).toHaveBeenCalledTimes(2);
  });

  it('does not leak restricted row metadata or decrypt its body', async () => {
    const restricted = debrief({ authorUserId: 'different-user' });
    const h = harness(restricted);
    const result = await h.service.readClientDebriefsExact(ctx, query);

    expect(result).toMatchObject({ rows: [], sourceStatus: 'healthy', nextAfter: null });
    expect(JSON.stringify(result)).not.toContain('debrief-1');
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it('reports a scan-bound partial result without encoding restricted row metadata', async () => {
    const restricted = debrief({ authorUserId: 'different-user' });
    const h = harness(restricted);
    h.tx.meetingDebrief.findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, index) => debrief({ id: `private-${index}` })),
    );
    const result = await h.service.readClientDebriefsExact(ctx, query);

    expect(result).toMatchObject({
      rows: [],
      sourceStatus: 'degraded',
      sourceReason: 'authorized_debrief_scan_bound_reached',
      nextAfter: null,
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ['parent/client drift', null],
    ['pending/deleted/archived or edited lifecycle', null],
    ['deleted row', null],
  ])('omits a scanned row after current %s', async (_label, current) => {
    const h = harness(current);
    const result = await h.service.readClientDebriefsExact(ctx, query);

    expect(result.rows).toEqual([]);
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it('fails closed if the requested client is archived during the read', async () => {
    const h = harness(debrief());
    h.tx.client.findFirst
      .mockResolvedValueOnce({ id: 'client-1' })
      .mockResolvedValueOnce(null);

    await expect(h.service.readClientDebriefsExact(ctx, query)).rejects.toThrow('Client not found');
  });
});
