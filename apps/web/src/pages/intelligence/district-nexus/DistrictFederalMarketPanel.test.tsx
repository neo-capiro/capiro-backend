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

/**
 * The API title-decode boundary's exact output for a provider title. Mirrors
 * readableMarketTitle from the API's federal-market-future-signals.ts so these
 * tests pin the real cross-layer contract: what the API ships, the panel
 * renders verbatim.
 */
function apiTitle(providerTitle: string): string {
  return providerTitle
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, token: string) => {
      const key = token.toLowerCase();
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
      };
      if (Object.prototype.hasOwnProperty.call(named, key)) return named[key]!;
      if (key.startsWith('#x')) {
        const code = Number.parseInt(key.slice(2), 16);
        if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff)
          return String.fromCodePoint(code);
        return match;
      }
      if (key.startsWith('#')) {
        const code = Number.parseInt(key.slice(1), 10);
        if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff)
          return String.fromCodePoint(code);
        return match;
      }
      return match;
    })
    .replace(/\s+/g, ' ')
    .trim();
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

  test('a failed future lookup remains unavailable in the legacy panel', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        districts: [],
        stateSubawards: [],
        futureSignals: [],
        futureSignalsAvailability: 'unavailable',
        warnings: ['future opportunity geography unavailable'],
        awardedMoneyIncludesFutureOpportunities: false,
        generatedAt: '2026-09-09T00:00:00Z',
      },
    });
    renderPanel();
    await screen.findByText('Future procurement signals are temporarily unavailable.');
    expect(
      screen.getByText('Future signals').parentElement?.querySelector('strong'),
    ).toHaveTextContent('Unavailable');
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

  test('renders API-decoded titles verbatim, including hostile inputs', async () => {
    // Fixtures are the API boundary's ACTUAL output (readableMarketTitle) for
    // these provider titles; the legacy panel must render them byte-for-byte.
    const hostile = [
      apiTitle('Budget &lt;2028&gt; funding'),
      apiTitle('Opportunity &#x110000;'),
      apiTitle('Provider &constructor; notice'),
    ];
    for (const title of hostile) {
      apiGetMock.mockReset();
      apiGetMock.mockResolvedValue({
        data: {
          districts: [],
          stateSubawards: [],
          awardedMoneyIncludesFutureOpportunities: false,
          warnings: [],
          generatedAt: '2026-09-09T00:00:00Z',
          futureSignals: [
            {
              id: 'forecast:boundary',
              source: 'agency_forecast',
              title,
              agency: 'Department of the Army',
              state: 'VA',
              districtKey: null,
              date: '2027-04-01',
              geographyBasis: 'state_text',
              sourceUrl: null,
            },
          ],
        },
      });
      renderPanel();
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.queryByText(/native code/)).not.toBeInTheDocument();
    }
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
