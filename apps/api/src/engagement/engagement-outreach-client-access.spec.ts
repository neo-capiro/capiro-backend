import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const VISIBLE = '33333333-3333-4333-8333-333333333333';
const WALLED = '44444444-4444-4444-8444-444444444444';
const GRANTED = '55555555-5555-4555-8555-555555555555';
const ARCHIVED = '66666666-6666-4666-8666-666666666666';
const ctx = { tenantId: TENANT, userId: USER } as TenantContext;

describe('outreach delivery outcome after access or association changes', () => {
  it.each(['grant revoked', 'client changed', 'meeting changed'])(
    'records the completed send when %s during provider latency', async (change) => {
      let visible = true;
      const row = {
        id: 'sent-record', tenantId: TENANT, clientId: VISIBLE, meetingId: null as string | null,
        meeting: null, type: 'campaign', status: 'draft', subject: 'Subject', body: 'Body',
        recipients: [{ email: 'recipient@example.invalid', name: 'Recipient' }], metadata: {},
      };
      const update = jest.fn(async ({ where, data, select }: any) => {
        expect(where).toEqual({ id: row.id, tenantId: TENANT });
        expect(select).toEqual({ id: true });
        Object.assign(row, data);
        return { id: row.id };
      });
      const service = Object.create(EngagementService.prototype) as any;
      service.versionedOutreach = false;
      service.prisma = { withTenant: jest.fn(async (_tenant: string, work: any) =>
        work({ outreachRecord: { update } })) };
      service.getOutreachRecord = jest.fn(async () => {
        if (!visible) throw new NotFoundException('Outreach record not found');
        return { ...row };
      });
      service.assertOutreachClientsReadable = jest.fn(async () => {
        if (!visible) throw new NotFoundException('Outreach record not found');
      });
      service.assertOutreachPrepSourcesReadable = jest.fn(async () => undefined);
      service.findCampaignSendConnection = jest.fn(async () => ({ id: 'connection', provider: 'microsoft_365' }));
      service.loadGraphAttachments = jest.fn(async () => []);
      service.mailSender = { sendMail: jest.fn(async () => {
        if (change === 'grant revoked') visible = false;
        else if (change === 'client changed') row.clientId = GRANTED;
        else row.meetingId = 'new-meeting';
      }) };

      if (change === 'grant revoked') {
        await expect(service.sendCampaign(ctx, row.id)).rejects.toBeInstanceOf(NotFoundException);
      } else {
        await expect(service.sendCampaign(ctx, row.id)).resolves.toMatchObject({ status: 'sent' });
      }
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'sent', stats: expect.objectContaining({ recipientsSent: 1 }) }),
      }));
      expect(service.mailSender.sendMail).toHaveBeenCalledTimes(1);

      visible = true;
      await expect(service.sendCampaign(ctx, row.id)).rejects.toThrow('Only draft campaigns can be sent');
      expect(service.mailSender.sendMail).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
    },
  );
});

type ClientRow = {
  id: string;
  tenantId: string;
  status: string;
  memoryWall: boolean;
  memoryAccessGrants: Array<{ tenantId: string; clientId: string; userId: string }>;
};

function client(id: string, changes: Partial<ClientRow> = {}): ClientRow {
  return {
    id,
    tenantId: TENANT,
    status: 'active',
    memoryWall: false,
    memoryAccessGrants: [],
    ...changes,
  };
}

const clients = [
  client(VISIBLE),
  client(WALLED, { memoryWall: true }),
  client(GRANTED, {
    memoryWall: true,
    memoryAccessGrants: [{ tenantId: TENANT, clientId: GRANTED, userId: USER }],
  }),
  client(ARCHIVED, { status: 'archived' }),
];

/** Match only the Prisma predicate operators used by these scoped reads. */
function matches(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition === null || typeof condition !== 'object' || condition instanceof Date) {
    return value === condition;
  }
  const predicates = condition as Record<string, unknown>;
  if ('is' in predicates) return matches(value, predicates.is);
  if ('isNot' in predicates) return !matches(value, predicates.isNot);
  if ('equals' in predicates) return matches(value, predicates.equals);
  if ('in' in predicates) return (predicates.in as unknown[]).includes(value);
  if ('notIn' in predicates) return !(predicates.notIn as unknown[]).includes(value);
  if ('not' in predicates) return !matches(value, predicates.not);
  if ('some' in predicates) {
    return Array.isArray(value) && value.some((item) => matches(item, predicates.some));
  }
  if ('none' in predicates) {
    return Array.isArray(value) && value.every((item) => !matches(item, predicates.none));
  }
  if (value instanceof Date && ('gte' in predicates || 'lte' in predicates)) {
    return (!('gte' in predicates) || value.getTime() >= (predicates.gte as Date).getTime()) &&
      (!('lte' in predicates) || value.getTime() <= (predicates.lte as Date).getTime());
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(predicates).every(([key, expected]) => {
    if (key === 'AND') {
      return (Array.isArray(expected) ? expected : [expected]).every((part) => matches(value, part));
    }
    if (key === 'OR') {
      return (Array.isArray(expected) ? expected : [expected]).some((part) => matches(value, part));
    }
    if (key === 'NOT') return !matches(value, expected);
    return matches((value as Record<string, unknown>)[key], expected);
  });
}

function campaign(id: string, clientId: string | null) {
  return {
    id,
    tenantId: TENANT,
    clientId,
    client: clients.find((row) => row.id === clientId) ?? null,
    status: 'draft',
    recipients: [],
    updatedAt: new Date('2026-10-17T00:00:00.000Z'),
  };
}

function record(
  id: string,
  clientId: string | null,
  meetingClientId: string | null = null,
  nestedClient?: { prep?: string | null; debrief?: string | null },
) {
  return {
    id,
    tenantId: TENANT,
    createdByUserId: USER,
    clientId,
    client: clients.find((row) => row.id === clientId) ?? null,
    meetingId: meetingClientId || nestedClient ? `meeting-${id}` : null,
    meeting: meetingClientId || nestedClient ? {
      id: `meeting-${id}`,
      tenantId: TENANT,
      createdByUserId: USER,
      clientId: meetingClientId,
      client: clients.find((row) => row.id === meetingClientId) ?? null,
      preps: nestedClient && 'prep' in nestedClient ? [{
        id: `prep-${id}`, tenantId: TENANT, meetingId: `meeting-${id}`,
        clientId: nestedClient.prep ?? null, generatedFrom: null as unknown,
      }] : [],
      debriefs: nestedClient && 'debrief' in nestedClient ? [{
        id: `debrief-${id}`, tenantId: TENANT, meetingId: `meeting-${id}`,
        clientId: nestedClient.debrief ?? null,
      }] : [],
    } : null,
    type: 'follow_up',
    status: 'draft',
    deletedAt: null as Date | null,
    sentAt: null,
    createdAt: new Date('2026-10-17T00:00:00.000Z'),
    body: `Body of ${id}`,
    metadata: {},
    recipients: [],
    lastStep: 1,
  };
}

function outboundMeeting(id: string, clientId: string | null, createdByUserId = USER) {
  return {
    id,
    tenantId: TENANT,
    createdByUserId,
    connectionId: `connection-${id}`,
    connection: { createdByUserId },
    clientId,
    client: clients.find((row) => row.id === clientId) ?? null,
    source: 'google_calendar',
    status: 'scheduled',
    startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    subject: `Meeting ${id}`,
    location: null,
    attendees: [{ id: `attendee-${id}`, name: `Attendee ${id}`, email: `${id}@example.com`, role: null }],
    preps: [],
    debriefs: [],
  };
}

function harness(
  campaigns = [] as ReturnType<typeof campaign>[],
  records = [] as ReturnType<typeof record>[],
  meetings = [] as ReturnType<typeof outboundMeeting>[],
) {
  const events: string[] = [];
  const tx = {
    client: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        clients.find((row) => matches(row, where)) ?? null),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        clients.filter((row) => matches(row, where))),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        clients.filter((row) => matches(row, where)).length),
    },
    engagementCampaign: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        campaigns.filter((row) => matches(row, where))),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        campaigns.find((row) => matches(row, where)) ?? null),
      create: jest.fn(async () => { throw new Error('Unexpected campaign create'); }),
      update: jest.fn(async () => { throw new Error('Unexpected campaign update'); }),
    },
    outreachRecord: {
      findMany: jest.fn(async ({ where, include, take }: {
        where: Record<string, unknown>;
        include?: unknown;
        take?: number;
      }) => records
        .filter((row) => matches(row, where))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, take)
        .map((row) => include && row.meeting ? {
          ...row,
          meeting: {
            ...row.meeting,
            // outreachInclude selects the newest child only. A hidden newest
            // child may be omitted; an older child must not take its place.
            preps: row.meeting.preps.slice(0, 1),
            debriefs: row.meeting.debriefs.slice(0, 1),
          },
        } : row)),
      findFirst: jest.fn(async ({ where, include }: {
        where: Record<string, unknown>;
        include?: unknown;
      }) => {
        events.push(include ? 'outreach-include' : 'outreach-preflight');
        return records.find((row) => matches(row, where)) ?? null;
      }),
      create: jest.fn(async () => { throw new Error('Unexpected outreach create'); }),
      update: jest.fn(async () => { throw new Error('Unexpected outreach update'); }),
    },
    meeting: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        records.map((row) => row.meeting).find((row) => row && matches(row, where)) ?? null),
      findMany: jest.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        meetings.filter((row) => matches(row, where)).slice(0, take)),
    },
    meetingPrep: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        records.flatMap((row) => row.meeting?.preps ?? []).filter((row) => matches(row, where))),
    },
    meetingDebrief: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        records.flatMap((row) => row.meeting?.debriefs ?? []).filter((row) => matches(row, where))),
    },
    $queryRawUnsafe: jest.fn(async (sql: string, tenantId: string, clientIdOrUserId: string, userId?: string) => {
      if (sql.includes('AS allowed') && sql.includes('FROM clients c')) {
        const row = clients.find((item) => item.tenantId === tenantId && item.id === clientIdOrUserId);
        events.push(`wall:${clientIdOrUserId}`);
        return row ? [{ allowed: !row.memoryWall || row.memoryAccessGrants.some(
          (grant) => grant.tenantId === tenantId && grant.userId === userId,
        ) }] : [];
      }
      if (sql.includes('SELECT c.id') && sql.includes('memory_wall')) {
        events.push('wall-roster');
        return clients.filter((row) => row.tenantId === tenantId && row.memoryWall &&
          !row.memoryAccessGrants.some((grant) => grant.userId === clientIdOrUserId))
          .map((row) => ({ id: row.id }));
      }
      throw new Error('Unexpected SQL in outreach access test');
    }),
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, run: (arg: typeof tx) => unknown) => run(tx)),
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, run: (arg: typeof tx) => unknown) => run(tx)),
  };
  const service = Object.assign(Object.create(EngagementService.prototype), {
    prisma,
    versionedOutreach: false,
    directory: { findContactsByEmails: jest.fn(async () => []) },
  }) as EngagementService;
  return { service, tx, events };
}

describe('Engagement outreach client visibility', () => {
  it('filters denied and archived associated campaigns before an unscoped list reaches Meri totals', async () => {
    const h = harness([
      campaign('denied', WALLED),
      campaign('visible', VISIBLE),
      campaign('archived', ARCHIVED),
      campaign('clientless', null),
      campaign('granted', GRANTED),
    ]);
    const rows = await h.service.listCampaigns(ctx, {});
    expect(rows.map((row) => row.id)).toEqual(['visible', 'clientless', 'granted']);
    expect(h.tx.engagementCampaign.findMany).toHaveBeenCalledTimes(1);
  });

  it('refuses explicit hidden or archived campaign scopes and permits a current granted scope', async () => {
    const h = harness([campaign('denied', WALLED), campaign('archived', ARCHIVED), campaign('granted', GRANTED)]);
    await expect(h.service.listCampaigns(ctx, { clientId: WALLED })).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.listCampaigns(ctx, { clientId: ARCHIVED })).rejects.toBeInstanceOf(NotFoundException);
    expect((await h.service.listCampaigns(ctx, { clientId: GRANTED })).map((row) => row.id))
      .toEqual(['granted']);
  });

  it('omits a campaign if its grant is revoked between the relation query and returned total', async () => {
    const h = harness([campaign('grant-revoked', GRANTED)]);
    h.tx.client.findMany.mockResolvedValueOnce([]);
    expect(await h.service.listCampaigns(ctx, {})).toEqual([]);
  });

  it('uses the same indistinguishable not-found result for denied campaign detail and a missing id', async () => {
    const h = harness([
      campaign('denied', WALLED), campaign('archived', ARCHIVED),
      campaign('visible', VISIBLE), campaign('clientless', null), campaign('granted', GRANTED),
    ]);
    const missing = await h.service.getCampaign(ctx, 'missing').catch((error: NotFoundException) => error.message);
    for (const id of ['denied', 'archived']) {
      await expect(h.service.getCampaign(ctx, id)).rejects.toBeInstanceOf(NotFoundException);
      const message = await h.service.getCampaign(ctx, id).catch((error: NotFoundException) => error.message);
      expect(message).toBe(missing);
    }
    expect((await h.service.getCampaign(ctx, 'visible')).id).toBe('visible');
    expect((await h.service.getCampaign(ctx, 'clientless')).id).toBe('clientless');
    expect((await h.service.getCampaign(ctx, 'granted')).id).toBe('granted');
  });

  it('refuses campaign detail if its current grant is revoked after the filtered row read', async () => {
    const h = harness([campaign('revoked-detail', GRANTED)]);
    h.tx.$queryRawUnsafe.mockResolvedValueOnce([{ allowed: false }]);
    await expect(h.service.getCampaign(ctx, 'revoked-detail'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([WALLED, ARCHIVED])('refuses campaign creation for inaccessible client %s', async (clientId) => {
    const h = harness();
    await expect(h.service.createCampaign(ctx, { name: 'Draft', clientId }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.engagementCampaign.create).not.toHaveBeenCalled();
  });

  it('cannot reassign a hidden old campaign to a visible or null client', async () => {
    const h = harness([campaign('old-hidden', WALLED)]);
    for (const clientId of [VISIBLE, null]) {
      await expect(h.service.updateCampaign(ctx, 'old-hidden', { clientId }))
        .rejects.toBeInstanceOf(NotFoundException);
    }
    expect(h.tx.engagementCampaign.update).not.toHaveBeenCalled();
  });

  it('cannot reassign a visible campaign to an inaccessible next client', async () => {
    const h = harness([campaign('old-visible', VISIBLE)]);
    await expect(h.service.updateCampaign(ctx, 'old-visible', { clientId: WALLED }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.engagementCampaign.update).not.toHaveBeenCalled();
  });

  it('excludes hidden, archived, and foreign meetings from unscoped outbound contact data', async () => {
    const h = harness([], [], [
      outboundMeeting('hidden', WALLED),
      outboundMeeting('archived', ARCHIVED),
      outboundMeeting('visible', VISIBLE),
      outboundMeeting('clientless', null),
      outboundMeeting('foreign', null, 'another-user'),
    ]);
    const result = await h.service.outboundCampaignContactData(ctx, {});
    expect(result.contacts.map((contact) => contact.meetingId))
      .toEqual(['visible', 'clientless']);
    expect(result.contacts.map((contact) => contact.meetingSubject))
      .toEqual(['Meeting visible', 'Meeting clientless']);
    expect(h.tx.meeting.findMany).toHaveBeenCalledTimes(1);
  });

  it('filters hidden record and meeting clients before an unscoped outreach page limit', async () => {
    const dated = (row: ReturnType<typeof record>, day: number) => ({
      ...row, createdAt: new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`),
    });
    const h = harness([], [
      dated(record('hidden-direct', WALLED), 17),
      dated(record('hidden-meeting', null, WALLED), 16),
      dated(record('archived-direct', ARCHIVED), 15),
      dated(record('visible', VISIBLE), 14),
      dated(record('clientless', null), 13),
    ]);
    const first = await h.service.listOutreachRecords(ctx, { limit: '1' });
    expect(first.map((row) => row.id)).toEqual(['visible']);
    const two = await h.service.listOutreachRecords(ctx, { limit: '2' });
    expect(two.map((row) => row.id)).toEqual(['visible', 'clientless']);
    expect(h.tx.outreachRecord.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 1 }));
    expect(h.tx.outreachRecord.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ take: 2 }));
  });

  it('omits a record with inaccessible newest prep and debrief before returning any content', async () => {
    const row = record('visible-with-hidden-children', VISIBLE, VISIBLE, {
      prep: WALLED, debrief: WALLED,
    });
    if (!row.meeting) throw new Error('Test setup requires a meeting');
    row.meeting.preps.push({
      id: 'older-visible-prep', tenantId: TENANT,
      meetingId: row.meeting.id, clientId: VISIBLE, generatedFrom: null,
    });
    row.meeting.debriefs.push({
      id: 'older-visible-debrief', tenantId: TENANT,
      meetingId: row.meeting.id, clientId: VISIBLE,
    });
    const h = harness([], [row]);
    const rows = await h.service.listOutreachRecords(ctx, { limit: '1' });
    expect(rows).toEqual([]);
    // An older accessible child cannot replace the denied latest source.
    expect(h.tx.outreachRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
  });

  it('hides clientless linked briefing when its saved accessSources names a denied client', async () => {
    const row = record('briefing-with-hidden-source', null, null, { prep: null });
    if (!row.meeting?.preps[0]) throw new Error('Test setup requires a linked prep');
    row.meeting.preps[0].generatedFrom = {
      briefing: true,
      grounding: { accessSources: [{ access: { clients: [WALLED] } }] },
    };
    const h = harness([], [row]);
    await expect(h.service.getOutreachRecord(ctx, row.id))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.events).not.toContain('outreach-include');
    expect(await h.service.listOutreachRecords(ctx, { limit: '1' })).toEqual([]);
    expect(h.tx.client.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: [WALLED] } }),
    }));
  });

  for (const { label, hidden } of [
    { label: 'direct client', hidden: record('hidden-direct', WALLED) },
    { label: 'archived direct client', hidden: record('archived-direct', ARCHIVED) },
    { label: 'nested meeting client with null record client', hidden: record('hidden-meeting', null, WALLED) },
    { label: 'nested prep client with visible meeting', hidden: record('hidden-prep', null, VISIBLE, { prep: WALLED }) },
    { label: 'nested debrief client with visible meeting', hidden: record('hidden-debrief', null, VISIBLE, { debrief: WALLED }) },
  ]) {
    it(`rejects a denied ${label} before loading the full outreach projection`, async () => {
      const h = harness([], [hidden]);
      await expect(h.service.getOutreachRecord(ctx, hidden.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(h.events).not.toContain('outreach-include');
    });
  }

  it('keeps visible, granted and genuinely clientless outreach records readable', async () => {
    const allowed = [
      record('visible', VISIBLE),
      record('granted', GRANTED),
      record('clientless', null),
    ];
    const h = harness([], allowed);
    for (const row of allowed) {
      expect((await h.service.getOutreachRecord(ctx, row.id)).id).toBe(row.id);
    }
    expect(h.events.filter((event) => event === 'outreach-include')).toHaveLength(3);
  });

  it('refuses an outreach record if its grant is revoked while the projection loads', async () => {
    const h = harness([], [record('revoked-during-read', GRANTED)]);
    h.tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ allowed: true }])
      .mockResolvedValueOnce([{ allowed: false }]);
    await expect(h.service.getOutreachRecord(ctx, 'revoked-during-read'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.events.filter((event) => event === 'outreach-include')).toHaveLength(1);
  });

  it.each([WALLED, ARCHIVED])('refuses outreach creation for inaccessible client %s', async (clientId) => {
    const h = harness();
    await expect(h.service.createOutreachRecord(ctx, {
      type: 'follow_up', title: 'Draft', clientId,
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.outreachRecord.create).not.toHaveBeenCalled();
  });

  it('refuses outreach creation against a linked meeting owned by a hidden client', async () => {
    const h = harness([], [record('meeting-parent', null, WALLED)]);
    await expect(h.service.createOutreachRecord(ctx, {
      type: 'follow_up', title: 'Draft', meetingId: 'meeting-meeting-parent',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.outreachRecord.create).not.toHaveBeenCalled();
  });

  it('does not let reassignment wash a hidden existing outreach association', async () => {
    const h = harness([], [record('old-hidden', WALLED)]);
    await expect(h.service.updateOutreachRecord(ctx, 'old-hidden', { clientId: VISIBLE }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.outreachRecord.update).not.toHaveBeenCalled();
  });

  it('refuses an inaccessible next client or linked meeting on outreach update', async () => {
    const h = harness([], [
      record('old-visible', VISIBLE),
      record('next-hidden-meeting', null, WALLED),
    ]);
    await expect(h.service.updateOutreachRecord(ctx, 'old-visible', { clientId: WALLED }))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.updateOutreachRecord(ctx, 'old-visible', {
      meetingId: 'meeting-next-hidden-meeting',
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.outreachRecord.update).not.toHaveBeenCalled();
  });

  it('refuses delete and restore of a record whose current client is hidden', async () => {
    const active = record('active-hidden', WALLED);
    const deleted = { ...record('deleted-hidden', WALLED), deletedAt: new Date('2026-10-18T00:00:00.000Z') };
    const h = harness([], [active, deleted]);
    await expect(h.service.deleteOutreachRecord(ctx, active.id))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.restoreOutreachRecord(ctx, deleted.id))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.outreachRecord.update).not.toHaveBeenCalled();
  });
});
