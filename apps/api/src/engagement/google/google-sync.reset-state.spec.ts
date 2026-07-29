/**
 * Final closeout for reset/reclaim state transitions.
 *
 * The ordinary pagination specs prove that Gmail and Calendar can resume a
 * page chain. These tests prove the harder interaction: an established
 * incremental baseline must be discarded while a reset/full-window page chain
 * is incomplete, and hybrid state left by an older build must recover without
 * skipping the authoritative continuation.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { GoogleSyncService } from './google-sync.service.js';

const connection = { id: 'conn-1', accountEmail: 'user@example.com' };

type MailState = {
  mail?: {
    historyId?: string | null;
    incrementalPageToken?: string | null;
    incrementalLatestHistoryId?: string | null;
    labels?: Record<
      string,
      {
        backfillPageToken?: string | null;
        backfillDone?: boolean;
        backfillQuery?: string | null;
      }
    >;
  };
};

type CalendarState = {
  calendar?: {
    syncToken?: string | null;
    pageToken?: string | null;
    window?: { from: string; to: string };
  };
};

async function runSyncMail(
  service: GoogleSyncService,
  state: MailState,
  input: { reset?: boolean },
) {
  return (
    service as unknown as {
      syncMail: (
        tenantId: string,
        conn: unknown,
        syncState: MailState,
        accessToken: string,
        options: { reset?: boolean },
      ) => Promise<Record<string, { hasMore: boolean; pages: number }>>;
    }
  ).syncMail('tenant-1', connection, state, 'token', input);
}

async function runSyncCalendar(
  service: GoogleSyncService,
  state: CalendarState,
  input: { reset?: boolean },
) {
  return (
    service as unknown as {
      syncCalendar: (
        tenantId: string,
        conn: unknown,
        syncState: CalendarState,
        accessToken: string,
        options: { reset?: boolean },
      ) => Promise<{ hasMore: boolean; pages: number }>;
    }
  ).syncCalendar('tenant-1', connection, state, 'token', input);
}

function mailHarness(
  listResponses: Array<{ messages?: Array<{ id?: string }>; nextPageToken?: string }>,
  profileHistoryId: string | undefined,
) {
  const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: jest.fn(), error: jest.fn() };
  patch.gmailList = jest.fn(async () => {
    const response = listResponses.shift();
    if (!response) throw new Error('unexpected gmailList call');
    return response;
  });
  patch.gmailHistory = jest.fn(async () => {
    throw new Error('history.list must not run while a full backfill continuation exists');
  });
  patch.gmailGet = jest.fn(async (_token: string, id: string) => ({ id, labelIds: ['INBOX'] }));
  patch.persistGmailMessage = jest.fn(async () => 'matched' as const);
  patch.gmailProfile = jest.fn(async () => ({ historyId: profileHistoryId }));
  return { service, patch };
}

function calendarHarness(
  listResponses: Array<{
    items?: unknown[];
    nextPageToken?: string;
    nextSyncToken?: string;
  }>,
) {
  const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: jest.fn(), error: jest.fn() };
  patch.calendarList = jest.fn(async () => {
    const response = listResponses.shift();
    if (!response) throw new Error('unexpected calendarList call');
    return response;
  });
  patch.persistCalendarEvent = jest.fn(async () => 'matched' as const);
  return { service, patch };
}

describe('Gmail reset/reclaim state', () => {
  test('an established mailbox reset clears the old history baseline until the full backfill finishes', async () => {
    const cappedPages = Array.from({ length: 12 }, (_, index) => ({
      messages: [],
      nextPageToken: `page-${index + 2}`,
    }));
    const { service, patch } = mailHarness([...cappedPages, { messages: [] }], 'new-history');
    const state: MailState = {
      mail: {
        historyId: 'old-history',
        incrementalPageToken: 'old-incremental-page',
        incrementalLatestHistoryId: 'old-incremental-latest',
        labels: {
          ALL: {
            backfillPageToken: null,
            backfillDone: true,
            backfillQuery: 'OLD-QUERY',
          },
        },
      },
    };

    const first = await runSyncMail(service, state, { reset: true });
    const afterFirst = state.mail!;
    const frozenQuery = afterFirst.labels!.ALL!.backfillQuery;

    expect(first.ALL).toMatchObject({ hasMore: true, pages: 12 });
    expect(afterFirst.historyId).toBeNull();
    expect(afterFirst.incrementalPageToken).toBeUndefined();
    expect(afterFirst.incrementalLatestHistoryId).toBeUndefined();
    expect(afterFirst.labels!.ALL).toMatchObject({
      backfillPageToken: 'page-13',
      backfillDone: false,
    });
    expect(frozenQuery).toContain('-in:spam -in:trash -in:draft');
    expect(patch.gmailHistory).not.toHaveBeenCalled();

    const second = await runSyncMail(service, state, {});
    const listCalls = (patch.gmailList as jest.Mock).mock.calls;

    expect(second.ALL).toMatchObject({ hasMore: false, pages: 1 });
    expect(listCalls[12]?.[1]).toEqual({
      query: frozenQuery,
      pageToken: 'page-13',
    });
    expect(state.mail).toMatchObject({ historyId: 'new-history' });
    expect(state.mail!.labels!.ALL).toMatchObject({
      backfillPageToken: null,
      backfillDone: true,
      backfillQuery: frozenQuery,
    });
    expect(patch.gmailHistory).not.toHaveBeenCalled();
  });

  test('hybrid legacy state prioritizes the saved full-backfill page over a stale historyId', async () => {
    const { service, patch } = mailHarness([{ messages: [] }], 'recovered-history');
    const state: MailState = {
      mail: {
        historyId: 'stale-history',
        labels: {
          ALL: {
            backfillPageToken: 'page-13',
            backfillDone: false,
            backfillQuery: 'FROZEN-QUERY',
          },
        },
      },
    };

    await runSyncMail(service, state, {});

    expect(patch.gmailList).toHaveBeenCalledWith('token', {
      query: 'FROZEN-QUERY',
      pageToken: 'page-13',
    });
    expect(patch.gmailHistory).not.toHaveBeenCalled();
    expect((patch.logger as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
      expect.stringContaining('unfinished full backfill'),
    );
    expect(state.mail).toMatchObject({ historyId: 'recovered-history' });
    expect(state.mail!.labels!.ALL).toMatchObject({
      backfillPageToken: null,
      backfillDone: true,
    });
  });

  test('a backfill page token overrides a contradictory completed flag', async () => {
    const { service, patch } = mailHarness([{ messages: [] }], 'recovered-history');
    const state: MailState = {
      mail: {
        labels: {
          ALL: {
            backfillPageToken: 'page-13',
            backfillDone: true,
            backfillQuery: 'FROZEN-QUERY',
          },
        },
      },
    };

    await runSyncMail(service, state, {});

    expect(patch.gmailList).toHaveBeenCalledWith('token', {
      query: 'FROZEN-QUERY',
      pageToken: 'page-13',
    });
    expect((patch.logger as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
      expect.stringContaining('page token marked complete'),
    );
    expect(state.mail).toMatchObject({ historyId: 'recovered-history' });
    expect(state.mail!.labels!.ALL).toMatchObject({
      backfillPageToken: null,
      backfillDone: true,
    });
  });
});

describe('Google Calendar reset state', () => {
  test('a paginated reset clears the old sync token, resumes the frozen window, then installs the new token', async () => {
    const cappedPages = Array.from({ length: 12 }, (_, index) => ({
      items: [],
      nextPageToken: `page-${index + 2}`,
    }));
    const { service, patch } = calendarHarness([
      ...cappedPages,
      { items: [], nextSyncToken: 'new-sync-token' },
    ]);
    const state: CalendarState = {
      calendar: {
        syncToken: 'old-sync-token',
        pageToken: 'old-page-token',
        window: { from: 'OLD-FROM', to: 'OLD-TO' },
      },
    };

    const first = await runSyncCalendar(service, state, { reset: true });
    const frozenWindow = state.calendar!.window;

    expect(first).toMatchObject({ hasMore: true, pages: 12 });
    expect(state.calendar).toMatchObject({
      syncToken: null,
      pageToken: 'page-13',
    });
    expect(frozenWindow).toBeDefined();
    expect(frozenWindow).not.toEqual({ from: 'OLD-FROM', to: 'OLD-TO' });

    const second = await runSyncCalendar(service, state, {});
    const listCalls = (patch.calendarList as jest.Mock).mock.calls;

    expect(second).toMatchObject({ hasMore: false, pages: 1 });
    expect(listCalls[12]?.[1]).toEqual({
      syncToken: undefined,
      window: frozenWindow,
      pageToken: 'page-13',
    });
    expect(state.calendar).toMatchObject({
      syncToken: 'new-sync-token',
      pageToken: null,
      window: frozenWindow,
    });
  });

  test('ambiguous legacy pageToken+syncToken+window state restarts the full window fail-closed', async () => {
    const { service, patch } = calendarHarness([
      { items: [], nextSyncToken: 'recovered-sync-token' },
    ]);
    const legacyWindow = { from: 'SENTINEL-FROM', to: 'SENTINEL-TO' };
    const state: CalendarState = {
      calendar: {
        syncToken: 'stale-sync-token',
        pageToken: 'page-9',
        window: legacyWindow,
      },
    };

    await runSyncCalendar(service, state, {});

    expect(patch.calendarList).toHaveBeenCalledWith('token', {
      syncToken: undefined,
      window: expect.any(Object),
      pageToken: undefined,
    });
    const firstCall = (patch.calendarList as jest.Mock).mock.calls[0]?.[1] as {
      window?: { from: string; to: string };
    };
    expect(firstCall.window).not.toEqual(legacyWindow);
    expect((patch.logger as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
      expect.stringContaining('ambiguous legacy continuation'),
    );
    expect(state.calendar).toMatchObject({
      syncToken: 'recovered-sync-token',
      pageToken: null,
    });
    expect(state.calendar!.window).not.toEqual(legacyWindow);
  });

  test('paginated incremental sync retains its sync token and never acquires a full-window marker', async () => {
    const cappedPages = Array.from({ length: 12 }, (_, index) => ({
      items: [],
      nextPageToken: `incremental-${index + 2}`,
    }));
    const { service, patch } = calendarHarness([
      ...cappedPages,
      { items: [], nextSyncToken: 'sync-token-2' },
    ]);
    const state: CalendarState = {
      calendar: {
        syncToken: 'sync-token-1',
        window: { from: 'OLD-FULL-FROM', to: 'OLD-FULL-TO' },
      },
    };

    const first = await runSyncCalendar(service, state, {});

    expect(first).toMatchObject({ hasMore: true, pages: 12 });
    expect(state.calendar).toEqual(
      expect.objectContaining({
        syncToken: 'sync-token-1',
        pageToken: 'incremental-13',
      }),
    );
    expect(state.calendar).not.toHaveProperty('window');

    const second = await runSyncCalendar(service, state, {});
    const listCalls = (patch.calendarList as jest.Mock).mock.calls;

    expect(second).toMatchObject({ hasMore: false, pages: 1 });
    expect(listCalls[12]?.[1]).toEqual({
      syncToken: 'sync-token-1',
      window: undefined,
      pageToken: 'incremental-13',
    });
    expect(state.calendar).toEqual(
      expect.objectContaining({
        syncToken: 'sync-token-2',
        pageToken: null,
      }),
    );
    expect(state.calendar).not.toHaveProperty('window');
  });

  test('a one-page reset installs only the replacement sync token', async () => {
    const { service, patch } = calendarHarness([
      { items: [], nextSyncToken: 'replacement-sync-token' },
    ]);
    const state: CalendarState = {
      calendar: {
        syncToken: 'old-sync-token',
        pageToken: 'old-page-token',
        window: { from: 'OLD-FROM', to: 'OLD-TO' },
      },
    };

    await runSyncCalendar(service, state, { reset: true });

    expect(patch.calendarList).toHaveBeenCalledWith('token', {
      syncToken: undefined,
      window: expect.any(Object),
      pageToken: undefined,
    });
    expect(state.calendar).toEqual(
      expect.objectContaining({
        syncToken: 'replacement-sync-token',
        pageToken: null,
      }),
    );
    expect(state.calendar!.window).not.toEqual({ from: 'OLD-FROM', to: 'OLD-TO' });
  });
});

describe('combined Google reset orchestration', () => {
  function orchestrationHarness() {
    const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
    const patch = service as unknown as Record<string, unknown>;
    const persistConnection = jest.fn(async () => undefined);
    const markSyncError = jest.fn(async () => undefined);
    patch.logger = { warn: jest.fn(), error: jest.fn() };
    patch.googleToken = {
      loadConnection: jest.fn(async () => ({
        connection: { id: 'conn-1', syncState: {} },
        token: {},
      })),
      getValidAccessToken: jest.fn(async () => 'token'),
    };
    patch.syncCalendar = jest.fn(async () => ({
      scanned: 0,
      matched: 0,
      skipped: 0,
      removed: 0,
      failed: 0,
      pages: 1,
      hasMore: false,
    }));
    patch.syncMail = jest.fn(async () => {
      throw new Error('transient mail failure');
    });
    patch.prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
        fn({ integrationConnection: { update: persistConnection } }),
      ),
    };
    patch.markSyncError = markSyncError;
    return { service, patch, persistConnection, markSyncError };
  }

  test('a reset surfaces a transient mail failure even after Calendar succeeded', async () => {
    const { service, persistConnection, markSyncError } = orchestrationHarness();

    await expect(
      service.syncConnectionByTenant('tenant-1', 'conn-1', { reset: true }),
    ).rejects.toThrow('transient mail failure');

    expect(markSyncError).toHaveBeenCalledWith(
      'tenant-1',
      'conn-1',
      expect.objectContaining({ message: 'transient mail failure' }),
    );
    expect(persistConnection).not.toHaveBeenCalled();
  });

  test('an ordinary sync still preserves a successful Calendar leg across a transient mail failure', async () => {
    const { service, patch, persistConnection, markSyncError } = orchestrationHarness();

    await expect(service.syncConnectionByTenant('tenant-1', 'conn-1')).resolves.toMatchObject({
      connectionId: 'conn-1',
      calendar: { hasMore: false, pages: 1 },
    });

    expect(markSyncError).not.toHaveBeenCalled();
    expect(persistConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn-1' },
        data: expect.objectContaining({ status: 'connected', lastError: null }),
      }),
    );
    expect((patch.logger as { warn: jest.Mock }).warn).toHaveBeenCalledWith(
      expect.stringContaining('calendar synced OK'),
    );
  });
});
