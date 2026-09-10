/**
 * F-followup (2026-09-10 handoff): API-to-panel title contract driven by the
 * REAL API helper — not the test-local mirror the committed panel suites use.
 *
 * The committed DistrictFederalMarketPanelVNext.test.tsx / DistrictFederalMarketPanel.test.tsx
 * pin the render contract through a local `apiTitle()` MIRROR of the decode
 * boundary. A mirror can drift from the real helper while staying green —
 * exactly the class of double-decode bug this PR repairs. This spec imports
 * the ACTUAL `readableMarketTitle` from apps/api's federal-market-future-signals
 * and feeds its OUTPUT into the REAL rendered panels, so any drift between
 * the boundary and what the panels assume fails here.
 *
 * Matrix from the release handoff:
 *   provider title                 → required displayed title
 *   `Opportunity &#x110000;`       → same text, no exception
 *   `Budget &lt;2028&gt; funding`  → `Budget <2028> funding`
 *   `Provider &constructor; notice`→ same text, no function-source interpolation
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
// THE REAL API BOUNDARY — imported directly from the api package source.
import { readableMarketTitle } from '../../../../../api/src/federal-spending/federal-market-future-signals.js';
import { DistrictFederalMarketPanelVNext } from './DistrictFederalMarketPanelVNext.js';
import { DistrictFederalMarketPanel } from '../../../pages/intelligence/district-nexus/DistrictFederalMarketPanel.js';

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => true,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock }),
}));

// Same child-panel stub the committed vNext panel suite uses — the economic
// footprint panel is out of scope for the title contract.
vi.mock('./DistrictEconomicFootprintPanelVNext.js', () => ({
  DistrictEconomicFootprintPanelVNext: () => (
    <div data-testid="economic-footprint-panel">economic-footprint-panel</div>
  ),
}));

// The legacy panel uses antd's App.useApp message — inert here. Keep the rest
// of antd real via importOriginal so Typography etc. still resolve.
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    App: { ...actual.App, useApp: () => ({ message: { error: () => {} } }) },
  };
});

function marketResponseWithFutureTitles(titles: string[]) {
  return {
    data: {
      districts: [
        {
          districtKey: 'FL-08',
          state: 'FL',
          district: '08',
          contractCount: 1,
          contractAmount: 1_000,
          subawardCount: 0,
          subawardAmount: null,
        },
      ],
      stateSubawards: [],
      // Titles are what the REAL API boundary produced — panels must render
      // them verbatim.
      futureSignals: titles.map((title, index) => ({
        id: `signal-${index}`,
        source: 'sam_opportunity',
        title,
        agency: 'Test Agency',
        state: 'FL',
        districtKey: null,
        date: '2027-01-15',
        geographyBasis: 'state_text',
        sourceUrl: null,
      })),
      awardedMoneyIncludesFutureOpportunities: false,
      warnings: [],
      generatedAt: '2026-08-08T00:00:00.000Z',
    },
  };
}

function renderVNextPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DistrictFederalMarketPanelVNext districtKey="FL-08" clientId="client-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderLegacyPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DistrictFederalMarketPanel districtKey="FL-08" clientId="client-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

describe('API-to-panel title contract (real readableMarketTitle driving both panels)', () => {
  test.each([
    ['Opportunity &#x110000;', 'Opportunity &#x110000;'],
    ['Budget &lt;2028&gt; funding', 'Budget <2028> funding'],
    ['Provider &constructor; notice', 'Provider &constructor; notice'],
  ])('REAL API helper: %s decodes to the handoff-required %s', (provider, expected) => {
    const decoded = readableMarketTitle(provider);
    expect(decoded).toBe(expected);
  });

  test('REAL API helper: invalid numeric entity does not throw', () => {
    expect(() => readableMarketTitle('Opportunity &#x110000;')).not.toThrow();
    expect(() => readableMarketTitle('Bad &#xZZ; worse &unknown; &;')).not.toThrow();
  });

  test('REAL API helper output renders VERBATIM in the vNext panel (all three regressions)', async () => {
    const titles = [
      readableMarketTitle('Opportunity &#x110000;'),
      readableMarketTitle('Budget &lt;2028&gt; funding'),
      readableMarketTitle('Provider &constructor; notice'),
    ];
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/supplier-footprint/status')) {
        return Promise.resolve({
          data: { clientId: 'client-1', status: 'available', sourceCompleteness: 'complete' },
        });
      }
      if (url.includes('/api/federal-spending/market/geography')) {
        return Promise.resolve(marketResponseWithFutureTitles(titles));
      }
      return Promise.resolve({ data: {} });
    });

    renderVNextPanel();

    // All three titles render exactly as the API boundary produced them.
    expect(await screen.findByText('Opportunity &#x110000;')).toBeInTheDocument();
    expect(screen.getByText('Budget <2028> funding')).toBeInTheDocument();
    expect(screen.getByText('Provider &constructor; notice')).toBeInTheDocument();
    // The mangled variants must NOT exist.
    expect(screen.queryByText('Budget funding')).not.toBeInTheDocument();
    expect(screen.queryByText(/native code/)).not.toBeInTheDocument();
  });

  test('REAL API helper output renders VERBATIM in the legacy panel', async () => {
    const titles = [
      readableMarketTitle('Opportunity &#x110000;'),
      readableMarketTitle('Budget &lt;2028&gt; funding'),
      readableMarketTitle('Provider &constructor; notice'),
    ];
    apiGetMock.mockImplementation((url: string) => {
      if (url.includes('/supplier-footprint/status')) {
        return Promise.resolve({
          data: { clientId: 'client-1', status: 'available', sourceCompleteness: 'complete' },
        });
      }
      if (url.includes('/api/federal-spending/market/geography')) {
        return Promise.resolve(marketResponseWithFutureTitles(titles));
      }
      return Promise.resolve({ data: {} });
    });

    renderLegacyPanel();

    expect(await screen.findByText('Opportunity &#x110000;')).toBeInTheDocument();
    expect(screen.getByText('Budget <2028> funding')).toBeInTheDocument();
    expect(screen.getByText('Provider &constructor; notice')).toBeInTheDocument();
    expect(screen.queryByText('Budget funding')).not.toBeInTheDocument();
    expect(screen.queryByText(/native code/)).not.toBeInTheDocument();
  });
});
