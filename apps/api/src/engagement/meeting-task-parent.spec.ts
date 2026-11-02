import { EngagementService } from './engagement.service.js';

const ctx: any = { tenantId: 'tenant', userId: 'actor', clerkUserId: 'clerk', role: 'user' };

function harness(
  options: {
    clientId?: string | null;
    revoked?: boolean;
    denied?: boolean;
    missing?: boolean;
  } = {},
) {
  const events: string[] = [];
  let locked = false;
  const clientId = options.clientId === undefined ? 'client-b' : options.clientId;
  const tx: any = {
    $queryRaw: jest.fn(async () => {
      locked = true;
      events.push('lock');
      return [];
    }),
    $queryRawUnsafe: jest.fn(async (_sql: string, tenant: string, client: string, user: string) => {
      expect([tenant, client, user]).toEqual([ctx.tenantId, clientId, ctx.userId]);
      events.push('wall');
      return [{ allowed: !options.denied }];
    }),
    tenantMembership: {
      findFirst: jest.fn(async ({ where }: any) => {
        expect(where).toMatchObject({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: 'active',
          user: { clerkUserId: ctx.clerkUserId },
        });
        events.push('member');
        return options.revoked ? null : { role: 'user' };
      }),
    },
    meeting: {
      findFirst: jest.fn(async ({ where }: any) => {
        expect(where).toEqual({
          id: 'meeting',
          tenantId: ctx.tenantId,
          status: { not: 'deleted' },
          OR: [{ createdByUserId: ctx.userId }, { connection: { createdByUserId: ctx.userId } }],
        });
        expect(locked).toBe(true);
        events.push('parent');
        return options.missing ? null : { id: 'meeting', clientId };
      }),
    },
    client: {
      findFirst: jest.fn(async ({ where }: any) => {
        expect(where).toEqual({
          id: clientId,
          tenantId: ctx.tenantId,
          status: { not: 'archived' },
        });
        return { id: clientId };
      }),
    },
    engagementTask: {
      create: jest.fn(async ({ data }: any) => {
        events.push('write');
        return data;
      }),
    },
  };
  const withTenant = jest.fn(async (_tenant: string, work: any) => work(tx));
  const service: EngagementService = Object.assign(Object.create(EngagementService.prototype), {
    prisma: { withTenant },
  });
  return { service, tx, events, withTenant };
}

describe('meeting-bound task creation', () => {
  test.each(['client-a', undefined])(
    'refuses stale or missing client assertion %s',
    async (clientId) => {
      const h = harness();
      await expect(
        h.service.createTask(ctx, { title: 'Synthetic', meetingId: 'meeting', clientId }),
      ).rejects.toMatchObject({ status: 409 });
      expect(h.tx.engagementTask.create).not.toHaveBeenCalled();
    },
  );

  test('refuses an old client after an explicit clear', async () => {
    const h = harness({ clientId: null });
    await expect(
      h.service.createTask(ctx, { title: 'Synthetic', meetingId: 'meeting', clientId: 'client-a' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.tx.engagementTask.create).not.toHaveBeenCalled();
  });

  test.each(['client-b', null])('creates only against the current parent %s', async (clientId) => {
    const h = harness({ clientId });
    await expect(
      h.service.createTask(ctx, {
        title: ' Synthetic ',
        meetingId: 'meeting',
        clientId: clientId ?? undefined,
      }),
    ).resolves.toMatchObject({
      title: 'Synthetic',
      clientId,
      meetingId: 'meeting',
      createdByUserId: ctx.userId,
    });
    expect(h.events.slice(0, 3)).toEqual(['lock', 'member', 'parent']);
    expect(h.events.at(-1)).toBe('write');
    expect(h.withTenant).toHaveBeenCalledTimes(1);
  });

  test.each(['revoked', 'denied', 'missing'] as const)(
    'refuses current %s authority',
    async (reason) => {
      const h = harness({ [reason]: true });
      await expect(
        h.service.createTask(ctx, {
          title: 'Synthetic',
          meetingId: 'meeting',
          clientId: 'client-b',
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.tx.engagementTask.create).not.toHaveBeenCalled();
    },
  );

  test('uses the same guard within an existing transaction', async () => {
    const h = harness();
    await h.service.createTask(
      ctx,
      { title: 'Synthetic', meetingId: 'meeting', clientId: 'client-b' },
      { tx: h.tx, sourceType: 'synthetic', sourceId: 'source' },
    );
    expect(h.withTenant).not.toHaveBeenCalled();
    expect(h.events[0]).toBe('lock');
    expect(h.tx.engagementTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceType: 'synthetic', sourceId: 'source' }),
      }),
    );
  });

  test('preserves nonmeeting task creation without a meeting lookup', async () => {
    const h = harness();
    await expect(
      h.service.createTask(ctx, { title: 'Synthetic', clientId: 'client-a' }),
    ).resolves.toMatchObject({ meetingId: null, clientId: 'client-a' });
    expect(h.tx.meeting.findFirst).not.toHaveBeenCalled();
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
  });
});
