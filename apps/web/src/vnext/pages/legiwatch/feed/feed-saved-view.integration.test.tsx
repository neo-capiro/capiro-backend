import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem, FeedResponse } from '../../../../pages/clients/tracker/intel-feed-api.js';

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet, post: apiPost }) }));

import { FeedTab } from './FeedTab.js';

const queryClients: QueryClient[] = [];
const SAVED_VIEW = '/legiwatch?tab=feed&client=client-A&order=score&filter=hearing&work=in_review&arrange=byClient&q=budget';

function alert(id: string, clientId: string, title: string, sourceType: FeedItem['sourceType'], state: string): FeedItem {
  return {
    id, clientId, clientName: clientId === 'client-A' ? 'Client A' : 'Client B', title, sourceType,
    severity: 'notable', materiality: 'medium', score: 1, whyItMatters: null, recommendedAction: null,
    evidence: {}, status: 'new', createdAt: '2026-09-01T00:00:00Z',
    workState: { state, assignedTo: null, snoozedUntil: null, note: null },
  } as FeedItem;
}

const items = [
  alert('a-bill', 'client-A', 'Transport authorization', 'bill', 'new'),
  alert('a-hearing', 'client-A', 'Budget oversight', 'hearing', 'in_review'),
  alert('b-bill', 'client-B', 'Maritime authorization', 'bill', 'new'),
];

function Harness() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate('/legiwatch?tab=feed&client=client-A&filter=bill&q=transport')}>Apply another saved view</button>
    <button onClick={() => navigate(-1)}>Go back</button>
    <button onClick={() => setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('client', 'client-B');
      return next;
    })}>Switch client</button>
    <output data-testid="view-url">{params.toString()}</output>
    <FeedTab scope={params.get('client') ?? ''} clients={[]} />
  </>;
}

function renderFeed(path = '/legiwatch?tab=feed&client=client-A') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  queryClients.push(queryClient);
  render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><Harness /></MemoryRouter></QueryClientProvider>);
}
function viewParams() {
  return new URLSearchParams(screen.getByTestId('view-url').textContent ?? '');
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPost.mockResolvedValue({ data: { ok: true } });
  apiGet.mockImplementation(async (url: string) => {
    const request = new URL(url, 'https://example.test');
    const scope = /\/clients\/([^/]+)\//.exec(request.pathname)?.[1];
    if (request.pathname.endsWith('/packet')) return { data: null };
    if (request.pathname.includes('/feed/alerts/')) {
      return { data: items.find((item) => item.id === request.pathname.split('/').at(-1) && item.clientId === scope) ?? null };
    }
    if (request.pathname.endsWith('/feed')) {
      const filtered = items.filter((item) => (scope === '_all' || item.clientId === scope)
        && (!request.searchParams.has('sourceType') || item.sourceType === request.searchParams.get('sourceType'))
        && (!request.searchParams.has('workState') || item.workState?.state === request.searchParams.get('workState')));
      const response: FeedResponse = {
        items: filtered, total: filtered.length, hasMore: false, nextCursor: null,
        counts: { bill: 1, hearing: 1 },
        workStateCounts: { new: 1, in_review: 1, assigned: 0, actioned: 0, snoozed: 0, dismissed: 0 },
      };
      return { data: response };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
});

afterEach(() => {
  cleanup();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe('Feed saved-view restoration and client isolation', () => {
  it('restores all saved URL controls, applies another view, and restores the first with Back', async () => {
    renderFeed(SAVED_VIEW);
    await screen.findByText('Budget oversight');
    expect(screen.queryByText('Transport authorization')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Priority' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Group by client' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /^Hearings/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^In review/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Search the feed' })).toHaveValue('budget');
    const request = new URL(apiGet.mock.calls.find(([url]) => url.includes('/feed?'))![0], 'https://example.test');
    expect(Object.fromEntries(request.searchParams)).toMatchObject({ order: 'score', sourceType: 'hearing', workState: 'in_review' });

    fireEvent.click(screen.getByRole('button', { name: 'Apply another saved view' }));
    await screen.findByText('Transport authorization');
    expect(screen.queryByText('Budget oversight')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Newest' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Search the feed' })).toHaveValue('transport');

    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    await screen.findByText('Budget oversight');
    expect(screen.getByRole('tab', { name: 'Priority' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Group by client' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Search the feed' })).toHaveValue('budget');
  });

  it('writes controls to the saved-view URL and resets every filter atomically without losing the client', async () => {
    renderFeed();
    fireEvent.click(await screen.findByRole('tab', { name: 'Priority' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Hearings/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^In review/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Group by client' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the feed' }), { target: { value: 'budget' } });
    expect(Object.fromEntries(viewParams())).toMatchObject({ tab: 'feed', client: 'client-A', order: 'score', filter: 'hearing', work: 'in_review', arrange: 'byClient', q: 'budget' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await screen.findByText('Transport authorization');
    expect(Object.fromEntries(viewParams())).toEqual({ tab: 'feed', client: 'client-A' });
    expect(screen.getByRole('tab', { name: 'Newest' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Single stream' })).toHaveAttribute('aria-selected', 'true');
  });

  it('clears bulk IDs and the open packet before changing client scope', async () => {
    renderFeed();
    fireEvent.click(await screen.findByRole('button', { name: 'Select Transport authorization' }));
    expect(screen.getByRole('toolbar', { name: 'Bulk actions' })).toBeTruthy();
    fireEvent.click(screen.getByText('Transport authorization'));
    await screen.findByRole('dialog', { name: 'Alert packet' });
    expect(viewParams().get('alert')).toBe('a-bill');

    fireEvent.click(screen.getByRole('button', { name: 'Switch client' }));
    await screen.findByText('Maritime authorization');
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Alert packet' })).toBeNull();
    expect(viewParams().has('alert')).toBe(false);
    expect(apiGet.mock.calls.some(([url]) => url.includes('/clients/client-B/') && url.includes('/alerts/a-bill'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Select Maritime authorization' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/intel-api/clients/client-B/alerts/b-bill/work-state', { state: 'in_review' }));
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('uses safe defaults for unsupported saved control values', async () => {
    renderFeed('/legiwatch?tab=feed&client=client-A&order=unsupported&filter=unsupported&work=unsupported&arrange=unsupported');
    await screen.findByText('Transport authorization');
    expect(screen.getByRole('tab', { name: 'Newest' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Single stream' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /^Active queue/ })).toHaveAttribute('aria-pressed', 'true');
    const request = new URL(apiGet.mock.calls[0]![0], 'https://example.test');
    expect(request.searchParams.get('order')).toBe('date');
    expect(request.searchParams.has('sourceType')).toBe(false);
    expect(request.searchParams.has('workState')).toBe(false);
  });
});
