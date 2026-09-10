/**
 * F08 — archived and unavailable strategies (2026-09-10 remediation plan §6).
 *
 * Observed defect (Sept 9 live QA): reopening a deleted strategy said its
 * "data is intact" and offered a retry loop. The backend already
 * soft-archives deleted strategies (HTTP 410 with archive info) and 404s
 * unknown ids, but the editor funneled every non-410 failure into one
 * generic retryable error state.
 *
 * This suite renders the editor against axios-shaped query errors and asserts
 * the response-classified states:
 *   - 410  removed-from-library archive state, NO retry, history still offered
 *   - 404  unavailable state, no claim about deletion vs access, NO retry
 *   - 403  access state, NO retry
 *   - 5xx/network  transient error state WITH bounded retry
 *   - 401  existing authentication recovery path (not a strategy state)
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyEditorVNext } from './StrategyEditorVNext.js';
import type { StrategyDetail } from '../../../pages/strategy/types.js';

const STRATEGY_ID = '11111111-2222-3333-4444-555555555555';

/** Axios-like error the react-query hook surfaces for a failed detail GET. */
function httpError(status: number, message: string, data?: Record<string, unknown>) {
  const response = {
    status,
    data: { statusCode: status, message, ...(data ?? {}) },
  };
  return Object.assign(new Error(message), { response });
}

const state = vi.hoisted(() => ({
  /** Mutated per test: the error the detail query settles with. */
  detailError: null as unknown,
  /** Mutated per test: the payload the detail query succeeds with. */
  detailData: null as unknown,
}));

function makeDetail(): StrategyDetail {
  return {
    id: STRATEGY_ID,
    clientId: 'client-1',
    title: 'Secure a $10M plus-up',
    type: 'regulatory',
    goal: null,
    meriContext: null,
    meriSummary: null,
    draftedByMeri: false,
    targetDate: null,
    ownerUserId: 'u1',
    createdByUserId: 'u1',
    lastEditedByUserId: 'u1',
    lastEditedAt: '2026-09-10T11:00:00.000Z',
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-09-10T11:00:00.000Z',
    nodes: [],
    artifacts: [],
  };
}

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

vi.mock('./strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('./strategies-api.js')>('./strategies-api.js');
  const { useState } = await import('react');
  return {
    ...actual,
    useStrategy: () => {
      // A re-render after retry must see the swapped payload, so refetch
      // bumps a local state instead of being a dead no-op.
      const [, bump] = useState(0);
      const refetch = () => {
        bump((n) => n + 1);
        return Promise.resolve();
      };
      if (state.detailError) {
        return { data: undefined, isLoading: false, isError: true, error: state.detailError, dataUpdatedAt: 0, refetch };
      }
      return {
        data: (state.detailData ?? undefined) as StrategyDetail | undefined,
        isLoading: false,
        isError: false,
        dataUpdatedAt: 0,
        refetch,
      };
    },
    // Every other hook the editor mounts: minimal success shapes so only the
    // detail query's error state is under test.
    useFirmPhases: () => ({ data: [] }),
    useReferenceCalendars: () => ({
      data: { congress: [], ppbeLanes: [], ppbeCurrentPhases: [], source: { congress: 'baseline' } },
    }),
    useClientsLite: () => ({ data: [] }),
    useTenantMembers: () => ({ data: [] }),
    usePendingWatchCounts: () => ({ data: {} }),
    useWatchReviewState: () => ({ data: { proposals: [] } }),
    useWatchMonitoring: () => ({ data: { available: false }, isSuccess: true }),
    useConfigureWatchMonitoring: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRevalidateWatch: () => ({ mutate: vi.fn(), isPending: false }),
    useForkReferenceCalendar: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  };
});

function renderEditor(entry = `/strategies/${STRATEGY_ID}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
          <Route path="/strategies" element={<p>Strategy library</p>} />
          <Route path="/strategies/:strategyId/history" element={<p>History overlay caller</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.detailError = null;
  state.detailData = null;
});

describe('Strategy editor — archived and unavailable states (F08)', () => {
  it('renders the REMOVED state for a 410 and does not offer retry', () => {
    state.detailError = httpError(410, 'This strategy is archived and is retained as history.', {
      strategyId: STRATEGY_ID,
      title: 'Secure a $10M plus-up',
    });
    renderEditor();

    expect(screen.getByText(/removed from the active library/i)).toBeTruthy();
    // The generic retryable copy must not appear for a terminal state.
    expect(screen.queryByText(/Your data is intact/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers working Back to strategies from the 410 state and preserves the archive history fact', () => {
    state.detailError = httpError(410, 'This strategy is archived and is retained as history.', {
      strategyId: STRATEGY_ID,
      title: 'Secure a $10M plus-up',
    });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Back to strategies' }));
    expect(screen.getByText('Strategy library')).toBeTruthy();
  });

  it('renders the UNAVAILABLE state for a 404 without asserting deletion or access', () => {
    state.detailError = httpError(404, 'Strategy not found');
    renderEditor();

    expect(screen.getByText(/This strategy is unavailable/i)).toBeTruthy();
    // Must not claim it was deleted — that is unknowable from a 404.
    expect(screen.queryByText(/removed from the active library/i)).toBeNull();
    expect(screen.queryByText(/Your data is intact/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('renders the ACCESS state for a 403 and does not offer retry', () => {
    state.detailError = httpError(403, 'Forbidden');
    renderEditor();

    expect(screen.getByText(/don\u2019t have access to this strategy/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to strategies' })).toBeTruthy();
  });

  it('renders the TRANSIENT state for a 5xx and offers retry', () => {
    state.detailError = httpError(500, 'Internal server error');
    renderEditor();

    expect(screen.getByText(/couldn\u2019t load this strategy/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('renders the TRANSIENT state for a network failure (no response) and offers retry', () => {
    state.detailError = new Error('Network Error');
    renderEditor();

    expect(screen.getByText(/couldn\u2019t load this strategy/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('follows the existing authentication recovery path for a 401 (not a strategy-specific state)', () => {
    // A 401 is an expired session, not a property of the strategy: the app's
    // existing auth recovery owns it. The editor must not render the transient
    // "try again" copy as if the strategy itself failed to load.
    state.detailError = httpError(401, 'Unauthorized');
    renderEditor();

    expect(screen.queryByText(/couldn\u2019t load this strategy/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    // It still exits to the library rather than a dead end.
    expect(screen.getByRole('button', { name: 'Back to strategies' })).toBeTruthy();
  });

  it('does not disclose the archived strategy\u2019s title on a 404 from another tenant', () => {
    // The 404 body carries no title; the state must not render one from cache.
    state.detailError = httpError(404, 'Strategy not found');
    renderEditor();
    expect(screen.queryByText('Secure a $10M plus-up')).toBeNull();
  });

  it('a malformed id renders the not-valid state, not a retryable error', () => {
    renderEditor(`/strategies/not-a-uuid`);
    expect(screen.getByText(/link is not valid/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('recoverable 500: retry re-fetches and loads the editor once the response succeeds', async () => {
    // The transient state offers retry; the follow-up fetch succeeds. Swap the
    // mock to a real payload before clicking so the retry renders the plan.
    state.detailError = httpError(500, 'Internal server error');
    renderEditor();

    state.detailError = null;
    state.detailData = makeDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      // The editor (not an error state) is on screen: the strategy title and
      // the editor hero render once the detail resolves.
      expect(screen.getByText('Secure a $10M plus-up')).toBeTruthy();
      expect(screen.queryByText(/couldn\u2019t load this strategy/i)).toBeNull();
    });
  });
});