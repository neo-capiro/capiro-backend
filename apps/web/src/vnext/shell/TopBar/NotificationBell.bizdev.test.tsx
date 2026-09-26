/**
 * Phase 5 — Business Development alerts as a THIRD source in the existing
 * NotificationBell. Covers: feature-off zero BD requests + old behavior;
 * feature-on merged badge/list; BD fetch failure isolated; item read-then-
 * encoded-navigate; read failure retains item and never navigates; read-all
 * includes BD and stays source-isolated.
 *
 * Badge arithmetic (>99 → '99+') lives in useShellNotifications and is
 * exercised directly with a mocked committee/workspace feed.
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
vi.mock('../../pages/legiwatch/lib/saved-hearing-sessions.js', () => ({
  useHearingQueryIdentity: () => ({ identity: 'tenant-1:user-1', ready: true }),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: vi.fn() };
});

const meMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/me.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/me.js')>();
  return { ...actual, useMe: meMock };
});

import { NotificationBell } from './index.js';
import { ShellOverlayProvider } from '../overlay-manager.js';
import { useShellNotifications } from '../../adapters/legacy/useShellNotifications.js';

const LW_PATH = '/api/legiwatch/live-hearings/notifications';
const WS_PATH = '/workspace-api/notifications';
const BD_PATH = '/api/business-development/alerts';

const navigate = vi.fn();
vi.mocked(useNavigate).mockReturnValue(navigate);

const PROSPECT = '11111111-2222-3333-4444-555555555555';
const ALERT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const LW_PAGE = {
  rows: [
    {
      id: 'lw-1',
      eventType: 'new_hearing',
      hearingId: 'h-9',
      committeeSystemCode: 'HLIG01',
      clientId: null,
      title: 'Hearing announced: FY27 posture',
      body: null,
      deepLink: '/legiwatch/hearings/h-9',
      read: false,
      createdAt: '2026-09-20T08:00:00Z',
    },
  ],
  total: 1,
  unread: 1,
  page: 1,
  pageSize: 100,
  hasMore: false,
};

const WS_FEED = {
  items: [
    {
      id: 'ws-1',
      kind: 'info',
      message: 'Draft Q3 shared with you',
      read: false,
      actionable: false,
      createdAt: '2026-09-19T10:00:00Z',
    },
  ],
  unread: 1,
};

function bdAlertFixture() {
  return {
    id: ALERT,
    prospectId: PROSPECT,
    title: 'New contract award observed',
    summary: 'A federal contract award was published for this prospect.',
    materiality: 'High',
    materialityLevel: 'high',
    company: 'Acme Aerospace',
    sourceFamily: 'usaspending_contract',
    category: 'contracts',
    eventAt: '2026-09-24T12:00:00Z',
    effectiveAt: null,
    publishedAt: '2026-09-24T12:30:00Z',
    firstObservedAt: '2026-09-24T13:00:00Z',
    sourceLocator: 'https://example.gov/award/1',
    implication: null,
    readAt: null,
    dismissedAt: null,
  };
}

const BD_FEED = { items: [bdAlertFixture()], nextCursor: null, unreadCount: 1 };

/** An OLD event first observed today must not be buried by newer-timestamped
 *  committee/workspace rows — arrival (firstObservedAt) sorts first. */
const BD_OLD_EVENT_FEED = {
  items: [
    {
      ...bdAlertFixture(),
      title: 'Historic award surfaced today',
      eventAt: '2020-01-01T00:00:00Z',
      publishedAt: '2020-01-01T01:00:00Z',
      firstObservedAt: '2026-09-25T09:00:00Z',
    },
  ],
  nextCursor: null,
  unreadCount: 1,
};

function meResponse(watchOn: boolean) {
  return {
    data: {
      features: { businessDevelopmentWatch: watchOn },
      // useShellNotifications reads only features; fill minimal shape.
      user: { id: 'u-1' },
      tenant: { id: 't-1', slug: 't', name: 'T' },
      role: 'tenant_admin',
    },
  };
}

function mockFeeds({ bdError = false } = {}) {
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith(LW_PATH)) return Promise.resolve({ data: LW_PAGE });
    if (url === WS_PATH) return Promise.resolve({ data: WS_FEED });
    if (url === BD_PATH) {
      return bdError ? Promise.reject(new Error('bd down')) : Promise.resolve({ data: BD_FEED });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  apiPost.mockImplementation((url: string) => {
    if (url === `${BD_PATH}/read-all`) return Promise.resolve({ data: { read: 1 } });
    if (
      url ===
      `/api/business-development/prospects/${PROSPECT}/alerts/${ALERT}/read`
    ) {
      return Promise.resolve({ data: { readAt: '2026-09-25T00:00:00Z' } });
    }
    if (url === `${LW_PATH}/read-all`) return Promise.resolve({ data: { read: 1 } });
    if (url === `${WS_PATH}/read-all`) return Promise.resolve({ data: {} });
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  navigate.mockReset();
});

afterEach(() => cleanup());

function renderBell(watchOn: boolean) {
  meMock.mockReturnValue(meResponse(watchOn));
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
              unread: watchOn ? 3 : 2,
              showBadge: true,
              badgeLabel: watchOn ? '3' : '2',
            },
          }),
        ),
      ),
    ),
  );
}

async function openBell() {
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
}

/** The BD row's title is split across nested spans, so query by button name. */
async function findBdRow() {
  return (await screen.findByRole('button', { name: /New contract award observed/ })) as HTMLElement;
}

const BD_TARGET = `/clients?view=business-development&bdProspect=${PROSPECT}&bdAlert=${ALERT}`;

describe('NotificationBell — Business Development third source', () => {
  it('feature OFF: zero BD requests and the old merged behavior is unchanged', async () => {
    mockFeeds();
    renderBell(false);
    await openBell();
    await screen.findByText('Hearing announced: FY27 posture');
    await screen.findByText('Draft Q3 shared with you');
    expect(screen.queryByText('New contract award observed')).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    const bdCalls = apiGet.mock.calls.filter(([u]) => String(u).startsWith(BD_PATH));
    expect(bdCalls).toHaveLength(0);
  });

  it('feature ON: BD alert appears in the merged newest-first list with source label and external link', async () => {
    mockFeeds();
    renderBell(true);
    await openBell();
    const bd = await findBdRow();
    expect(screen.getByText('Business Development')).toBeTruthy();
    // Company/title summary.
    expect(screen.getByText(/Acme Aerospace — /)).toBeTruthy();
    // Exact source locator as an explicit external link.
    const link = screen.getByRole('link', { name: /View source record/ }) as HTMLAnchorElement;
    expect(link.href).toBe('https://example.gov/award/1');
    // Siblings, not nested: the external link must NOT live inside the row button.
    expect(link.closest('button')).toBeNull();
    expect(link.closest('li')).toBe(bd.closest('li'));
    // Newest first: BD (2026-09-24) before committee (2026-09-20) before ws (2026-09-19).
    const committee = screen.getByRole('button', { name: /Hearing announced: FY27 posture/ });
    const ws = screen.getByText('Draft Q3 shared with you');
    const order = [bd, committee, ws].map((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      while (node && node.tagName !== 'LI') node = node.parentElement;
      return node!;
    });
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('BD fetch failure is isolated: other sources keep rendering with a scoped note', async () => {
    mockFeeds({ bdError: true });
    renderBell(true);
    await openBell();
    await screen.findByText(/Business Development alerts are unavailable right now/);
    expect(screen.getByText('Hearing announced: FY27 posture')).toBeTruthy();
    expect(screen.getByText('Draft Q3 shared with you')).toBeTruthy();
  });

  it('BD row: POSTs read first, then navigates to the encoded prospect alert target', async () => {
    mockFeeds();
    renderBell(true);
    await openBell();
    fireEvent.click(await findBdRow());
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        `/api/business-development/prospects/${PROSPECT}/alerts/${ALERT}/read`,
        {},
      ),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(BD_TARGET));
  });

  it('an old event first observed today sorts by arrival, not event date', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith(LW_PATH)) return Promise.resolve({ data: LW_PAGE });
      if (url === WS_PATH) return Promise.resolve({ data: WS_FEED });
      if (url === BD_PATH) return Promise.resolve({ data: BD_OLD_EVENT_FEED });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    apiPost.mockImplementation(() => Promise.reject(new Error('unused')));
    renderBell(true);
    await openBell();
    const bd = await screen.findByRole('button', { name: /Historic award surfaced today/ });
    const committee = screen.getByRole('button', { name: /Hearing announced: FY27 posture/ });
    expect(
      bd.compareDocumentPosition(committee) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('BD row: failed read retains the item, shows the scoped error, and never navigates', async () => {
    mockFeeds();
    apiPost.mockImplementation((url: string) => {
      if (url === `/api/business-development/prospects/${PROSPECT}/alerts/${ALERT}/read`) {
        return Promise.reject({ response: { data: { message: 'Alert read state could not be saved.' } } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderBell(true);
    await openBell();
    fireEvent.click(await findBdRow());
    await screen.findByText('Alert read state could not be saved.');
    expect(await findBdRow()).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Mark all read includes BD read-all and stays source-isolated on BD failure', async () => {
    mockFeeds();
    apiPost.mockImplementation((url: string) => {
      if (url === `${BD_PATH}/read-all`) {
        return Promise.reject({ response: { data: { message: 'Business Development read-all failed.' } } });
      }
      if (url === `${LW_PATH}/read-all`) return Promise.resolve({ data: { read: 1 } });
      if (url === `${WS_PATH}/read-all`) return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderBell(true);
    await openBell();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(`${BD_PATH}/read-all`, {}));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(`${WS_PATH}/read-all`, {}));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(`${LW_PATH}/read-all`, {}));
    // The failing BD read-all surfaces an error but erases nothing.
    await screen.findByText('Business Development read-all failed.');
    expect(await findBdRow()).toBeTruthy();
    expect(screen.getByText('Hearing announced: FY27 posture')).toBeTruthy();
    expect(screen.getByText('Draft Q3 shared with you')).toBeTruthy();
  });

  it('Mark all read shows Marking… while the BD read-all is pending', async () => {
    mockFeeds();
    let resolveBd!: (v: { data: { read: number } }) => void;
    apiPost.mockImplementation((url: string) => {
      if (url === `${BD_PATH}/read-all`) {
        return new Promise((res) => {
          resolveBd = res;
        });
      }
      if (url === `${LW_PATH}/read-all`) return Promise.resolve({ data: { read: 1 } });
      if (url === `${WS_PATH}/read-all`) return Promise.resolve({ data: {} });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderBell(true);
    await openBell();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(`${BD_PATH}/read-all`, {}));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Marking…' })).toBeTruthy());
    resolveBd({ data: { read: 1 } });
  });

  it('workspace AND committee failing still reports each failure and keeps BD usable', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith(LW_PATH)) return Promise.reject(new Error('lw down'));
      if (url === WS_PATH) return Promise.reject(new Error('ws down'));
      if (url === BD_PATH) return Promise.resolve({ data: BD_FEED });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    apiPost.mockImplementation((url: string) => {
      if (url === `/api/business-development/prospects/${PROSPECT}/alerts/${ALERT}/read`) {
        return Promise.resolve({ data: { readAt: '2026-09-25T00:00:00Z' } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    renderBell(true);
    await openBell();
    await screen.findByText(/Workspace notifications are unavailable right now/);
    await screen.findByText(/Committee alerts are unavailable right now/);
    // The surviving BD row is present AND its action still works.
    fireEvent.click(await findBdRow());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(BD_TARGET));
  });
});

describe('useShellNotifications — badge arithmetic with the BD source', () => {
  function Harness() {
    const vm = useShellNotifications();
    return createElement(
      'div',
      null,
      `unread=${vm.unread}|badge=${vm.badgeLabel}|show=${vm.showBadge}|unavailable=${vm.unavailable}`,
    );
  }

  function renderHarness(watchOn: boolean) {
    meMock.mockReturnValue(meResponse(watchOn));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          null,
          createElement(ShellOverlayProvider, null, createElement(Harness)),
        ),
      ),
    );
  }

  it('feature ON: combined unread = ws + lw + bd', async () => {
    mockFeeds();
    renderHarness(true);
    await screen.findByText('unread=3|badge=3|show=true|unavailable=false');
  });

  it('feature ON: >99 unread renders 99+', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith(LW_PATH)) return Promise.resolve({ data: { ...LW_PAGE, unread: 120 } });
      if (url === WS_PATH) return Promise.resolve({ data: WS_FEED });
      if (url === BD_PATH) return Promise.resolve({ data: BD_FEED });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderHarness(true);
    await screen.findByText('unread=122|badge=99+|show=true|unavailable=false');
  });

  it('feature OFF: combined unread excludes BD and no BD request is made', async () => {
    mockFeeds();
    renderHarness(false);
    await screen.findByText('unread=2|badge=2|show=true|unavailable=false');
    await new Promise((r) => setTimeout(r, 50));
    expect(apiGet.mock.calls.filter(([u]) => String(u).startsWith(BD_PATH)).length).toBe(0);
  });
});