import { harness, ctx, tenant } from './mailbox-oauth.a1-fixture.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';

const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };
function setup(provider: 'google_workspace' | 'microsoft_365' = 'microsoft_365') {
  const h = harness(provider);
  const row = h.rows.get('connection-A');
  row.token.expiresAt = new Date(Date.now() + 3_600_000);
  row.syncState = {
    calendar: { cursor: 'scheduled-delta' },
    mail: { cursor: 'mail-delta' },
    webhooks: { configured: true },
  };
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
      googleToken: {
        loadConnection: async () => ({ connection: structuredClone(row), token: row.token }),
        getValidAccessToken: async () => 'access',
      },
    },
  );
  service.getValidAccessToken = async () => 'access';
  service.persistGraphEvent = jest.fn(async () => 'matched');
  service.persistCalendarEvent = jest.fn(async () => 'matched');
  return {
    ...h,
    row,
    service,
    run: (range = window) => service.syncCalendarWindow(ctx, row.id, range),
  };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('explicit window checkpoints a slow page suffix and resumes without importing its prefix twice', async () => {
  const h = setup();
  h.service.graphGet = jest.fn(async () => ({ value: [{ id: 'first' }, { id: 'second' }] }));
  h.service.persistGraphEvent.mockImplementation(async () => {
    jest.setSystemTime(Date.now() + 70_000);
    return 'matched';
  });
  await expect(h.run()).resolves.toMatchObject({ scanned: 1, hasMore: true });
  expect(h.row.syncState.calendarWindow.pendingPage.value).toEqual([{ id: 'second' }]);
  await expect(h.run()).resolves.toMatchObject({ scanned: 1, hasMore: false });
  expect(h.service.graphGet).toHaveBeenCalledTimes(1);
  expect(h.service.persistGraphEvent.mock.calls.map((call: any[]) => call[2].id)).toEqual([
    'first',
    'second',
  ]);
  expect(h.row.syncState.calendar).toEqual({ cursor: 'scheduled-delta' });
  expect(h.row.syncState.mail).toEqual({ cursor: 'mail-delta' });
  expect(h.row.syncState.webhooks).toEqual({ configured: true });
});

test('a failed later window item preserves the committed prefix and exact reviewed range', async () => {
  const h = setup();
  h.service.graphGet = jest.fn(async () => ({ value: [{ id: 'first' }, { id: 'second' }] }));
  h.service.persistGraphEvent
    .mockResolvedValueOnce('matched')
    .mockRejectedValueOnce(new Error('item interrupted'))
    .mockResolvedValue('matched');
  await expect(h.run()).rejects.toThrow('item interrupted');
  expect(h.row.syncState.calendarWindow).toMatchObject({
    window,
    pendingPage: { value: [{ id: 'second' }] },
  });
  await expect(h.run()).resolves.toMatchObject({ scanned: 1, hasMore: false });
  expect(h.service.graphGet).toHaveBeenCalledTimes(1);
});

test('an unfinished window cannot be replaced by a different range', async () => {
  const h = setup();
  h.row.syncState.calendarWindow = {
    window,
    nextLink: '/resume',
    pendingPage: { value: [{ id: 'remaining' }] },
  };
  h.service.graphGet = jest.fn();
  await expect(h.run({ ...window, to: '2026-12-01T00:00:00.000Z' })).rejects.toThrow(
    'unfinished calendar window',
  );
  expect(h.service.graphGet).not.toHaveBeenCalled();
  expect(h.service.persistGraphEvent).not.toHaveBeenCalled();
  expect(h.row.syncState.calendarWindow.window).toEqual(window);
});

test('window page cap retains the continuation; canonical equivalent dates resume it', async () => {
  const h = setup();
  let page = 0;
  h.service.graphGet = jest.fn(async () => ({
    value: [],
    ...(page++ < 12 ? { '@odata.nextLink': `/page-${page}` } : {}),
  }));
  await expect(h.run()).resolves.toMatchObject({ pages: 12, hasMore: true });
  expect(h.row.syncState.calendarWindow.nextLink).toBe('/page-12');
  await expect(h.run({ from: '2026-10-01', to: '2026-11-01' })).resolves.toMatchObject({
    pages: 1,
    hasMore: false,
  });
  expect(h.service.graphGet.mock.calls[12][0]).toBe('/page-12');
});

test('a token refresh consuming the run budget retains the reviewed window without fetching a page', async () => {
  const h = setup();
  h.service.getValidAccessToken = async () => {
    jest.setSystemTime(Date.now() + 80_000);
    return 'access';
  };
  h.service.graphGet = jest.fn();
  await expect(h.run()).resolves.toMatchObject({ scanned: 0, hasMore: true });
  expect(h.row.syncState.calendarWindow.window).toEqual(window);
  expect(h.service.graphGet).not.toHaveBeenCalled();
});

test('a completed window permits a newly reviewed range without replacing scheduled delta state', async () => {
  const h = setup();
  h.row.syncState.calendarWindow = { window, nextLink: null, lastStats: { hasMore: false } };
  h.service.graphGet = jest.fn(async () => ({ value: [] }));
  const nextWindow = { ...window, to: '2026-12-01T00:00:00.000Z' };
  await expect(h.run(nextWindow)).resolves.toMatchObject({ hasMore: false });
  expect(h.row.syncState.calendarWindow.window).toEqual(nextWindow);
  expect(h.row.syncState.calendar).toEqual({ cursor: 'scheduled-delta' });
  const requested = new URL(h.service.graphGet.mock.calls[0][0], 'https://graph.invalid');
  expect(requested.pathname).toBe('/me/calendarView');
  expect(requested.searchParams.get('endDateTime')).toBe(nextWindow.to);
});

test.each(['google_workspace', 'microsoft_365'] as const)(
  '%s checkpoints an empty page before requesting the next page',
  async (provider) => {
    const h = setup(provider);
    h.row.syncState.calendar = {};
    const list = jest
      .fn()
      .mockResolvedValueOnce(
        provider === 'microsoft_365'
          ? { value: [], '@odata.nextLink': '/next-page' }
          : { items: [], nextPageToken: 'next-page' },
      )
      .mockRejectedValueOnce(new Error('next page interrupted'))
      .mockResolvedValue(
        provider === 'microsoft_365'
          ? { value: [], '@odata.deltaLink': 'complete' }
          : { items: [], nextSyncToken: 'complete' },
      );
    h.service.graphGet = list;
    h.service.calendarList = list;
    const run = () => h.service.syncConnectionByTenant(tenant, h.row.id, { mail: false });
    await expect(run()).rejects.toThrow('next page interrupted');
    expect(
      provider === 'microsoft_365'
        ? h.row.syncState.calendar.nextLink
        : h.row.syncState.calendar.pageToken,
    ).toBe(provider === 'microsoft_365' ? '/next-page' : 'next-page');
    await run();
    const last = list.mock.calls[2];
    expect(provider === 'microsoft_365' ? last[0] : last[1].pageToken).toBe(
      provider === 'microsoft_365' ? '/next-page' : 'next-page',
    );
  },
);

test('explicit window checkpoints an empty page before a later provider failure', async () => {
  const h = setup();
  h.service.graphGet = jest
    .fn()
    .mockResolvedValueOnce({ value: [], '@odata.nextLink': '/next-window-page' })
    .mockRejectedValueOnce(new Error('provider interrupted'))
    .mockResolvedValue({ value: [] });
  await expect(h.run()).rejects.toThrow('provider interrupted');
  expect(h.row.syncState.calendarWindow.nextLink).toBe('/next-window-page');
  await h.run();
  expect(h.service.graphGet.mock.calls[2][0]).toBe('/next-window-page');
});

test('Google expired delta is partial until the required replacement full sync completes', async () => {
  const h = setup('google_workspace');
  const lastCompleteAt = '2026-09-01T00:00:00.000Z';
  h.row.syncState.calendar = { syncToken: 'expired' };
  h.row.syncState.health = { calendar: { lastCompleteAt } };
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('{"error":"gone"}', { status: 410 }))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextSyncToken: 'replacement' }), { status: 200 }),
    );
  const run = () => h.service.syncConnectionByTenant(tenant, h.row.id, { mail: false });
  await expect(run()).resolves.toMatchObject({
    calendar: { hasMore: true },
    health: { calendar: { outcome: 'partial', lastCompleteAt } },
  });
  expect(h.row.syncState.calendar.syncToken).toBeNull();
  await expect(run()).resolves.toMatchObject({
    calendar: { hasMore: false },
    health: { calendar: { outcome: 'complete' } },
  });
  const second = new URL(String(fetch.mock.calls[1]![0]));
  expect(second.searchParams.has('syncToken')).toBe(false);
  expect(second.searchParams.has('timeMin')).toBe(true);
  expect(second.searchParams.has('timeMax')).toBe(true);
});
