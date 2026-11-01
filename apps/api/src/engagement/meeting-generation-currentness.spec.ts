import { EngagementService } from './engagement.service.js';

const ctx: any = { tenantId: 'tenant', userId: 'actor', clerkUserId: 'clerk', role: 'user' };

// Exercise the actual generators and authorization helpers. Only storage and
// provider delivery are synthetic; the lock models another writer committing.
function harness(
  options: {
    clientId?: string | null;
    internal?: boolean;
    denied?: boolean;
    revoked?: boolean;
    missing?: boolean;
    afterProvider?: boolean;
  } = {},
) {
  const row: any = {
    id: 'meeting',
    clientId: 'client-a',
    client: { id: 'client-a', name: 'Old client' },
    isInternal: false,
    associationSignals: {},
    subject: 'Old subject',
    description: '',
    startsAt: new Date('2026-10-31T12:00:00Z'),
    endsAt: new Date('2026-10-31T12:30:00Z'),
    status: 'scheduled',
    location: null,
    attendees: [],
    preps: [],
    tasks: [],
  };
  const events: string[] = [];
  let locked = false;
  let inTransaction = false;
  let generated = false;
  const currentClient = options.clientId === undefined ? 'client-b' : options.clientId;
  const tx: any = {
    $queryRawUnsafe: jest.fn(
      async (_sql: string, tenant: string, client: string, actor: string) => {
        expect([tenant, client, actor]).toEqual([ctx.tenantId, row.clientId, ctx.userId]);
        return [{ allowed: !options.denied }];
      },
    ),
    $queryRaw: jest.fn(async () => {
      events.push('lock');
      if (!locked) {
        Object.assign(row, {
          clientId: currentClient,
          isInternal: options.internal ?? false,
          client: currentClient ? { id: currentClient, name: 'Current client' } : null,
          associationSignals: { manual: true },
          subject: 'Current subject',
        });
      }
      locked = true;
      return [{ id: row.id }];
    }),
    tenantMembership: {
      findFirst: jest.fn(async () => (options.revoked ? null : { role: 'user' })),
    },
    meeting: {
      findFirst: jest.fn(async ({ where }: any) => {
        expect(where.tenantId).toBe(ctx.tenantId);
        if (options.missing && locked) return null;
        events.push('read');
        return { ...row };
      }),
      findMany: jest.fn(async () => []),
      update: jest.fn(),
    },
    client: {
      findFirst: jest.fn(async ({ where }: any) => {
        events.push('authorize:' + where.id);
        return { id: where.id, memoryWall: options.denied ?? false };
      }),
      findUnique: jest.fn(async ({ where }: any) => ({ id: where.id, name: 'Current client' })),
    },
    meetingDebrief: { findMany: jest.fn(async () => []) },
    mailThread: { findMany: jest.fn(async () => []) },
    engagementTask: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => data),
    },
    meetingPrep: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: any) => ({ id: 'prep', ...data })),
    },
  };
  const transaction = async (work: any) => {
    inTransaction = true;
    try {
      return await work(tx);
    } finally {
      inTransaction = false;
    }
  };
  const deliver = async () => {
    expect(inTransaction).toBe(false);
    generated = true;
    if (options.afterProvider) row.clientId = 'client-c';
    return {
      recap: 'Synthetic',
      actionItems: [],
      notes: '',
      summary: 'Synthetic',
      agenda: [],
      talkingPoints: [],
      risks: [],
      followUps: [],
      emailEvidence: [],
      provider: 'synthetic',
      model: 'synthetic',
    };
  };
  const ai = { generateMeetingPrep: jest.fn(deliver), generateMeetingDebrief: jest.fn(deliver) };
  const service: any = Object.assign(Object.create(EngagementService.prototype), {
    prisma: {
      withTenant: (_t: string, work: any) => transaction(work),
      withTenantUser: (_t: string, _u: string, work: any) => transaction(work),
    },
    ai,
    recordAiUsage: jest.fn(),
    listMeetingNotes: jest.fn(async () => []),
    loadUserVoiceBlock: jest.fn(async () => null),
    directoryProfilesForMeeting: jest.fn(async () => []),
    clientMeetingAssociationWhere: jest.fn(async (_tx: any, _t: string, clientId: string) => ({
      clientId,
    })),
    clientMailThreadAssociationWhere: jest.fn(async (_tx: any, _t: string, clientId: string) => ({
      clientId,
    })),
    association: {
      associate: jest.fn(() => {
        throw Error('Must preserve manual association');
      }),
    },
  });
  const run = (kind: 'prep' | 'debrief') =>
    kind === 'prep'
      ? service.generateMeetingPrep(ctx, 'meeting')
      : service.generateMeetingDebriefDraft(ctx, 'meeting', {
          method: 'manual',
          sourceText: 'Synthetic source',
        });
  return { run, service, tx, ai, events, row, wasGenerated: () => generated };
}

describe.each(['prep', 'debrief'] as const)('%s current generation context', (kind) => {
  test.each([
    { label: 'internal', clientId: null, internal: true },
    { label: 'explicit clear', clientId: null, internal: false },
    { label: 'reassignment', clientId: 'client-b', internal: false },
  ])('uses the full post-lock snapshot after $label', async (options) => {
    const h = harness(options);
    const result = await h.run(kind);
    const generate = kind === 'prep' ? h.ai.generateMeetingPrep : h.ai.generateMeetingDebrief;
    const prompt: any = (generate.mock.calls as any)[0][0];
    expect(prompt.meeting.subject).toBe('Current subject');
    expect(prompt.client?.id ?? null).toBe(options.clientId);
    expect(h.service.loadUserVoiceBlock).toHaveBeenCalledWith(ctx, options.clientId);
    expect(h.service.association.associate).not.toHaveBeenCalled();
    if (options.clientId) {
      expect(h.tx.client.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: options.clientId, tenantId: ctx.tenantId }),
        }),
      );
    } else {
      expect(h.tx.meetingDebrief.findMany).not.toHaveBeenCalled();
      expect(h.tx.mailThread.findMany).not.toHaveBeenCalled();
    }
    if (kind === 'prep') {
      expect(prompt.meeting.clientId).toBe(options.clientId);
      expect(prompt.meeting.client?.id ?? null).toBe(options.clientId);
      expect(result.clientId).toBe(options.clientId);
      expect(result.generatedFrom.clientId).toBe(options.clientId);
    }
  });

  test.each(['denied', 'revoked', 'missing'] as const)(
    'refuses current %s access before generation',
    async (reason) => {
      const h = harness({ [reason]: true });
      await expect(h.run(kind)).rejects.toMatchObject({ status: 404 });
      expect(h.wasGenerated()).toBe(false);
      expect(h.tx.meetingPrep.create).not.toHaveBeenCalled();
    },
  );

  test('refuses a reassignment during the provider call', async () => {
    const h = harness({ afterProvider: true });
    await expect(h.run(kind)).rejects.toMatchObject({ status: 400 });
    expect(h.wasGenerated()).toBe(true);
    expect(h.tx.meetingPrep.create).not.toHaveBeenCalled();
  });
});
