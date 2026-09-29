/**
 * LW-QA-019, the user-visible half — triage from the DEFAULT All-clients view.
 *
 * Two shipped behaviours are locked here:
 *  1. The row-level and bulk controls post to the tenant-wide '_all' path (the
 *     one the server now actually handles), not to a substituted client id.
 *  2. A failure is no longer silent. The row pill had no onError and no pending
 *     state at all, so a 404 changed nothing on screen and said nothing — the
 *     analyst believed the alert was triaged. It must now show an explicit
 *     error and leave the row on its original state.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem, FeedResponse } from '../../../../pages/clients/tracker/intel-feed-api.js';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
const apiPost = vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'test-token', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string) => apiGet(url),
    post: (url: string, body?: unknown) => apiPost(url, body),
  }),
}));

import { FeedTab } from './FeedTab.js';

function item(id: string, title: string): FeedItem {
  return {
    id,
    clientId: id === 'a1' ? 'client-A' : 'client-B',
    clientName: id === 'a1' ? 'Client A' : 'Client B',
    sourceType: 'bill',
    severity: 'notable',
    materiality: 'medium',
    score: 1,
    title,
    whyItMatters: null,
    recommendedAction: null,
    evidence: {},
    status: 'new',
    createdAt: '2026-09-01T00:00:00.000Z',
    workState: { state: 'new', assignedTo: null, snoozedUntil: null, note: null },
  } as FeedItem;
}

const FEED: FeedResponse = {
  // Two alerts from DIFFERENT clients — the mixed-client selection the
  // All-clients view produces and the reason '_all' exists.
  items: [item('a1', 'Alert one'), item('a2', 'Alert two')],
  nextCursor: null,
  hasMore: false,
  counts: { bill: 2 },
  total: 2,
  workStateCounts: { new: 2, in_review: 0, assigned: 0, actioned: 0, snoozed: 0, dismissed: 0 },
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/intel-api/clients/_all/feed?')) return Promise.resolve({ data: FEED });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

function renderFeed() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/legiwatch?tab=feed']}>
        <FeedTab scope="" clients={[]} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function rowSelects() {
  await screen.findByText('Alert one');
  return screen.getAllByRole('combobox', { name: 'Work state: NEW' }) as HTMLSelectElement[];
}

describe('LW-QA-019 — row-level triage in the All-clients view', () => {
  it("posts to the tenant-wide '_all' work-state path", async () => {
    apiPost.mockResolvedValue({ data: { ok: true } });
    renderFeed();
    const [first] = await rowSelects();
    fireEvent.change(first!, { target: { value: 'actioned' } });

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/intel-api/clients/_all/alerts/a1/work-state', {
        state: 'actioned',
      }),
    );
  });

  it('shows an explicit error when the triage fails — never silent', async () => {
    apiPost.mockRejectedValue(new Error('Request failed with status code 404'));
    renderFeed();
    const [first] = await rowSelects();
    fireEvent.change(first!, { target: { value: 'dismissed' } });

    expect(await screen.findByText('Could not update — change reverted')).toBeTruthy();
  });

  it('leaves the row on its original state after a failure', async () => {
    apiPost.mockRejectedValue(new Error('Request failed with status code 404'));
    renderFeed();
    const [first] = await rowSelects();
    fireEvent.change(first!, { target: { value: 'dismissed' } });

    await screen.findByText('Could not update — change reverted');
    await waitFor(() =>
      expect((screen.getAllByRole('combobox', { name: 'Work state: NEW' })[0] as HTMLSelectElement).value).toBe(
        'new',
      ),
    );
  });

  it('confirms a successful triage', async () => {
    apiPost.mockResolvedValue({ data: { ok: true } });
    renderFeed();
    const [first] = await rowSelects();
    fireEvent.change(first!, { target: { value: 'in_review' } });

    expect(await screen.findByText('Marked in review')).toBeTruthy();
  });
});

describe('LW-QA-019 — bulk triage in the All-clients view', () => {
  it("posts a mixed-client selection to the tenant-wide '_all' bulk path", async () => {
    apiPost.mockResolvedValue({ data: { updated: 2 } });
    renderFeed();
    await screen.findByText('Alert one');
    fireEvent.click(screen.getByLabelText('Select Alert one'));
    fireEvent.click(screen.getByLabelText('Select Alert two'));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/intel-api/clients/_all/alerts/work-state/bulk', {
        alertIds: ['a1', 'a2'],
        state: 'in_review',
      }),
    );
  });

  it('reports a failed bulk instead of silently clearing the selection', async () => {
    apiPost.mockRejectedValue(new Error('Request failed with status code 404'));
    renderFeed();
    await screen.findByText('Alert one');
    fireEvent.click(screen.getByLabelText('Select Alert one'));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    expect(await screen.findByText('Could not update — changes rolled back')).toBeTruthy();
    expect(screen.getByText('1 SELECTED')).toBeTruthy(); // selection survives the failure
  });
});

describe('LW-QA-021 — assign to me sends the resolved actor id', () => {
  it('posts state=assigned with assignedTo from /api/me', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/intel-api/clients/_all/feed?')) return Promise.resolve({ data: FEED });
      if (url === '/api/me') return Promise.resolve({ data: { user: { id: 'db-user-9', clerkUserId: 'u-1' } } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    apiPost.mockResolvedValue({ data: { ok: true } });
    renderFeed();
    const [first] = await rowSelects();
    fireEvent.change(first!, { target: { value: 'assigned' } });

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/intel-api/clients/_all/alerts/a1/work-state', {
        state: 'assigned',
        assignedTo: 'db-user-9',
      }),
    );
  });

  it('blocks the mutation when the actor id cannot be resolved — never a bare 400', async () => {
    apiPost.mockResolvedValue({ data: { ok: true } });
    renderFeed(); // /api/me rejects in the default mock → self unresolved
    const [first] = await rowSelects();
    fireEvent.change(first!, { target: { value: 'assigned' } });

    expect(await screen.findByText('Assignee could not be resolved — state not changed')).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
