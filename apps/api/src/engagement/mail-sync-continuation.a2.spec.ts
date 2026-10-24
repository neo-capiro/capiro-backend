import { harness, tenant } from './mailbox-oauth.a1-fixture.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { MAIL_CAPTURE_VERSION } from './mail-sync-coverage.js';
import { assertMailboxBudget, MailboxDeadlineError } from './mailbox-provider-transport.js';

function setup(provider: 'google_workspace' | 'microsoft_365') {
  const h = harness(provider);
  const row = h.rows.get('connection-A');
  row.token.expiresAt = new Date(Date.now() + 3_600_000);
  row.syncState = {};
  const service: any = Object.assign(
    Object.create(
      provider === 'google_workspace'
        ? GoogleSyncService.prototype
        : MicrosoftGraphSyncService.prototype,
    ),
    {
      prisma: h.prisma,
      tokenCrypto: h.crypto,
      googleToken: {
        loadConnection: async () => ({ connection: row, token: row.token }),
        getValidAccessToken: async () => 'access',
      },
      logger: { warn: jest.fn(), error: jest.fn() },
    },
  );
  service.getValidAccessToken = async () => 'access';
  return { ...h, row, service };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test.each(['google_workspace', 'microsoft_365'] as const)(
  '%s slow calendar page resumes its remaining items without reprocessing the page prefix',
  async (provider) => {
    const h = setup(provider);
    const items = [{ id: 'event-1' }, { id: 'event-2' }];
    const persist = jest.fn(async () => {
      jest.setSystemTime(Date.now() + 70_000);
      return 'matched';
    });
    const list = jest.fn(async () =>
      provider === 'google_workspace'
        ? { items, nextSyncToken: 'complete-calendar' }
        : { value: items, '@odata.deltaLink': 'complete-calendar' },
    );
    if (provider === 'google_workspace') {
      h.service.calendarList = list;
      h.service.persistCalendarEvent = persist;
    } else {
      h.service.graphGet = list;
      h.service.persistGraphEvent = persist;
    }
    const run = () => h.service.syncConnectionByTenant(tenant, h.row.id, { mail: false });
    await expect(run()).resolves.toMatchObject({ health: { calendar: { outcome: 'partial' } } });
    const pending = h.row.syncState.calendar.pendingPage;
    expect(pending.items ?? pending.value).toEqual([{ id: 'event-2' }]);
    expect(h.row.syncState.calendar.syncToken ?? h.row.syncState.calendar.deltaLink).not.toBe(
      'complete-calendar',
    );
    await expect(run()).resolves.toMatchObject({ health: { calendar: { outcome: 'complete' } } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls.map((call: any[]) => call[2]?.id)).toEqual(['event-1', 'event-2']);
    expect(h.row.syncState.calendar.pendingPage).toBeUndefined();
    expect(h.row.syncState.calendar.syncToken ?? h.row.syncState.calendar.deltaLink).toBe(
      'complete-calendar',
    );
  },
);

test('Graph slow mail page resumes unhydrated items and retains backfill mode until drained', async () => {
  const h = setup('microsoft_365');
  h.row.syncState.mail = { captureVersion: MAIL_CAPTURE_VERSION };
  h.service.listSyncableMailFolders = async () => ({
    folders: [],
    enumerated: true,
    coverageComplete: true,
  });
  h.service.graphGet = jest.fn(async () => ({
    value: [{ id: 'message-1' }, { id: 'message-2' }],
    '@odata.deltaLink': 'complete-mail',
  }));
  h.service.hydrateGraphMessageBody = jest.fn(async (_access: string, message: any) => message);
  h.service.persistGraphMessage = jest.fn(async () => {
    jest.setSystemTime(Date.now() + 70_000);
    return 'matched';
  });
  const run = () => h.service.syncConnectionByTenant(tenant, h.row.id, { calendar: false });
  await run();
  expect(h.row.syncState.mail.folders.inbox).toMatchObject({
    syncMode: 'backfill',
    pendingPage: { value: [{ id: 'message-2' }] },
  });
  expect(h.row.syncState.mail.folders.inbox.deltaLink).not.toBe('complete-mail');
  await run();
  expect(h.service.graphGet).toHaveBeenCalledTimes(1);
  expect(h.service.hydrateGraphMessageBody.mock.calls.map((call: any[]) => call[1].id)).toEqual([
    'message-1',
    'message-2',
  ]);
  expect(h.service.persistGraphMessage.mock.calls.map((call: any[]) => call[4])).toEqual([
    'backfill',
    'backfill',
  ]);
  expect(h.row.syncState.mail.folders.inbox.pendingPage).toBeUndefined();
  expect(h.row.syncState.mail.folders.inbox.deltaLink).toBe('complete-mail');
});

describe.each(['google-calendar', 'graph-calendar', 'graph-mail'] as const)(
  '%s durable item checkpoint',
  (stream) => {
    test.each(['deadline', 'transient'] as const)(
      'a later %s failure preserves the prefix and the next run resumes the suffix',
      async (failure) => {
        const h = setup(stream === 'google-calendar' ? 'google_workspace' : 'microsoft_365');
        const resource = stream === 'graph-mail' ? 'mail' : 'calendar';
        const lastCompleteAt = '2026-01-01T00:00:00.000Z';
        h.row.syncState.health = { [resource]: { lastCompleteAt } };
        const items = [{ id: 'item-1' }, { id: 'item-2' }];
        const completed: string[] = [];
        const attempted: string[] = [];
        let retry = false;
        const persist = jest.fn(async (...args: any[]) => {
          const item = args[stream === 'graph-mail' ? 3 : 2];
          attempted.push(item.id);
          if (!retry) {
            jest.setSystemTime(Date.now() + (failure === 'deadline' ? 60_000 : 1_000));
            assertMailboxBudget();
            if (item.id === 'item-2') throw new Error('synthetic transient item failure');
          }
          completed.push(item.id);
          return 'matched';
        });
        const list = jest.fn(async () =>
          stream === 'google-calendar'
            ? { items, nextSyncToken: 'final-token' }
            : { value: items, '@odata.deltaLink': 'final-token' },
        );
        if (stream === 'google-calendar') {
          h.service.calendarList = list;
          h.service.persistCalendarEvent = persist;
        } else if (stream === 'graph-calendar') {
          h.service.graphGet = list;
          h.service.persistGraphEvent = persist;
        } else {
          h.row.syncState.mail = { captureVersion: MAIL_CAPTURE_VERSION };
          h.service.listSyncableMailFolders = async () => ({
            folders: [],
            enumerated: true,
            coverageComplete: true,
          });
          h.service.graphGet = async (url: string) =>
            url.includes('sentitems') ? { value: [], '@odata.deltaLink': 'sent-final' } : list();
          h.service.hydrateGraphMessageBody = async (_token: string, message: any) => message;
          h.service.persistGraphMessage = persist;
        }
        const run = () =>
          h.service.syncConnectionByTenant(
            tenant,
            h.row.id,
            resource === 'mail' ? { calendar: false } : { mail: false },
          );
        if (failure === 'deadline')
          await expect(run()).rejects.toBeInstanceOf(MailboxDeadlineError);
        else await expect(run()).rejects.toThrow('synthetic transient item failure');
        const durable =
          resource === 'mail' ? h.row.syncState.mail.folders.inbox : h.row.syncState.calendar;
        expect(durable.pendingPage.items ?? durable.pendingPage.value).toEqual([{ id: 'item-2' }]);
        expect(durable.syncToken ?? durable.deltaLink).not.toBe('final-token');
        expect(h.row.syncState.health[resource]).toMatchObject({ lastCompleteAt, hasMore: true });
        if (resource === 'mail') expect(durable.syncMode).toBe('backfill');
        expect(completed).toEqual(['item-1']);
        retry = true;
        await run();
        expect(completed).toEqual(['item-1', 'item-2']);
        expect(attempted).toEqual(['item-1', 'item-2', 'item-2']);
        expect(list).toHaveBeenCalledTimes(1);
        const finished =
          resource === 'mail' ? h.row.syncState.mail.folders.inbox : h.row.syncState.calendar;
        expect(finished.pendingPage).toBeUndefined();
        expect(finished.syncToken ?? finished.deltaLink).toBe('final-token');
      },
    );
  },
);
