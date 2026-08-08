import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DistrictFederalMarketPanel } from './DistrictFederalMarketPanel.js';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock }),
}));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <DistrictFederalMarketPanel clientId="client-1" districtKey="VA-10" />
        </AntApp>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('DistrictFederalMarketPanel', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()) },
    });
    apiGetMock.mockReset();
  });

  test('shows only decision-useful district facts and keeps state-level evidence visibly separate', async () => {
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
  });

  test('surfaces partial rail warnings without replacing healthy district data', async () => {
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
  });

  test('secondary market failure does not claim the district itself is empty', async () => {
    apiGetMock.mockRejectedValue(new Error('failed'));

    renderPanel();

    // retry: 1 means the error surfaces after one retry round-trip.
    expect(
      await screen.findByText('Federal market context is temporarily unavailable', undefined, {
        timeout: 8000,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/verified District Nexus score and district evidence above are unchanged/i),
    ).toBeInTheDocument();
  });
});
