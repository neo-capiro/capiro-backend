/**
 * Regression test for STRATEGIES-UI-PARITY.md #2: the "Needs review" stat
 * card must carry the `st-stat--attention` warning-ring modifier once there
 * is something pending, and stay plain otherwise — the other three stat
 * cards never take this modifier.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { StrategyLibraryVNext } from './StrategyLibraryVNext.js';

vi.mock('../../adapters/legacy/useShellClientContext.js', () => ({
  useShellClientContext: () => ({
    enabled: true,
    loading: false,
    unavailable: false,
    options: [],
    selectedClientId: null,
    selectedClientName: null,
    scopeLabel: 'All clients',
    setSelectedClientId: () => {},
  }),
}));

let pendingWatchCounts: Record<string, number> = {};

vi.mock('./strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('./strategies-api.js')>('./strategies-api.js');
  return {
    ...actual,
    useStrategies: () => ({ data: [], isLoading: false, isError: false, dataUpdatedAt: 1 }),
    useClientsLite: () => ({ data: [] }),
    useTenantMembers: () => ({ data: [] }),
    useFirmPhases: () => ({ data: [] }),
    usePendingWatchCounts: () => ({ data: pendingWatchCounts }),
  };
});

function renderLibrary() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StrategyLibraryVNext />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StrategyLibraryVNext — Needs review stat attention ring', () => {
  it('stays plain when there are no pending watcher proposals', () => {
    pendingWatchCounts = {};
    renderLibrary();
    const button = screen.getByText('Needs review').closest('button');
    expect(button).toHaveClass('st-stat');
    expect(button).not.toHaveClass('st-stat--attention');
  });

  it('gets the attention modifier once a proposal is pending', () => {
    pendingWatchCounts = { 'strategy-a': 2 };
    renderLibrary();
    const button = screen.getByText('Needs review').closest('button');
    expect(button).toHaveClass('st-stat', 'st-stat--attention');
  });

  it('never applies the attention modifier to the other three stat cards', () => {
    pendingWatchCounts = { 'strategy-a': 2 };
    renderLibrary();
    for (const label of ['Active strategies', 'Approaching gates', 'Plan coverage']) {
      const button = screen.getByText(label).closest('button');
      expect(button).not.toHaveClass('st-stat--attention');
    }
  });
});
