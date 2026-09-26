import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { DefenseBudgetLifecycleHealthPage } from './DefenseBudgetLifecycleHealthPage.js';
import type {
  CoverageReconciliation,
  CycleHealth,
  ScheduleTickHealth,
} from './defense-budget-lifecycle-api.js';

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

function coverageFixture(): CoverageReconciliation {
  return {
    schemaVersion: 'defense_coverage_reconciliation_v1',
    fiscalYear: 2027,
    environment: 'unknown',
    activeSnapshotId: null,
    logicalSlotCount: 1,
    rows: [
      {
        slotId: 'slot-unattested',
        fiscalYear: 2027,
        sourceFamily: 'army-rdte-budget-justification',
        component: null,
        optional: false,
        discovery: 'unknown',
        denominator: null,
        knownRequiredUnits: 1,
        knownOptionalUnits: 1,
        parsed: 0,
        verified: 0,
        reviewed: 0,
        published: 0,
        exceptions: ['catalog_completeness_unknown', 'physical_source_missing'],
        units: [
          {
            unitId: 'unit-missing',
            kind: 'volume',
            required: true,
            superseded: false,
            account: null,
            budgetActivity: 'BA 2',
            volume: 'Volume 1',
            sourceDocumentId: null,
            sourceSha256: null,
            parsed: false,
            verified: false,
            reviewed: false,
            published: false,
            exceptions: ['physical_source_missing', 'account_attribution_unknown', 'publication_missing'],
          },
          {
            unitId: 'unit-unavailable-superseded',
            kind: 'document',
            required: false,
            superseded: true,
            account: 'Army',
            budgetActivity: null,
            volume: null,
            sourceDocumentId: 'source-2',
            sourceSha256: 'sha256-source-2',
            parsed: false,
            verified: false,
            reviewed: false,
            published: false,
            exceptions: ['source_unavailable', 'source_superseded'],
          },
        ],
      },
    ],
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
      if (url.includes('/coverage-reconciliation')) return Promise.resolve({ data: coverageFixture() });
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
    expect(screen.getByRole('option', { name: 'FY2024' })).toBeInTheDocument();
  });

  it('shows an empty state when no expected sources are registered for the fiscal year', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/coverage-reconciliation')) return Promise.resolve({ data: coverageFixture() });
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
      if (url.includes('/coverage-reconciliation')) return Promise.resolve({ data: coverageFixture() });
      if (url.includes('/schedule/tick-health')) return Promise.resolve({ data: tickHealthFixture() });
      return Promise.reject(new Error('network down'));
    });

    renderPage();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });

  it('never renders a fabricated GPU number — the reported zero fields flow through verbatim', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/coverage-reconciliation')) return Promise.resolve({ data: coverageFixture() });
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

  it('shows an unknown denominator and preserves unit-level omission exceptions', async () => {
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/coverage-reconciliation')) return Promise.resolve({ data: coverageFixture() });
      if (url.includes('/schedule/tick-health')) return Promise.resolve({ data: tickHealthFixture() });
      return Promise.resolve({ data: healthFixture() });
    });

    renderPage();

    await waitFor(() => expect(screen.getByTestId('physical-source-reconciliation')).toBeInTheDocument());
    expect(apiGetMock).toHaveBeenCalledWith('/api/budget-lifecycle/cycles/2027/coverage-reconciliation');
    expect(screen.getByText('1 known / unknown')).toBeInTheDocument();
    expect(screen.getByTestId('active-snapshot-id')).toHaveTextContent('unknown');
    expect(screen.getByTestId('source-document-id-unit-missing')).toHaveTextContent('unknown');
    expect(screen.getByTestId('source-sha256-unit-missing')).toHaveTextContent('unknown');
    expect(screen.getByTestId('source-document-id-unit-unavailable-superseded')).toHaveTextContent('source-2');
    expect(screen.getByTestId('source-sha256-unit-unavailable-superseded')).toHaveTextContent('sha256-source-2');
    expect(screen.getByText('account_attribution_unknown')).toBeInTheDocument();
    expect(screen.getAllByText('physical_source_missing')).toHaveLength(2);
    expect(screen.getByText('source_unavailable')).toBeInTheDocument();
    expect(screen.getByText('source_superseded')).toBeInTheDocument();
    expect(screen.getByText('catalog_completeness_unknown')).toBeInTheDocument();
  });
});
