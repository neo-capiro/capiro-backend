/**
 * Regression test for STRATEGIES-UI-PARITY.md #2: the "Needs review" stat
 * card must carry the `st-stat--attention` warning-ring modifier once there
 * is something pending, and stay plain otherwise — the other three stat
 * cards never take this modifier.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyLibraryVNext } from './StrategyLibraryVNext.js';

vi.mock('../../adapters/legacy/useShellClientContext.js', () => ({
  useShellClientContext: () => ({
    enabled: true,
    loading: false,
    unavailable: false,
    options: [],
    selectedClientId: selectedClient,
    selectedClientName: null,
    scopeLabel: 'All clients',
    setSelectedClientId: () => {},
  }),
}));

let selectedClient: string | null = null;
let libraryRows: any[] = [];
beforeEach(() => { selectedClient = null; libraryRows = [{ id: 'strategy-a', clientId: 'c1', nodeCount: 0, title: 'Empty', type: 'authorization', createdAt: '2026-09-06' }]; });
let pendingWatchCounts: Record<string, number> = {};

vi.mock('./strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('./strategies-api.js')>('./strategies-api.js');
  return {
    ...actual,
    useStrategies: () => ({ data: libraryRows, isLoading: false, isError: false, dataUpdatedAt: 1 }),
    useClientsLite: () => ({ data: [] }),
    useTenantMembers: () => ({ data: [] }),
    useFirmPhases: () => ({ data: [] }),
    usePendingWatchCounts: () => ({ data: pendingWatchCounts }),
    // Mutation hooks call useApi() (Clerk useAuth) at render time, so they must
    // be stubbed like the query hooks above or the component throws outside a
    // <ClerkProvider>.
    useDeleteStrategy: () => ({
      mutate: () => undefined,
      isPending: false,
      isError: false,
      error: null,
    }),
  };
});

function Location() { return <p data-testid="location">{useLocation().pathname}</p>; }

function renderLibrary() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StrategyLibraryVNext />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StrategyLibraryVNext — Needs review stat attention ring', () => {
  it('stays plain when there are no pending watcher proposals', () => {
    pendingWatchCounts = {};
    renderLibrary();
    const button = screen.getByText('Watcher proposals').closest('button');
    expect(button).toHaveClass('st-stat');
    expect(button).not.toHaveClass('st-stat--attention');
  });

  it('gets the attention modifier once a proposal is pending', () => {
    pendingWatchCounts = { 'strategy-a': 2 };
    renderLibrary();
    const button = screen.getByText('Watcher proposals').closest('button');
    expect(button).toHaveClass('st-stat', 'st-stat--attention');
  });

  it('never applies the attention modifier to the other three stat cards', () => {
    pendingWatchCounts = { 'strategy-a': 2 };
    renderLibrary();
    for (const label of ['Plans with steps', 'Owner coverage']) {
      const button = screen.getByText(label).closest('.st-stat');
      expect(button).not.toHaveClass('st-stat--attention');
    }
  });
});



describe('Strategy library keyboard actions', () => {
  it('does not open the row when Enter is pressed on its Delete control', () => {
    libraryRows = [{ id: '11111111-2222-3333-4444-555555555555', title: 'Budget plan', clientId: 'c1', ownerUserId: null, nodeCount: 2, type: 'appropriations', createdAt: '2026-09-06' }];
    renderLibrary();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Delete strategy Budget plan' }), { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    expect(screen.getByRole('button', { name: 'Most steps' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next gate' })).not.toBeInTheDocument();
    libraryRows = [];
  });
});

it('keeps all summary counts within the selected client and filters unfinished unassigned work', () => {
  selectedClient = 'c1';
  libraryRows = [
    { id: '11111111-2222-3333-4444-555555555555', clientId: 'c1', title: 'Working', type: 'authorization', createdAt: '2026-09-06', nodeCount: 4, summary: { assignedCount: 1, unassignedCount: 2, completedCount: 1, reviewCount: 1 } },
    { id: '22222222-2222-3333-4444-555555555555', clientId: 'c1', title: 'Empty', type: 'authorization', createdAt: '2026-09-06', nodeCount: 0, summary: { assignedCount: 0, unassignedCount: 0, completedCount: 0, reviewCount: 0 } },
    { id: '33333333-2222-3333-4444-555555555555', clientId: 'c2', title: 'Another client', type: 'authorization', createdAt: '2026-09-06', nodeCount: 30, summary: { assignedCount: 30, unassignedCount: 0, completedCount: 0, reviewCount: 0 } },
  ];
  pendingWatchCounts = { [libraryRows[0].id]: 2, [libraryRows[2].id]: 20 };
  renderLibrary();
  expect(screen.getByText('Owner coverage').closest('.st-stat')).toHaveTextContent('25%');
  expect(screen.getByText('Watcher proposals').closest('.st-stat')).toHaveTextContent('2');
  expect(screen.getByText('Plans with steps').closest('.st-stat')).toHaveTextContent('1 empty');
  fireEvent.click(screen.getByRole('button', { name: 'Unassigned work' }));
  expect(screen.getByText('Working')).toBeInTheDocument();
  expect(screen.queryByText('Empty')).not.toBeInTheDocument();
  expect(screen.queryByText('Another client')).not.toBeInTheDocument();
});
