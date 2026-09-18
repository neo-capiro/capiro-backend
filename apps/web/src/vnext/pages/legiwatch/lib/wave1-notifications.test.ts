/**
 * committee-follow alerts — wave1-api notification hooks.
 *
 * Covers: identity-scoped query keys (no cross-user bleed), pagination params,
 * read / read-all mutations invalidating the shared notifications prefix, and
 * the preferences GET/PUT round-trip seeding from the SERVER response.
 */
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>();
const apiPost = vi.fn<(url: string, body: unknown) => Promise<{ data: unknown }>>();
const apiPut = vi.fn<(url: string, body: unknown) => Promise<{ data: unknown }>>();

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string, config?: unknown) => apiGet(url, config),
    post: (url: string, body: unknown) => apiPost(url, body),
    put: (url: string, body: unknown) => apiPut(url, body),
  }),
}));

// Identity is the query-key partition; fake a signed-in user.
vi.mock('./saved-hearing-sessions.js', () => ({
  useHearingQueryIdentity: () => ({ identity: 'tenant-1:user-1', ready: true }),
}));

import {
  useLwNotifications,
  useMarkAllLwNotificationsRead,
  useMarkLwNotificationRead,
  useLwNotificationPreferences,
  useSaveLwNotificationPreferences,
  useSaveCommitteeFollow,
  w1Keys,
  type LwNotificationsPage,
} from './wave1-api.js';

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

const PAGE: LwNotificationsPage = {
  rows: [
    {
      id: 'n-1',
      eventType: 'committee_publication',
      hearingId: null,
      committeeSystemCode: 'HLIG01',
      clientId: null,
      title: 'Witness testimony published',
      body: null,
      deepLink: '/legiwatch/committees/HLIG01',
      read: false,
      createdAt: '2026-09-17T10:00:00Z',
    },
  ],
  total: 1,
  unread: 1,
  page: 1,
  pageSize: 100,
  hasMore: false,
};

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
});

afterEach(() => qc.clear());

describe('useLwNotifications', () => {
  it('requests unread feed with page/pageSize and identity-scoped key', async () => {
    apiGet.mockResolvedValue({ data: PAGE });
    const { result } = renderHook(() => useLwNotifications(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = apiGet.mock.calls[0]![0]!;
    expect(url).toContain('/api/legiwatch/live-hearings/notifications?');
    expect(url).toContain('unreadOnly=true');
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=100');
    expect(result.current.data?.rows[0]?.id).toBe('n-1');
    // Identity inside the key: tenant/user switch can never share this entry.
    expect(w1Keys.notifications(true, 100, 'tenant-1:user-1')).toEqual([
      'lw-w1',
      'notifications',
      true,
      100,
      'tenant-1:user-1',
    ]);
  });
});

describe('read mutations', () => {
  it('mark read POSTs the row id and invalidates the whole notifications prefix', async () => {
    apiGet.mockResolvedValue({ data: PAGE });
    apiPost.mockResolvedValue({ data: { read: true } });

    const list = renderHook(() => useLwNotifications(true), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));

    const mutation = renderHook(() => useMarkLwNotificationRead(), { wrapper });
    mutation.result.current.mutate('n-1');
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true));

    expect(apiPost.mock.calls[0]![0]).toBe(
      '/api/legiwatch/live-hearings/notifications/n-1/read',
    );
    // Prefix invalidation: the invalidated queries include both unread+history.
    const state = qc.getQueryCache().findAll({ queryKey: ['lw-w1', 'notifications'] });
    expect(state.length).toBeGreaterThan(0);
    await waitFor(() => expect(apiGet.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('HTTP 200 with read:false is a mutation ERROR, not a success', async () => {
    // Backend returns {read:false} for a nonexistent/ineligible id — the UI
    // must treat it as failed (no navigate, no clear).
    apiPost.mockResolvedValue({ data: { read: false } });
    const mutation = renderHook(() => useMarkLwNotificationRead(), { wrapper });
    mutation.result.current.mutate('ghost-id');
    await waitFor(() => expect(mutation.result.current.isError).toBe(true));
    expect(mutation.result.current.error?.message).toContain('could not be marked read');
    expect(mutation.result.current.isSuccess).toBe(false);
  });

  it('read-all POSTs the server-wide endpoint (not per-row)', async () => {
    apiPost.mockResolvedValue({ data: { read: 7 } });
    const mutation = renderHook(() => useMarkAllLwNotificationsRead(), { wrapper });
    mutation.result.current.mutate();
    await waitFor(() => expect(mutation.result.current.isSuccess).toBe(true));
    expect(apiPost.mock.calls[0]![0]).toBe(
      '/api/legiwatch/live-hearings/notifications/read-all',
    );
    expect(mutation.result.current.data?.read).toBe(7);
  });
});

describe('notification preferences', () => {
  it('GET reads current state; PUT seeds cache from the SERVER response', async () => {
    apiGet.mockResolvedValue({
      data: { committeeEmailEnabled: false, emailAddress: 'neo@capiro.ai' },
    });
    apiPut.mockResolvedValue({
      data: { committeeEmailEnabled: true, emailAddress: 'neo@capiro.ai' },
    });

    const prefs = renderHook(() => useLwNotificationPreferences(), { wrapper });
    await waitFor(() => expect(prefs.result.current.isSuccess).toBe(true));
    expect(apiGet.mock.calls[0]![0]).toBe(
      '/api/legiwatch/live-hearings/notification-preferences',
    );
    expect(prefs.result.current.data?.committeeEmailEnabled).toBe(false);

    const save = renderHook(() => useSaveLwNotificationPreferences(), { wrapper });
    save.result.current.mutate({ committeeEmailEnabled: true });
    await waitFor(() => expect(save.result.current.isSuccess).toBe(true));
    expect(apiPut.mock.calls[0]).toEqual([
      '/api/legiwatch/live-hearings/notification-preferences',
      { committeeEmailEnabled: true },
    ]);
    // Cache holds what the server returned, not the requested value.
    expect(prefs.result.current.data?.committeeEmailEnabled).toBe(true);
  });

  it('a refusal surfaces as a mutation error (settings renders its message)', async () => {
    apiPut.mockRejectedValue({
      response: { data: { message: 'Your account has no valid email address.' } },
    });
    const save = renderHook(() => useSaveLwNotificationPreferences(), { wrapper });
    save.result.current.mutate({ committeeEmailEnabled: true });
    await waitFor(() => expect(save.result.current.isError).toBe(true));
  });
});

describe('committee follow catch-up', () => {
  it('saving a follow invalidates the shared notifications feed', async () => {
    apiPut.mockResolvedValue({
      data: {
        committeeSystemCode: 'HLIG01',
        following: true,
        clientIds: [],
        clients: [],
        notifyOnNewHearing: true,
        notifyOnScheduleChange: true,
        notifyOnTranscriptReady: false,
        notifyOnHighPriorityMatch: true,
        notifyOnPublication: true,
      },
    });
    apiGet.mockResolvedValue({ data: PAGE });
    // Prime the notifications cache so invalidation is observable.
    const list = renderHook(() => useLwNotifications(true), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const callsBefore = apiGet.mock.calls.length;

    const save = renderHook(() => useSaveCommitteeFollow('HLIG01'), { wrapper });
    save.result.current.mutate({ notifyOnPublication: true });
    await waitFor(() => expect(save.result.current.isSuccess).toBe(true));

    const putBody = apiPut.mock.calls[0]![1] as { notifyOnPublication?: boolean };
    expect(putBody.notifyOnPublication).toBe(true);
    await waitFor(() => expect(apiGet.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});
