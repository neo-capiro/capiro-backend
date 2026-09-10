import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGlobalClientFilter } from '../../../state/client-filter.js';
import { StrategyLibraryVNext } from './StrategyLibraryVNext.js';

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: async () => ({
      data: [
        { id: 'client-1', name: 'L3 Harris', status: 'active' },
        { id: 'client-2', name: 'Other client', status: 'active' },
      ],
    }),
  }),
}));

vi.mock('./strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('./strategies-api.js')>('./strategies-api.js');
  return {
    ...actual,
    useStrategies: () => ({
      data: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          clientId: 'client-1',
          title: 'L3 strategy',
          nodeCount: 1,
          type: 'authorization',
          createdAt: '2026-09-06',
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          clientId: 'client-2',
          title: 'Other strategy',
          nodeCount: 1,
          type: 'authorization',
          createdAt: '2026-09-06',
        },
      ],
      dataUpdatedAt: 1,
    }),
    useClientsLite: () => ({ data: [] }),
    useTenantMembers: () => ({ data: [] }),
    useFirmPhases: () => ({ data: [] }),
    usePendingWatchCounts: () => ({ data: {} }),
    useDeleteStrategy: () => ({ mutate: vi.fn() }),
  };
});

function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="scope-url">{location.search}</output>
      <button onClick={() => navigate(-1)}>Browser back</button>
    </>
  );
}

beforeEach(() => setGlobalClientFilter('client-2'));

describe('Strategy library client navigation (Q14)', () => {
  it('honors the incoming client, allows changing/clearing it, and restores it on Back', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/strategies?clientId=client-1&keep=1']}>
          <StrategyLibraryVNext />
          <Location />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('L3 strategy')).toBeInTheDocument();
    expect(screen.queryByText('Other strategy')).not.toBeInTheDocument();
    const scope = await screen.findByRole('button', { name: /PORTFOLIO.*L3 Harris/i });
    fireEvent.click(scope);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Other client/ }));
    expect(await screen.findByText('Other strategy')).toBeInTheDocument();
    expect(screen.queryByText('L3 strategy')).not.toBeInTheDocument();
    expect(screen.getByTestId('scope-url')).toHaveTextContent('clientId=client-2&keep=1');

    fireEvent.click(screen.getByRole('button', { name: /PORTFOLIO.*Other client/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /All clients/ }));
    expect(await screen.findByText('L3 strategy')).toBeInTheDocument();
    expect(screen.getByText('Other strategy')).toBeInTheDocument();
    expect(screen.getByTestId('scope-url')).toHaveTextContent('?keep=1');
    expect(screen.getByTestId('scope-url')).not.toHaveTextContent('clientId');

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    await waitFor(() => expect(screen.queryByText('L3 strategy')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    expect(await screen.findByText('L3 strategy')).toBeInTheDocument();
    expect(screen.queryByText('Other strategy')).not.toBeInTheDocument();
  });
});
