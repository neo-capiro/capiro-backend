import { harness, ctx } from './mailbox-oauth.a1-fixture.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { parseCalendarCommand } from './calendar-sync-command.js';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { MicrosoftIntegrationActionsController } from './microsoft/microsoft-integration-actions.controller.js';
import { GoogleIntegrationActionsController } from './google/google-integration-actions.controller.js';
import { MicrosoftOAuthService } from './microsoft/microsoft-oauth.service.js';
import { GoogleOAuthService } from './google/google-oauth.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
const requestId = '00000000-0000-4000-8000-000000000099';
const input = { schemaVersion: 1, requestId, range: null };
const range = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };
function setup(provider: 'microsoft_365' | 'google_workspace' = 'microsoft_365') {
  const h = harness(provider);
  const row = h.rows.get('connection-A');
  h.rows.delete('connection-A');
  row.id = '00000000-0000-4000-8000-000000000003';
  h.rows.set(row.id, row);
  row.token.expiresAt = new Date(Date.now() + 3600000);
  row.syncState = {};
  const commands = new Map<string, any>();
  const meetings: any[] = [];
  const query = h.tx.$queryRaw;
  let loseAdmission = false;
  let loseItem = false;
  let failCheckpoint = false;
  h.tx.$queryRaw = jest.fn(async (sql: TemplateStringsArray, ...v: any[]) => {
    const q = sql.join('');
    if (q.includes('FROM calendar_sync_commands')) {
      if (q.includes("status='pending'"))
        return [...commands.values()].filter(
          (x) => x.connectionId === v[1] && x.status === 'pending',
        );
      const found = commands.get(v[2]);
      return found && found.tenantId === v[0] && found.actorId === v[1]
        ? [structuredClone(found)]
        : [];
    }
    return query(sql, ...v);
  });
  h.tx.$executeRaw = jest.fn(async (sql: TemplateStringsArray, ...v: any[]) => {
    const q = sql.join('');
    if (q.includes('INSERT INTO calendar_sync_commands')) {
      if (loseAdmission) {
        loseAdmission = false;
        return 1;
      }
      commands.set(v[2], {
        tenantId: v[0],
        actorId: v[1],
        requestId: v[2],
        connectionId: v[3],
        provider: v[4],
        accountId: v[5],
        payloadDigest: v[6],
        command: JSON.parse(v[7]),
        window: JSON.parse(v[8]),
        progress: JSON.parse(v[9]),
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return 1;
    }
    if (q.includes('SET progress_jsonb=')) {
      if (failCheckpoint && meetings.length) throw new Error('checkpoint failed');
      const c = commands.get(v[3]);
      c.progress = JSON.parse(v[0]);
      c.updatedAt = new Date();
      return 1;
    }
    if (q.includes("SET status='completed'")) {
      commands.get(v[2]).status = 'completed';
      return 1;
    }
    return 1;
  });
  Object.assign(h.tx.meeting, {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async ({ data }: any) => {
      meetings.push(structuredClone(data));
      return { id: 'meeting-synthetic' };
    }),
    updateMany: jest.fn(async ({ data }: any) => {
      meetings.push(data);
      return { count: 1 };
    }),
  });
  h.tx.meetingAttendee = { deleteMany: jest.fn(), create: jest.fn() };
  const transaction = async (_tenant: string, run: any) => {
    const before = structuredClone([...commands]);
    const oldMeetings = meetings.length;
    try {
      const result = await run(h.tx);
      if (loseItem && meetings.length > oldMeetings) {
        loseItem = false;
        commands.clear();
        before.forEach(([key, value]) => commands.set(key, value));
        meetings.splice(oldMeetings);
      }
      return result;
    } catch (error) {
      commands.clear();
      before.forEach(([key, value]) => commands.set(key, value));
      meetings.splice(oldMeetings);
      throw error;
    }
  };
  h.prisma.withTenant = transaction;
  (h.prisma as any).withTenantRetry = transaction;
  const service: any = Object.assign(
    Object.create(
      provider === 'microsoft_365'
        ? MicrosoftGraphSyncService.prototype
        : GoogleSyncService.prototype,
    ),
    {
      prisma: h.prisma,
      tokenCrypto: h.crypto,
      logger: { warn: jest.fn(), error: jest.fn() },
      association: {
        associate: jest.fn(async () => ({ clientId: null, score: 0, reason: 'none', signals: [] })),
      },
      googleToken: {
        loadConnection: async () => ({ connection: structuredClone(row), token: row.token }),
        getValidAccessToken: jest.fn(async () => 'synthetic'),
      },
    },
  );
  service.getValidAccessToken = jest.fn(async () => 'synthetic');
  const event = (id: string) =>
    provider === 'microsoft_365'
      ? {
          id,
          subject: 'Synthetic',
          start: { dateTime: '2026-10-01T12:00:00Z' },
          end: { dateTime: '2026-10-01T13:00:00Z' },
        }
      : {
          id,
          summary: 'Synthetic',
          start: { dateTime: '2026-10-01T12:00:00Z' },
          end: { dateTime: '2026-10-01T13:00:00Z' },
        };
  const page = (ids: string[], next?: string) =>
    provider === 'microsoft_365'
      ? { value: ids.map(event), '@odata.nextLink': next }
      : { items: ids.map(event), nextPageToken: next };
  const fetch = jest.fn(async () => page(['first', 'second']));
  service.graphGet = fetch;
  service.calendarList = fetch;
  return {
    ...h,
    service,
    row,
    commands,
    meetings,
    fetch,
    page,
    event,
    run: (body: unknown = input) => service.runCalendarCommand(ctx, row.id, body),
    read: () => service.readCalendarCommand(ctx, row.id, requestId),
    loseAdmission: () => {
      loseAdmission = true;
    },
    loseItem: () => {
      loseItem = true;
    },
    failCheckpoint: () => {
      failCheckpoint = true;
    },
  };
}
describe.each(['microsoft_365', 'google_workspace'] as const)(
  '%s attributable calendar import',
  (provider) => {
    test('mounted POST/GET preserve the exact request receipt and reject nonstandard role writes', async () => {
      const h = setup(provider);
      const microsoft = provider === 'microsoft_365';
      let role = 'standard_user';
      const module = await Test.createTestingModule({
        controllers: [
          microsoft ? MicrosoftIntegrationActionsController : GoogleIntegrationActionsController,
        ],
        providers: [
          { provide: microsoft ? MicrosoftOAuthService : GoogleOAuthService, useValue: {} },
          {
            provide: microsoft ? MicrosoftGraphSyncService : GoogleSyncService,
            useValue: h.service,
          },
          { provide: EngagementRuntimePolicyService, useValue: {} },
        ],
      }).compile();
      const app = module.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
      );
      app.use((req: any, _res: unknown, next: () => void) => {
        req.tenantContext = { ...ctx, role };
        next();
      });
      try {
        await app.listen(0, '127.0.0.1');
        const url = `${await app.getUrl()}/engagement/integrations/${microsoft ? 'microsoft' : 'google'}/${h.row.id}/calendar-commands`;
        const post = () =>
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          });
        const response = await post();
        expect(response.status).toBe(201);
        const receipt = await response.json();
        expect(receipt).toMatchObject({ requestId, status: 'completed' });
        expect(await (await fetch(`${url}/${requestId}`)).json()).toEqual(receipt);
        role = 'client_portal_user';
        expect((await post()).status).toBe(403);
        expect(h.fetch).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    }, 15000);
    test('uses actual event persistence, seals result, and replays without another provider read or write', async () => {
      const h = setup(provider);
      const first = await h.run();
      expect(first).toMatchObject({
        requestId,
        status: 'completed',
        calendar: { scanned: 2, matched: 2, hasMore: false },
      });
      expect(h.meetings).toHaveLength(2);
      expect(await h.read()).toEqual(first);
      expect(await h.run()).toEqual(first);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.meetings).toHaveLength(2);
    });
    test('stores the full first provider page before an item write fails and resumes its original results', async () => {
      const h = setup(provider);
      h.tx.meeting.create.mockRejectedValueOnce(new Error('item failed'));
      await expect(h.run()).rejects.toThrow('item failed');
      expect((await h.read()).status).toBe('pending');
      h.fetch.mockResolvedValue(h.page(['changed-provider-result']));
      expect(await h.run()).toMatchObject({ status: 'completed', calendar: { matched: 2 } });
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.meetings.map((x) => x.externalId)).toEqual(['first', 'second']);
    });
    test('an unacknowledged local item commit cannot advance its checkpoint or claim completion', async () => {
      const h = setup(provider);
      h.loseItem();
      await expect(h.run()).rejects.toThrow('uncertain');
      expect(h.meetings).toHaveLength(0);
      expect((await h.read()).status).toBe('pending');
      expect(await h.run()).toMatchObject({ status: 'completed', calendar: { matched: 2 } });
      expect(h.fetch).toHaveBeenCalledTimes(1);
      expect(h.meetings).toHaveLength(2);
    });
    test('a checkpoint failure rolls back the corresponding actual event write', async () => {
      const h = setup(provider);
      h.failCheckpoint();
      await expect(h.run()).rejects.toThrow('checkpoint failed');
      expect(h.meetings).toHaveLength(0);
      expect((await h.read()).calendar).toMatchObject({ matched: 0, hasMore: true });
    });
    test('does not contact the provider when durable admission is absent', async () => {
      const h = setup(provider);
      h.loseAdmission();
      await expect(h.run()).rejects.toThrow('uncertain');
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.meetings).toHaveLength(0);
    });
    test('resumes after the committed prefix without writing that prefix again', async () => {
      const h = setup(provider);
      h.tx.meeting.create
        .mockImplementationOnce(h.tx.meeting.create.getMockImplementation())
        .mockRejectedValueOnce(new Error('second failed'));
      await expect(h.run()).rejects.toThrow('second failed');
      expect(h.meetings.map((x) => x.externalId)).toEqual(['first']);
      expect(await h.run()).toMatchObject({
        status: 'completed',
        calendar: { scanned: 2, matched: 2 },
      });
      expect(h.meetings.map((x) => x.externalId)).toEqual(['first', 'second']);
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });
    test('page caps return pending and continue the same frozen request', async () => {
      const h = setup(provider);
      let page = 0;
      h.fetch.mockImplementation(async () =>
        h.page([`page-${++page}`], page < 13 ? `next-${page}` : undefined),
      );
      expect(await h.run()).toMatchObject({
        status: 'pending',
        calendar: { matched: 12, hasMore: true },
      });
      expect(await h.run()).toMatchObject({
        status: 'completed',
        calendar: { matched: 13, hasMore: false },
      });
      expect(h.meetings).toHaveLength(13);
      expect(h.fetch).toHaveBeenCalledTimes(13);
    });
    test('pending command holds scheduled calendar imports while leaving the request recoverable', async () => {
      const h = setup(provider);
      h.tx.meeting.create.mockRejectedValueOnce(new Error('pause'));
      await expect(h.run()).rejects.toThrow('pause');
      const before = h.fetch.mock.calls.length;
      expect(
        await h.service.syncConnection(ctx, h.row.id, { calendar: true, mail: false }),
      ).toMatchObject({ calendar: { hasMore: true } });
      expect(h.fetch).toHaveBeenCalledTimes(before);
      expect((await h.read()).status).toBe('pending');
    });
    test('rechecks account identity on recovery before provider work', async () => {
      const h = setup(provider);
      h.tx.meeting.create.mockRejectedValueOnce(new Error('item failed'));
      await expect(h.run()).rejects.toThrow();
      h.row.token.homeAccountId = 'replacement-account';
      await expect(h.run()).rejects.toThrow('identity changed');
      await expect(h.read()).rejects.toThrow('identity changed');
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });
    test('revocation after provider read blocks the first local effect', async () => {
      const h = setup(provider);
      h.fetch.mockImplementationOnce(async () => {
        h.setActive(false);
        return h.page(['first']);
      });
      await expect(h.run()).rejects.toThrow('membership');
      expect(h.meetings).toHaveLength(0);
      expect([...h.commands.values()][0].status).toBe('pending');
    });
    test('another connection owner cannot read a recorded outcome', async () => {
      const h = setup(provider);
      await h.run();
      h.row.createdByUserId = 'other-actor';
      await expect(h.read()).rejects.toThrow('not found');
    });
  },
);
test('same request with a changed range conflicts without repeating provider effects', async () => {
  const h = setup();
  await h.run();
  await expect(h.run({ ...input, range })).rejects.toThrow('different input');
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
test('explicit Microsoft range stays frozen through pending continuation', async () => {
  const h = setup();
  h.tx.meeting.create.mockRejectedValueOnce(new Error('item failed'));
  await expect(h.run({ ...input, range })).rejects.toThrow();
  expect((await h.read()).window).toEqual(range);
  expect(await h.run({ ...input, range })).toMatchObject({
    status: 'completed',
    range,
    window: range,
  });
});
test('strict input rejects unsupported Google windows and extra fields', () => {
  expect(() => parseCalendarCommand({ ...input, range }, 'google_workspace')).toThrow();
  expect(() => parseCalendarCommand({ ...input, actorId: 'forged' }, 'microsoft_365')).toThrow();
});
