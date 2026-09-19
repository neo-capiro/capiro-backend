import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet }),
}));

import { CommitteesTab } from './CommitteesTab.js';

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/legiwatch?tab=committees']}>
        <CommitteesTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({
    data: {
      rows: [],
      total: 0,
      parentCount: 0,
      subcommitteeCount: 0,
      asOf: '2026-09-18T00:00:00.000Z',
    },
  });
});

afterEach(() => vi.clearAllMocks());

describe('CommitteesTab scope link', () => {
  it('links federal users to the existing State committees directory', async () => {
    renderTab();

    expect((await screen.findByRole('link', { name: 'Browse State committees →' })).getAttribute('href')).toBe(
      '/directory/state-committees',
    );
  });

  it('keeps the State committees link visible when the federal directory errors', async () => {
    apiGet.mockRejectedValueOnce(new Error('directory unavailable'));
    renderTab();

    await screen.findByText('The federal committee directory did not respond. This is not zero committees.');
    expect(screen.getByRole('link', { name: 'Browse State committees →' }).getAttribute('href')).toBe(
      '/directory/state-committees',
    );
  });
});
