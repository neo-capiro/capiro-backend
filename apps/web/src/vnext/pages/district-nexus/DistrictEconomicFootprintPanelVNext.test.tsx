import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictEconomicFootprintPanelVNext } from './DistrictEconomicFootprintPanelVNext.js';

const get = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get }),
}));

function context(marginOfError: number | null) {
  return {
    data: {
      districtKey: 'WY-00',
      state: 'WY',
      districtCode: '00',
      metrics: [
        {
          source: 'acs',
          dataset: 'acs/acs5',
          sourceYear: 2024,
          boundaryCongress: 119,
          metricKey: 'total_population',
          value: 576851,
          unit: 'people',
          marginOfError,
          naicsCode: null,
          sourceRecordId: '56:00:B01003_001E',
          sourceUrl: 'https://api.census.gov/',
          observedAt: '2024-01-01T00:00:00.000Z',
          lastSyncedAt: '2026-09-20T00:00:00.000Z',
          metadata: {},
        },
      ],
      sources: [],
      warnings: [],
    },
  };
}

function renderPanel(marginOfError: number | null) {
  get.mockImplementation(async (path: string) => {
    if (path.includes('/economic-context')) return context(marginOfError);
    return {
      data: {
        clientId: 'client-1',
        districts: [],
        imports: [],
        evidence: [],
        coverage: { percent: 0, measured: [], missing: [] },
        totals: {
          employeeCount: null,
          payrollUsd: null,
          revenueUsd: null,
          taxesUsd: null,
          approvedEvidenceCount: 0,
          pendingEvidenceCount: 0,
        },
        warnings: [],
        generatedAt: '2026-09-20T00:00:00.000Z',
      },
    };
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DistrictEconomicFootprintPanelVNext clientId="client-1" districtKey="WY-00" />
    </QueryClientProvider>,
  );
}

describe('DistrictEconomicFootprintPanelVNext Census margin of error', () => {
  it('keeps the point estimate but never renders a nonpositive sentinel margin', async () => {
    renderPanel(-555555555);

    expect(await screen.findByText('576,851')).toBeInTheDocument();
    expect(screen.queryByText(/±-555,555,555/)).not.toBeInTheDocument();
  });

  it('renders a valid positive margin of error', async () => {
    renderPanel(1234);

    expect(await screen.findByText(/±1,234/)).toBeInTheDocument();
  });
});
