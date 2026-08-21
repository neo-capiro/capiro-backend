import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { DefenseBudgetLifecycleHealthPage } from './DefenseBudgetLifecycleHealthPage.js';
import type { CycleHealth, ScheduleTickHealth } from './defense-budget-lifecycle-api.js';

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock }) }));

let meData: { tenant: { slug: string } } | undefined = { tenant: { slug: 'capiro-internal' } };
vi.mock('../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: meData }) }));

function healthFixture(overrides: Partial<CycleHealth> = {}): CycleHealth {
  return {
    schemaVersion: 'defense_budget_cycle_health_v1',
    fiscalYear: 2027,
    generatedAt: '2027-06-01T00:00:00.000Z',
    expectedSources: 2,
    published: 1,
    verified: 1,
    reviewRequired: 1,
    rejected: 0,
    notFiled: 0,
    parserFailures: 0,
    failedDownloads: 0,
    reviewBacklog: 2,
    lastDiscoveryAt: '2027-05-30T00:00:00.000Z',
    nextWatcherRunAt: '2027-06-02T00:00:00.000Z',
    staleAdapters: [],
    tracks: [
      {
        authorityTrack: 'authorization',
        expectedSources: 1,
        published: 0,
        notFiled: 0,
        reviewRequired: 1,
        superseded: 0,
        withdrawn: 0,
        unavailable: 0,
        stillExpected: 0,
      },
    ],
    nvidiaRouting: 'disabled',
    productionParser: 'DETERMINISTIC_PRIMARY',
    missingSourceMeansUnknownNotZero: true,
    ...overrides,
  };
}

function tickHealthFixture(overrides: Partial<ScheduleTickHealth> = {}): ScheduleTickHealth {
  return {
    schemaVersion: 'defense_budget_schedule_tick_health_v1',
    generatedAt: '2027-06-01T00:00:00.000Z',
    ticksConsidered: 1,
    lastTickAt: '2027-05-31T23:00:00.000Z',
    lastTickOutcome: 'completed',
    lastTickWorkerId: 'worker-1',
    staleSinceLastTick: false,
    completedTicks: 1,
    failedTicks: 0,
    totalAdaptersConsidered: 14,
    totalAdaptersSucceeded: 2,
    totalAdaptersFailed: 0,
    totalAdaptersSkippedLease: 0,
    recentFailureReasons: [],
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/defense-budget-lifecycle']}>
        <DefenseBudgetLifecycleHealthPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DefenseBudgetLifecycleHealthPage', () => {
  it('renders real cycle-health tiles and the per-track table once data resolves', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/schedule/tick-health')) return Promise.resolve({ data: tickHealthFixture() });
      return Promise.resolve({ data: healthFixture() });
    });

    renderPage();

    // "Published"/"Review required" appear both as tile labels and as table
    // column headers, and expectedSources/reviewBacklog coincidentally share
    // the value 2 — assert on labels that are unique to the tiles instead of
    // risking an ambiguous-match failure on the coincidental duplicates.
    await waitFor(() => expect(screen.getByText('Review backlog')).toBeInTheDocument());
    expect(screen.getByText('Parser failures')).toBeInTheDocument();
    expect(screen.getByText('Failed downloads')).toBeInTheDocument();
    expect(screen.getByText('authorization')).toBeInTheDocument();
    expect(screen.getByText('disabled — DETERMINISTIC_PRIMARY')).toBeInTheDocument();
  });

  it('shows an empty state when no expected sources are registered for the fiscal year', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/schedule/tick-health')) return Promise.resolve({ data: tickHealthFixture() });
      return Promise.resolve({ data: healthFixture({ expectedSources: 0, tracks: [] }) });
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No expected sources registered for FY2027/)).toBeInTheDocument(),
    );
  });

  it('shows an error state with a retry action when the health request fails', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/schedule/tick-health')) return Promise.resolve({ data: tickHealthFixture() });
      return Promise.reject(new Error('network down'));
    });

    renderPage();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });

  it('never renders a fabricated GPU number — the reported zero fields flow through verbatim', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/schedule/tick-health')) return Promise.resolve({ data: tickHealthFixture() });
      return Promise.resolve({ data: healthFixture() });
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('disabled — DETERMINISTIC_PRIMARY')).toBeInTheDocument());
  });

  it('is not available outside the capiro-internal tenant', () => {
    meData = { tenant: { slug: 'some-other-tenant' } };
    apiGetMock.mockClear();
    renderPage();
    expect(screen.getByText('Not available for this workspace')).toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
    meData = { tenant: { slug: 'capiro-internal' } };
  });
});
