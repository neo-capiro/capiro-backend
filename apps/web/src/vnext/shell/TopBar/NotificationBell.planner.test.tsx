import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationBell } from './index.js';
import { ShellOverlayProvider } from '../overlay-manager.js';
import { useShellNotifications } from '../../adapters/legacy/useShellNotifications.js';
import { usePlannerInbox } from '../../pages/planner/planner-api.js';
const fixture = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  navigate: vi.fn(),
  orgId: 'org_planner' as string | null,
  userId: 'user_planner',
  impersonation: null as string | null,
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => fixture }));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ orgId: fixture.orgId, userId: fixture.userId }),
  useUser: () => ({ user: { id: fixture.userId } }),
}));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: fixture.impersonation }),
}));
vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({
    data: { tenant: { id: 'tenant' }, features: { businessDevelopmentWatch: false } },
  }),
}));
vi.mock('../../pages/legiwatch/lib/saved-hearing-sessions.js', () => ({
  useHearingQueryIdentity: () => ({ identity: 'tenant:user', ready: true }),
}));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => fixture.navigate,
}));
const path = '/strategy-api/planner/notifications';
const item = {
  id: 'same-id',
  title: 'Synthetic launch task',
  read: false,
  archived: false,
  deepLink: 'https://untrusted.example',
  event: {
    id: 'event',
    taskId: '30000000-0000-4000-8000-000000000001',
    projectId: null,
    actorId: 'author',
    kind: 'reminder',
    text: 'Task due date is approaching',
    minutes: null,
    createdAt: '2026-10-06T12:00:00Z',
  },
};
let read = false;
beforeEach(() => {
  fixture.orgId = 'org_planner';
  fixture.userId = 'user_planner';
  fixture.impersonation = null;
  read = false;
  fixture.get.mockReset();
  fixture.patch.mockReset();
  fixture.post.mockReset();
  fixture.navigate.mockReset();
  fixture.get.mockImplementation(async (url: string) => {
    if (url === path) return { data: { items: read ? [] : [item], unread: read ? 0 : 125 } };
    if (url === '/strategy-api/planner/inbox')
      return { data: { items: [{ ...item, read }], nextCursor: null } };
    if (url === '/workspace-api/notifications')
      return {
        data: {
          items: [
            {
              id: 'same-id',
              message: 'Workspace update',
              createdAt: '2026-10-05T12:00:00Z',
              read: false,
            },
          ],
          unread: 1,
        },
      };
    if (url.startsWith('/api/legiwatch/live-hearings/notifications'))
      return { data: { rows: [], unread: 1 } };
    throw new Error(`Unexpected GET ${url}`);
  });
  fixture.patch.mockImplementation(async () => {
    read = true;
    return { data: { ok: true } };
  });
  fixture.post.mockImplementation(async (url) => {
    if (url === `${path}/read-all`) read = true;
    return { data: {} };
  });
});
afterEach(cleanup);
function Harness({ inbox = false }: { inbox?: boolean }) {
  const notifications = useShellNotifications();
  return (
    <>
      <div>{`total=${notifications.unread}|badge=${notifications.badgeLabel}|unavailable=${notifications.unavailable}`}</div>
      <NotificationBell notifications={notifications} />
      {inbox ? <Inbox /> : null}
    </>
  );
}
function Inbox() {
  const query = usePlannerInbox();
  return <span>{`inbox-read=${query.data?.pages[0]?.items[0]?.read}`}</span>;
}
function view(inbox = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ShellOverlayProvider>
          <Harness inbox={inbox} />
        </ShellOverlayProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(tree), tree, client };
}
async function open() {
  fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
}
describe('Planner fourth notification source', () => {
  it('uses the authorized server total, renders Planner and a colliding Workspace ID, and sorts by arrival', async () => {
    view();
    await screen.findByText('total=127|badge=99+|unavailable=false');
    await open();
    const planner = await screen.findByRole('button', { name: /Synthetic launch task/ });
    const workspace = screen.getByText('Workspace update');
    expect(
      planner.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('Planner')).toBeTruthy();
  });
  it('persists read before navigating, builds its own local route and refreshes both caches', async () => {
    view(true);
    await screen.findByText('inbox-read=false');
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /Synthetic launch task/ }));
    await waitFor(() =>
      expect(fixture.patch).toHaveBeenCalledWith('/strategy-api/planner/inbox/same-id', {
        read: true,
      }),
    );
    await waitFor(() =>
      expect(fixture.navigate).toHaveBeenCalledWith(
        '/planner?scope=mine&task=30000000-0000-4000-8000-000000000001',
      ),
    );
    await screen.findByText('total=2|badge=2|unavailable=false');
    await screen.findByText('inbox-read=true');
  });
  it('failed reads retain the row, show the error and prevent navigation', async () => {
    fixture.patch.mockRejectedValue(new Error('Planner read failed'));
    view();
    await open();
    fireEvent.click(await screen.findByRole('button', { name: /Synthetic launch task/ }));
    await screen.findByText('Planner read failed');
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Synthetic launch task/ })).toBeTruthy();
  });
  it('single-flight protection prevents two rapid read requests', async () => {
    let resolve!: (value: unknown) => void;
    fixture.patch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    view();
    await open();
    const button = await screen.findByRole('button', { name: /Synthetic launch task/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(fixture.patch).toHaveBeenCalledTimes(1));
    resolve({ data: {} });
    await waitFor(() => expect(fixture.navigate).toHaveBeenCalledTimes(1));
  });
  it('mark-all includes Planner and isolates a Planner failure from the other feeds', async () => {
    fixture.post.mockImplementation(async (url) => {
      if (url === `${path}/read-all`) throw new Error('Planner read-all failed');
      return { data: {} };
    });
    view();
    await open();
    await screen.findByRole('button', { name: /Synthetic launch task/ });
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(fixture.post).toHaveBeenCalledWith(`${path}/read-all`, {}));
    expect(fixture.post).toHaveBeenCalledWith('/workspace-api/notifications/read-all', {});
    expect(fixture.post).toHaveBeenCalledWith(
      '/api/legiwatch/live-hearings/notifications/read-all',
      {},
    );
    await screen.findByText('Planner read-all failed');
    expect(screen.getByText('Workspace update')).toBeTruthy();
  });
  it('Planner failure cannot mask surviving counts or rows', async () => {
    const original = fixture.get.getMockImplementation()!;
    fixture.get.mockImplementation((url) =>
      url === path ? Promise.reject(new Error('Planner offline')) : original(url),
    );
    view();
    await screen.findByText('total=2|badge=2|unavailable=false');
    await open();
    await screen.findByText(/Planner notifications are unavailable/);
    expect(screen.getByText('Workspace update')).toBeTruthy();
  });
  it.each(['no-org', 'impersonation'])(
    'makes no Planner requests when %s is active',
    async (mode) => {
      if (mode === 'no-org') fixture.orgId = null;
      else fixture.impersonation = 'other-tenant';
      view();
      await screen.findByText('total=2|badge=2|unavailable=false');
      await open();
      await screen.findByText('Workspace update');
      expect(fixture.get.mock.calls.some(([url]) => url === path)).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
      expect(fixture.post.mock.calls.some(([url]) => url === `${path}/read-all`)).toBe(false);
    },
  );
});
