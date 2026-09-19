/**
 * committee-follow alerts — NotificationBell merged feed.
 *
 * Two real sources in one dropdown: workspace notifications (invites etc.)
 * and durable committee/hearing notifications. Covers: combined list newest-
 * first with namespaced keys, committee row read-then-navigate (navigation
 * ONLY after the read persists), mark-all hitting BOTH sources, per-source
 * failure notes preserving the surviving feed, and invite actions intact.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string, config?: unknown) => Promise<{ data: unknown }>>();
const apiPost = vi.fn<(url: string, body: unknown) => Promise<{ data: unknown }>>();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string, config?: unknown) => apiGet(url, config),
    post: (url: string, body: unknown) => apiPost(url, body),
  }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 't', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
// Identity-scoped lw keys.
vi.mock('../../pages/legiwatch/lib/saved-hearing-sessions.js', () => ({
  useHearingQueryIdentity: () => ({ identity: 'tenant-1:user-1', ready: true }),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: vi.fn() };
});

import { NotificationBell } from './index.js';
import { ShellOverlayProvider } from '../overlay-manager.js';

const LW_PATH = '/api/legiwatch/live-hearings/notifications';
const WS_PATH = '/workspace-api/notifications';

const navigate = vi.fn();
vi.mocked(useNavigate).mockReturnValue(navigate);

const LW_PAGE = {
  rows: [
    {
      id: 'lw-1',
      eventType: 'committee_publication',
      hearingId: null,
      committeeSystemCode: 'HLIG01',
      clientId: null,
      title: 'Witness testimony published',
      body: null,
      deepLink: '/legiwatch/committees/HLIG01',
      read: false,
      createdAt: '2026-09-17T12:00:00Z',
    },
    {
      id: 'lw-2',
      eventType: 'new_hearing',
      hearingId: 'h-9',
      committeeSystemCode: 'HLIG01',
      clientId: null,
      title: 'Hearing announced: FY27 posture',
      body: null,
      deepLink: '/legiwatch/hearings/h-9',
      read: false,
      createdAt: '2026-09-17T08:00:00Z',
    },
  ],
  total: 2,
  unread: 2,
  page: 1,
  pageSize: 100,
  hasMore: false,
};

const WS_FEED = {
  items: [
    {
      id: 'ws-1',
      kind: 'collab_invite',
      draftId: 'd-1',
      collaboratorId: 'c-1',
      actorName: 'Ada',
      draftTitle: 'Draft Q3',
      role: 'editor',
      message: 'Ada invited you to Draft Q3',
      read: false,
      actionable: true,
      createdAt: '2026-09-17T10:00:00Z',
    },
  ],
  unread: 1,
};

function renderBell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        null,
        createElement(
          ShellOverlayProvider,
          null,
          createElement(NotificationBell, {
            notifications: {
              loading: false,
              unavailable: false,
              unread: 3,
              showBadge: true,
              badgeLabel: '3',
            },
          }),
        ),
      ),
    ),
  );
}

function mockFeeds({ lwError = false, wsError = false } = {}) {
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith(LW_PATH)) {
      return lwError ? Promise.reject(new Error('lw down')) : Promise.resolve({ data: LW_PAGE });
    }
    if (url === WS_PATH) {
      return wsError ? Promise.reject(new Error('ws down')) : Promise.resolve({ data: WS_FEED });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  apiPost.mockImplementation((url: string) => {
    if (url === `${LW_PATH}/lw-1/read`) return Promise.resolve({ data: { read: true } });
    if (url === `${LW_PATH}/read-all`) return Promise.resolve({ data: { read: 2 } });
    if (url === `${WS_PATH}/read-all`) return Promise.resolve({ data: {} });
    if (url === `${WS_PATH}/ws-1/read`) return Promise.resolve({ data: {} });
    if (url.includes('/collaborators/c-1/accept')) return Promise.resolve({ data: {} });
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  navigate.mockReset();
  mockFeeds();
});

afterEach(() => cleanup());

async function openBell() {
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
}

describe('NotificationBell — merged workspace + committee feed', () => {
  it('renders both sources newest-first with namespaced rows and invite actions', async () => {
    renderBell();
    await openBell();
    const committee = await screen.findByText('Witness testimony published');
    const hearing = await screen.findByText('Hearing announced: FY27 posture');
    const invite = await screen.findByText('Ada invited you to Draft Q3');
    expect(committee).toBeTruthy();
    expect(hearing).toBeTruthy();
    expect(invite).toBeTruthy();
    // Newest first: committee publication (12:00) before invite (10:00) before hearing (08:00).
    const order = [committee, invite, hearing].map((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      while (node && node.tagName !== 'LI') node = node.parentElement;
      return node!;
    });
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Invite actions survive the merge.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
  });

  it('committee row: POSTs read first, navigates to deepLink only after success', async () => {
    renderBell();
    await openBell();
    const row = await screen.findByText('Witness testimony published');
    fireEvent.click(row.closest('button')!);
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`${LW_PATH}/lw-1/read`, {}),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/legiwatch/committees/HLIG01'));
  });

  it('committee row: a failed read does NOT navigate and shows the inline error', async () => {
    apiPost.mockImplementation((url: string) => {
      if (url === `${LW_PATH}/lw-1/read`) {
        return Promise.reject({ response: { data: { message: 'Read state could not be saved.' } } });
      }
      if (url === `${WS_PATH}/ws-1/read`) return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderBell();
    await openBell();
    const row = await screen.findByText('Witness testimony published');
    fireEvent.click(row.closest('button')!);
    await screen.findByText('Read state could not be saved.');
    expect(navigate).not.toHaveBeenCalledWith('/legiwatch/committees/HLIG01');
  });

  it('Mark all read calls BOTH sources and is disabled while pending', async () => {
    let resolveLw!: (v: { data: { read: number } }) => void;
    apiPost.mockImplementation((url: string) => {
      if (url === `${LW_PATH}/read-all`) {
        return new Promise((res) => {
          resolveLw = res;
        });
      }
      if (url === `${WS_PATH}/read-all`) return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderBell();
    await openBell();
    const btn = await screen.findByRole('button', { name: 'Mark all read' });
    fireEvent.click(btn);
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(`${LW_PATH}/read-all`, {}));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(`${WS_PATH}/read-all`, {}));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Marking…' })).toBeTruthy());
    resolveLw({ data: { read: 2 } });
  });

  it('lw feed failure keeps workspace items and shows the scoped failure note', async () => {
    mockFeeds({ lwError: true });
    renderBell();
    await openBell();
    await screen.findByText(/Committee alerts are unavailable right now/);
    expect(screen.getByText('Ada invited you to Draft Q3')).toBeTruthy();
  });

  it('workspace feed failure keeps committee items and shows the scoped failure note', async () => {
    mockFeeds({ wsError: true });
    renderBell();
    await openBell();
    await screen.findByText(/Workspace notifications are unavailable right now/);
    expect(screen.getByText('Witness testimony published')).toBeTruthy();
  });

  it('never claims "No notifications" while the badge says unread exist', async () => {
    mockFeeds({ lwError: true, wsError: false });
    // Override the ws feed to zero items so merged is empty while unread > 0.
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith(LW_PATH)) return Promise.reject(new Error('lw down'));
      if (url === WS_PATH) return Promise.resolve({ data: { items: [], unread: 0 } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderBell();
    await openBell();
    await screen.findByText(/Unread notifications exist but could not be loaded/);
    expect(screen.queryByText('No notifications')).toBeNull();
  });
});
