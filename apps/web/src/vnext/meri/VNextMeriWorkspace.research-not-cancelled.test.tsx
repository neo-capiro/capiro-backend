import { useLayoutEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { claimMeriIdentity, resetChatStoreForTests } from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { setGlobalClientFilter } from '../../state/client-filter.js';
import { VNextMeriWorkspace } from './VNextMeriWorkspace.js';

// T7 browser check, 2026-10-07: "Delegate this" in the Meri workspace created
// the job and the browser cancelled it 28 ms later. The workspace's unmount
// cleanup called handleStop and depended on its identity, which changes when
// research starts streaming, so React ran the cleanup mid-session and the stale
// closure cancelled the job it had just started.

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mocks.getToken, orgId: 'org-a', userId: 'user-a' }),
}));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
vi.mock('./VNextMeriIntegrations.js', () => ({ VNextMeriIntegrations: () => null }));
vi.mock('./VNextMeriShell.js', () => ({ VNextMeriShell: DelegateProbe }));

function DelegateProbe({ controller }: { controller: MeriChatController }) {
  return (
    <div>
      <output aria-label="Research streaming">{String(controller.isResearchStreaming)}</output>
      <button onClick={() => void controller.delegateJob('Write an office brief on HR 1')}>
        Delegate
      </button>
    </div>
  );
}

// The workspace reads window.location as well as the router location.
function LocationProbe() {
  const location = useLocation();
  useLayoutEffect(() => {
    window.history.replaceState({}, '', `${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);
  return null;
}

function stubFetch() {
  const encoder = new TextEncoder();
  return vi.fn(async (url: string, init?: RequestInit) => {
    const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith('/api/clients')) return ok([]);
    if (url.endsWith('/api/clio/conversations')) {
      if (init?.method === 'POST')
        return ok({
          id: 'thread-1',
          title: 'Thread',
          clientId: null,
          client: null,
          updatedAt: '2026-10-07T00:00:00.000Z',
        });
      return ok([]);
    }
    if (url.includes('/messages')) return ok([]);
    if (url.endsWith('/api/clio/research') && init?.method === 'POST') return ok({ id: 'job-1' });
    if (url.endsWith('/research/job-1/plan/stream'))
      // The plan stream stays open: research is in flight.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"phase","phase":"plan"}\n\n'));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    if (url.endsWith('/research/job-1/cancel'))
      return ok({ run: { id: 'run-1', status: 'cancel_requested' } });
    if (url.includes('/research/job-1'))
      return ok({
        id: 'job-1',
        status: 'plan',
        kind: 'deliverable',
        run: { id: 'run-1', status: 'running', phase: 'plan' },
        job: {
          kind: 'deliverable',
          status: 'planning',
          goalRevision: 0,
          deliverables: [],
          awaitingStart: false,
        },
      });
    return ok({});
  });
}

function renderWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/meri/new']}>
        <VNextMeriWorkspace />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cancels = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/cancel'));

describe('Meri workspace and in-flight research', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    sessionStorage.clear();
    setGlobalClientFilter(null);
    mocks.api.get.mockResolvedValue({
      data: { tenant: { name: 'Owned mock' }, features: { meriv3Chat: true, meriJobs: true } },
    });
    claimMeriIdentity('org-a:user-a');
  });
  afterEach(() => vi.unstubAllGlobals());

  test('does not cancel a delegated job when its research starts streaming', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    renderWorkspace();
    const delegate = await screen.findByRole('button', { name: 'Delegate' }, { timeout: 10_000 });
    await act(async () => {
      fireEvent.click(delegate);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/plan/stream'))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Research streaming').textContent).toBe('true'),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(cancels(fetchMock)).toHaveLength(0);
  });

  test('leaving Meri detaches the stream but never cancels the durable job', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    const view = renderWorkspace();
    const delegate = await screen.findByRole('button', { name: 'Delegate' }, { timeout: 10_000 });
    await act(async () => {
      fireEvent.click(delegate);
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/plan/stream'))).toBe(true),
    );
    const plan = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/plan/stream'));
    const signal = plan?.[1]?.signal as AbortSignal | undefined;
    view.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(cancels(fetchMock)).toHaveLength(0);
    expect(signal?.aborted).toBe(true);
  });
});
