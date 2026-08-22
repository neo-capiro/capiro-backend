import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DistrictFederalMarketPanelVNext } from './DistrictFederalMarketPanelVNext.js';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock }),
}));

vi.mock('./DistrictEconomicFootprintPanelVNext.js', () => ({
  DistrictEconomicFootprintPanelVNext: ({ clientId, districtKey }: { clientId: string | null; districtKey: string }) => (
    <div data-testid="economic-footprint-panel">
      Economic footprint · {clientId ?? 'no client'} · {districtKey}
    </div>
  ),
}));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <DistrictFederalMarketPanelVNext clientId="client-1" districtKey="VA-10" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('DistrictFederalMarketPanelVNext', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()) },
    });
    apiGetMock.mockReset();
  });

  test('preserves typed district facts, state-only attribution warnings, actions and the Release 3 composition', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        districts: [
          {
            districtKey: 'VA-10',
            state: 'VA',
            district: '10',
            contractCount: 2,
            contractAmount: 1_200_000,
            subawardCount: 1,
            subawardAmount: 250_000,
          },
        ],
        stateSubawards: [
          {
            state: 'VA',
            subawardCount: 2,
            subawardAmount: 100_000,
            geographyBasis: 'source_state_place_of_performance',
          },
        ],
        futureSignals: [
          {
            id: 'forecast:1',
            source: 'agency_forecast',
            title: 'Future autonomy acquisition',
            agency: 'Department of the Army',
            state: 'VA',
            districtKey: null,
            date: '2027-04-01',
            geographyBasis: 'state_text',
            sourceUrl: null,
          },
        ],
        awardedMoneyIncludesFutureOpportunities: false,
        warnings: [],
        generatedAt: '2026-08-08T00:00:00.000Z',
      },
    });

    renderPanel();

    expect(await screen.findByText('$1.2M')).toBeInTheDocument();
    expect(screen.getByText('$250K')).toBeInTheDocument();
    expect(screen.getByText(/\$100K in VA-level subawards/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be assigned to VA-10/i)).toBeInTheDocument();
    expect(screen.getByText('Future autonomy acquisition')).toBeInTheDocument();
    expect(screen.getByText(/VA state-level/i)).toBeInTheDocument();
    expect(screen.getByText('Forecast')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask Meri' })).toBeInTheDocument();
    const spendingLink = screen.getByRole('link', { name: /Open Federal Spending/i });
    expect(spendingLink.getAttribute('href')).toContain('state=VA');
    expect(spendingLink.getAttribute('href')).toContain('district=10');
    expect(spendingLink.getAttribute('href')).toContain('clientId=client-1');
    expect(screen.getByTestId('economic-footprint-panel')).toHaveTextContent(
      'Economic footprint · client-1 · VA-10',
    );
  });

  test('surfaces partial market warnings without replacing healthy district data', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        districts: [
          {
            districtKey: 'VA-10',
            state: 'VA',
            district: '10',
            contractCount: 1,
            contractAmount: 400_000,
            subawardCount: 0,
            subawardAmount: null,
          },
        ],
        stateSubawards: [],
        futureSignals: [],
        awardedMoneyIncludesFutureOpportunities: false,
        warnings: ['subaward geography unavailable'],
        generatedAt: '2026-08-08T00:00:00.000Z',
      },
    });

    renderPanel();

    expect(await screen.findByText('$400K')).toBeInTheDocument();
    expect(screen.getByText('Some market context is incomplete')).toBeInTheDocument();
    expect(screen.getByText('subaward geography unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('economic-footprint-panel')).toBeInTheDocument();
  });

  test('a market failure does not claim the district is empty and does not suppress Release 3', async () => {
    apiGetMock.mockRejectedValue(new Error('failed'));

    renderPanel();

    expect(
      await screen.findByText('Federal market context is temporarily unavailable', undefined, {
        timeout: 8000,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/verified District Nexus score and district evidence above are unchanged/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('economic-footprint-panel')).toBeInTheDocument();
  });
});
