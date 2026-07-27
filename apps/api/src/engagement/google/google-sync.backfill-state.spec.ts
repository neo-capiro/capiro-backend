// Phase c (remaining-items plan §3.c1/c2) — the Gmail backfill query and the
// Google Calendar full-sync window must stay byte-identical across resume
// calls within the same cycle. Both rely on a provider pageToken that is only
// valid against the exact query/window that produced it; recomputing either
// from "now" on every scheduler tick would silently invalidate a still-valid
// token. Sentinel values (rather than wall-clock diffing) are used to prove
// reuse deterministically — two real `new Date()` calls close together could
// coincidentally match even on the old, buggy behavior.

import { describe, expect, jest, test } from '@jest/globals';
import { GoogleSyncService } from './google-sync.service.js';

const connection = { id: 'conn-1', accountEmail: 'user@example.com' };

function makeGmailListService(opts: {
  listImpl: (
    token: string,
    input: { query: string; pageToken?: string },
  ) => Promise<{ messages?: Array<{ id?: string }>; nextPageToken?: string }>;
}) {
  const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: jest.fn(), error: () => {} };
  patch.gmailList = jest.fn(opts.listImpl);
  patch.gmailGet = jest.fn(async (_token: string, id: string) => ({ id, labelIds: ['INBOX'] }));
  patch.persistGmailMessage = jest.fn(async () => 'matched' as const);
  patch.gmailProfile = jest.fn(async () => ({ historyId: '999' }));
  return { service, patch };
}

async function runSyncMail(
  service: GoogleSyncService,
  state: Record<string, unknown>,
  input: { reset?: boolean },
) {
  return (
    service as unknown as {
      syncMail: (
        t: string,
        c: unknown,
        s: Record<string, unknown>,
        a: string,
        i: { reset?: boolean },
      ) => Promise<unknown>;
    }
  ).syncMail('t1', connection, state, 'token', input);
}

describe('syncMail — frozen backfill query', () => {
  test('a resumed backfill reuses the exact stored query, not a freshly computed one', async () => {
    const receivedQueries: string[] = [];
    const { service } = makeGmailListService({
      listImpl: async (_token, { query }) => {
        receivedQueries.push(query);
        return { messages: [], nextPageToken: 'page-2' };
      },
    });
    const state: Record<string, unknown> = {};

    // Run 1 hits the 12-page cap and freezes+stores a query.
    await runSyncMail(service, state, {});
    const mail = state.mail as {
      labels: Record<string, { backfillQuery?: string; backfillPageToken?: string | null }>;
    };
    expect(mail.labels['ALL']?.backfillQuery).toBeTruthy();
    expect(mail.labels['ALL']?.backfillPageToken).toBe('page-2');

    // Sentinel-mark so any recomputation is obviously distinguishable from a
    // genuine reuse.
    mail.labels['ALL']!.backfillQuery = 'SENTINEL-QUERY';
    receivedQueries.length = 0;

    await runSyncMail(service, state, {}); // run 2: resumes
    expect(receivedQueries[0]).toBe('SENTINEL-QUERY');
  });

  test('reset discards the old page token and starts page one fresh', async () => {
    const receivedPageTokens: Array<string | undefined> = [];
    const { service } = makeGmailListService({
      listImpl: async (_token, { pageToken }) => {
        receivedPageTokens.push(pageToken);
        return { messages: [], nextPageToken: 'page-2' };
      },
    });
    const state: Record<string, unknown> = {};

    await runSyncMail(service, state, {});
    const mail = state.mail as { labels: Record<string, { backfillPageToken?: string | null }> };
    expect(mail.labels['ALL']?.backfillPageToken).toBe('page-2');

    receivedPageTokens.length = 0;
    await runSyncMail(service, state, { reset: true });

    expect(receivedPageTokens[0]).toBeUndefined();
  });

  test('a legacy page token with no stored query discards the token, warns once, and restarts from page one', async () => {
    const receivedPageTokens: Array<string | undefined> = [];
    const { service, patch } = makeGmailListService({
      listImpl: async (_token, { pageToken }) => {
        receivedPageTokens.push(pageToken);
        return { messages: [], nextPageToken: 'page-2' };
      },
    });
    const state: Record<string, unknown> = {
      mail: { labels: { ALL: { backfillPageToken: 'legacy-token', backfillDone: false } } },
    };

    await runSyncMail(service, state, {});

    expect(receivedPageTokens[0]).toBeUndefined();
    expect((patch.logger as { warn: jest.Mock }).warn).toHaveBeenCalledTimes(1);
    const mail = state.mail as { labels: Record<string, { backfillQuery?: string }> };
    expect(mail.labels['ALL']?.backfillQuery).toBeTruthy();
  });
});

function makeCalendarService(opts: {
  listImpl: (
    token: string,
    input: {
      syncToken?: string;
      window?: { from: string; to: string };
      pageToken?: string;
    },
  ) => Promise<{ items?: unknown[]; nextPageToken?: string; nextSyncToken?: string }>;
}) {
  const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: jest.fn(), error: () => {} };
  patch.calendarList = jest.fn(opts.listImpl);
  patch.persistCalendarEvent = jest.fn(async () => 'matched' as const);
  return { service, patch };
}

async function runSyncCalendar(
  service: GoogleSyncService,
  state: Record<string, unknown>,
  input: { reset?: boolean },
) {
  return (
    service as unknown as {
      syncCalendar: (
        t: string,
        c: unknown,
        s: Record<string, unknown>,
        a: string,
        i: { reset?: boolean },
      ) => Promise<unknown>;
    }
  ).syncCalendar('t1', connection, state, 'token', input);
}

describe('syncCalendar — frozen full-sync window', () => {
  test('the full-sync window remains byte-identical across resume calls', async () => {
    const receivedWindows: Array<{ from: string; to: string } | undefined> = [];
    const { service } = makeCalendarService({
      listImpl: async (_token, { window }) => {
        receivedWindows.push(window);
        return { items: [], nextPageToken: 'page-2' };
      },
    });
    const state: Record<string, unknown> = {};

    await runSyncCalendar(service, state, {});
    const calendar = state.calendar as { window?: { from: string; to: string } };
    expect(calendar.window).toBeTruthy();

    // Sentinel-mark so any recomputation is obviously distinguishable.
    calendar.window = { from: 'SENTINEL-FROM', to: 'SENTINEL-TO' };
    receivedWindows.length = 0;

    await runSyncCalendar(service, state, {}); // resumes
    expect(receivedWindows[0]).toEqual({ from: 'SENTINEL-FROM', to: 'SENTINEL-TO' });
  });

  test('a legacy page token with no stored window discards the token, warns once, and restarts', async () => {
    const receivedPageTokens: Array<string | undefined> = [];
    const { service, patch } = makeCalendarService({
      listImpl: async (_token, { pageToken }) => {
        receivedPageTokens.push(pageToken);
        return { items: [], nextPageToken: 'page-2' };
      },
    });
    const state: Record<string, unknown> = { calendar: { pageToken: 'legacy-token' } };

    await runSyncCalendar(service, state, {});

    expect(receivedPageTokens[0]).toBeUndefined();
    expect((patch.logger as { warn: jest.Mock }).warn).toHaveBeenCalledTimes(1);
    const calendar = state.calendar as { window?: unknown };
    expect(calendar.window).toBeTruthy();
  });

  test('a sync-token incremental call sends no window (no timeMin/timeMax)', async () => {
    const receivedWindows: unknown[] = [];
    const receivedSyncTokens: Array<string | undefined> = [];
    const { service } = makeCalendarService({
      listImpl: async (_token, { window, syncToken }) => {
        receivedWindows.push(window);
        receivedSyncTokens.push(syncToken);
        return { items: [], nextSyncToken: 'sync-2' };
      },
    });
    const state: Record<string, unknown> = { calendar: { syncToken: 'sync-1' } };

    await runSyncCalendar(service, state, {});

    expect(receivedSyncTokens[0]).toBe('sync-1');
    expect(receivedWindows[0]).toBeUndefined();
  });
});
