import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VNextMemoryGovernanceCenter } from './VNextMemoryGovernanceCenter.js';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

const title = 'learning-signal:crm.fill_with_meri:crm_finding_accepted:older-record';
const item = (id: string, text: string) => ({
  id,
  title: text,
  updatedAt: '2026-09-10T00:00:00Z',
  memoryScope: 'client',
  memoryClass: 'client_steering',
  memoryAuthority: 'client_approved',
  governedStatus: 'active',
  capabilities: {},
});

beforeEach(() => {
  api.get.mockReset();
  api.get.mockImplementation(async (url: string) => {
    if (url === '/api/memory/governance')
      return {
        data: {
          enabled: true,
          counts: {
            active: 426,
            pendingReview: 0,
            conflicts: 0,
            reviewDue: 0,
            history: 0,
            activeGrants: 0,
            projectionAttention: 0,
          },
        },
      };
    if (url.includes('&q=')) return { data: { enabled: true, items: [item('older', title)] } };
    return { data: { enabled: true, items: [item('first', 'First listed memory')] } };
  });
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <VNextMemoryGovernanceCenter isAdmin />
    </QueryClientProvider>,
  );
}

describe('governed memory title search', () => {
  it('searches the canonical server listing on submit and clears back to the original listing', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Active (426)' }));
    await screen.findByRole('button', { name: 'Open memory First listed memory' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search memory by title' }), {
      target: { value: title },
    });
    expect(api.get.mock.calls.some(([url]) => url.includes('&q='))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: `Open memory ${title}` });
    expect(api.get).toHaveBeenCalledWith(
      `/api/memory/governance/items?bucket=active&limit=250&q=${encodeURIComponent(title)}`,
    );
    expect(
      screen.queryByRole('button', { name: 'Open memory First listed memory' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await screen.findByRole('button', { name: 'Open memory First listed memory' });
    expect(screen.getByRole('textbox', { name: 'Search memory by title' })).toHaveValue('');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows a failed authorized read as an error rather than an empty result', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: 'Active (426)' }));
    await screen.findByRole('button', { name: 'Open memory First listed memory' });
    api.get.mockRejectedValue(new Error('Forbidden'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search memory by title' }), {
      target: { value: 'restricted' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(screen.getByText('Memory items could not be loaded')).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Open memory First listed memory' }),
    ).not.toBeInTheDocument();
    api.get.mockResolvedValue({
      data: { enabled: true, items: [item('retry', 'Recovered search result')] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: 'Open memory Recovered search result' });
  });
});
