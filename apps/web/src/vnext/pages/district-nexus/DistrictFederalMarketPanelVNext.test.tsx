import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DistrictFederalMarketPanelVNext } from './DistrictFederalMarketPanelVNext.js';

const { apiGetMock, flags } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  flags: { supplier: true },
}));

vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => flags.supplier,
}));

type SupplierStatusShape = {
  status: string;
  sourceCompleteness?: 'complete' | 'in_progress' | 'unknown';
  sourceCoverageNote?: string;
};
let supplierStatus: SupplierStatusShape = { status: 'available', sourceCompleteness: 'complete' };
let supplierError: unknown = null;
function setMarketResponse(value: unknown) {
  apiGetMock.mockImplementation((url: string) => {
    if (url.endsWith('/supplier-footprint/status')) {
      if (supplierError) return Promise.reject(supplierError);
      return Promise.resolve({
        data: {
          clientId: 'client-1',
          status: supplierStatus.status,
          available: supplierStatus.status === 'available',
          note: 'Coverage is based on confirmed client identity.',
          lastSuccessfulSyncAt: null,
          sourceCompleteness: supplierStatus.sourceCompleteness ?? 'unknown',
          sourceCoverageNote:
            supplierStatus.sourceCoverageNote ?? 'Coverage note from the service.',
        },
      });
    }
    return Promise.resolve(value);
  });
}

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock }),
}));

vi.mock('./DistrictEconomicFootprintPanelVNext.js', () => ({
  DistrictEconomicFootprintPanelVNext: ({
    clientId,
    districtKey,
  }: {
    clientId: string | null;
    districtKey: string;
  }) => (
    <div data-testid="economic-footprint-panel">
      Economic footprint · {clientId ?? 'no client'} · {districtKey}
    </div>
  ),
}));

function renderPanel(clientId: string | null = 'client-1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const element = () => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <DistrictFederalMarketPanelVNext clientId={clientId} districtKey="VA-10" />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const view = render(element());
  return { ...view, rerenderPanel: () => view.rerender(element()) };
}

describe('DistrictFederalMarketPanelVNext', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()) },
    });
    apiGetMock.mockReset();
    flags.supplier = true;
    supplierStatus = { status: 'available', sourceCompleteness: 'complete' };
    supplierError = null;
  });

  test('preserves typed district facts, state-only attribution warnings, actions and the Release 3 composition', async () => {
    setMarketResponse({
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
    const spendingLink = screen.getByRole('link', {
      name: /Open Federal Spending/i,
    });
    expect(spendingLink.getAttribute('href')).toContain('state=VA');
    expect(spendingLink.getAttribute('href')).toContain('district=10');
    expect(spendingLink.getAttribute('href')).toContain('clientId=client-1');
    expect(screen.getByTestId('economic-footprint-panel')).toHaveTextContent(
      'Economic footprint · client-1 · VA-10',
    );
  });

  test('renders readable forecast titles without provider HTML', async () => {
    setMarketResponse({
      data: {
        ...marketFixture.data,
        futureSignals: [
          {
            id: 'forecast:html',
            source: 'agency_forecast',
            title: 'Army autonomy<br />acquisition & sustainment',
            agency: 'Army',
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
    expect(await screen.findByText('Army autonomy acquisition & sustainment')).toBeInTheDocument();
    expect(screen.queryByText(/<br/i)).not.toBeInTheDocument();
  });

  test('surfaces partial market warnings without replacing healthy district data', async () => {
    setMarketResponse({
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

  test.each([undefined, 'unavailable'])(
    'future lookup failure is unavailable, including older API responses (%s)',
    async (availability) => {
      setMarketResponse({
        data: {
          ...marketFixture.data,
          futureSignalsAvailability: availability,
          warnings: ['future opportunity geography unavailable'],
        },
      });
      renderPanel();
      await screen.findByText('$400K');
      expect(screen.getByText('Future signals').parentElement).toHaveTextContent('Unavailable');
      expect(
        screen.getByText('Future signals').parentElement?.querySelector('strong'),
      ).not.toHaveTextContent('0');
      expect(
        screen.getByText('Future procurement signals are temporarily unavailable.'),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const prompt = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as string;
      expect(prompt).toContain('Future signals: unavailable');
      expect(prompt).not.toContain('Future signals: none in this view');
    },
  );

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

const marketFixture = {
  data: {
    districts: [
      {
        districtKey: 'VA-10',
        state: 'VA',
        district: '10',
        contractCount: 1,
        contractAmount: 400000,
        subawardCount: 1,
        subawardAmount: 250000,
      },
    ],
    stateSubawards: [
      {
        state: 'VA',
        subawardCount: 1,
        subawardAmount: 100000,
        geographyBasis: 'source_state_place_of_performance',
      },
    ],
    futureSignals: [],
    warnings: [],
    generatedAt: '2026-09-06T12:00:00Z',
    awardedMoneyIncludesFutureOpportunities: false,
  },
};

describe('visible supplier coverage uses the guarded backend status', () => {
  beforeEach(() => {
    flags.supplier = true;
    supplierError = null;
    supplierStatus = { status: 'available', sourceCompleteness: 'complete' };
    apiGetMock.mockReset();
  });
  test.each([
    ['not_populated', 'Subaward data not ingested'],
    ['no_identity', 'Client identity needed'],
    ['unavailable', 'Supplier coverage unavailable'],
  ])('%s is distinct and hides unverified supplier totals', async (status, label) => {
    supplierStatus = { status, sourceCompleteness: 'complete' };
    setMarketResponse(marketFixture);
    renderPanel();
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText('$250K')).not.toBeInTheDocument();
    expect(screen.queryByText(/in VA-level subawards/)).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.getByText('$400K')).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/intelligence/clients/client-1/district-nexus-v2/supplier-footprint/status',
    );
  });
  test('a disabled supplier flag hides the surface and never calls the supplier endpoint', async () => {
    flags.supplier = false;
    setMarketResponse(marketFixture);
    renderPanel();
    await screen.findByText('$400K');
    expect(screen.queryByLabelText('Supplier coverage')).not.toBeInTheDocument();
    expect(screen.queryByText('$250K')).not.toBeInTheDocument();
    expect(
      apiGetMock.mock.calls.some(([url]) => String(url).includes('/supplier-footprint/')),
    ).toBe(false);
  });
  test('turning the flag off removes cached supplier data immediately', async () => {
    setMarketResponse(marketFixture);
    const view = renderPanel();
    await screen.findByText('$250K');
    flags.supplier = false;
    view.rerenderPanel();
    await screen.findByText('$400K');
    expect(screen.queryByLabelText('Supplier coverage')).not.toBeInTheDocument();
  });
  test('supplier transport errors display unavailable while prime contracts remain usable', async () => {
    supplierError = new Error('network failed');
    setMarketResponse(marketFixture);
    renderPanel();
    await screen.findByText('Supplier coverage unavailable');
    expect(screen.getByText('$400K')).toBeInTheDocument();
  });
  test('a server 404 also hides the supplier surface if the flag cache is stale', async () => {
    supplierError = { response: { status: 404 } };
    setMarketResponse(marketFixture);
    renderPanel();
    await screen.findByText('$400K');
    expect(screen.queryByLabelText('Supplier coverage')).not.toBeInTheDocument();
  });
  test('without a client no supplier status request or attributed totals are shown', async () => {
    setMarketResponse(marketFixture);
    renderPanel(null);
    await screen.findByText('Select a client');
    expect(screen.queryByText('$250K')).not.toBeInTheDocument();
    expect(
      apiGetMock.mock.calls.some(([url]) => String(url).includes('/supplier-footprint/')),
    ).toBe(false);
  });
});

describe('partial supplier coverage stays explicit even when matches exist', () => {
  beforeEach(() => {
    flags.supplier = true;
    supplierError = null;
    apiGetMock.mockReset();
  });

  test('an in-progress corpus with matches keeps the totals but qualifies them as records ingested so far', async () => {
    supplierStatus = {
      status: 'available',
      sourceCompleteness: 'in_progress',
      sourceCoverageNote:
        'Subaward corpus sync is in progress: 25 records ingested so far of 2,743,636.',
    };
    setMarketResponse(marketFixture);
    renderPanel();
    expect(await screen.findByText('$250K')).toBeInTheDocument();
    // Partial coverage is explicit even though matches exist.
    expect(screen.getByText('District-resolved · records ingested so far')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Subaward corpus sync is in progress: 25 records ingested so far of 2,743,636/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('District-resolved only')).not.toBeInTheDocument();
  });

  test('an unmatched client on an in-progress corpus says "No matches in records ingested so far"', async () => {
    supplierStatus = {
      status: 'no_matching_records',
      sourceCompleteness: 'in_progress',
      sourceCoverageNote: 'Subaward corpus sync is in progress: 25 records ingested so far.',
    };
    setMarketResponse(marketFixture);
    renderPanel();
    expect(await screen.findByText('No matches in records ingested so far')).toBeInTheDocument();
    // The old hard claim is gone while the corpus is partial.
    expect(screen.queryByText('No matching records')).not.toBeInTheDocument();
    expect(screen.queryByText('$250K')).not.toBeInTheDocument();
    expect(screen.getByText('$400K')).toBeInTheDocument();
  });

  test('a complete corpus keeps the plain labels — the empty result is real', async () => {
    supplierStatus = {
      status: 'no_matching_records',
      sourceCompleteness: 'complete',
    };
    setMarketResponse(marketFixture);
    renderPanel();
    expect(await screen.findByText('No matching records')).toBeInTheDocument();
    expect(screen.queryByText(/ingested so far/i)).not.toBeInTheDocument();
  });

  test('unknown completeness keeps plain totals wording and surfaces the unknown-completeness note', async () => {
    supplierStatus = {
      status: 'available',
      sourceCompleteness: 'unknown',
      sourceCoverageNote:
        'Subaward corpus completeness is unknown: matches are based on records ingested so far only.',
    };
    setMarketResponse(marketFixture);
    renderPanel();
    expect(await screen.findByText('$250K')).toBeInTheDocument();
    // Unknown completeness must stay explicit in the note line…
    expect(screen.getByText(/Subaward corpus completeness is unknown/i)).toBeInTheDocument();
    // …but must not claim the sync is literally in progress.
    expect(screen.queryByText(/sync is in progress/i)).not.toBeInTheDocument();
    // Unknown is not proven complete, so the caption stays qualified too.
    expect(screen.getByText('District-resolved · records ingested so far')).toBeInTheDocument();
  });

  test('the Ask Meri district prompt carries the partial-coverage qualification', async () => {
    supplierStatus = {
      status: 'available',
      sourceCompleteness: 'in_progress',
      sourceCoverageNote:
        'Subaward corpus sync is in progress: 25 records ingested so far of 2,743,636.',
    };
    setMarketResponse(marketFixture);
    renderPanel();
    await screen.findByText('$250K');
    fireEvent.click(screen.getByRole('button', { name: 'Ask Meri' }));
    // askMeri is async; let the clipboard write land before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const prompt = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(prompt).toContain('Matches in records ingested so far');
    expect(prompt).toContain('Subaward corpus sync is in progress: 25 records ingested so far');
  });

  test('a disabled flag hides partial-coverage wording exactly like every other supplier state', async () => {
    flags.supplier = false;
    supplierStatus = {
      status: 'available',
      sourceCompleteness: 'in_progress',
      sourceCoverageNote: 'Subaward corpus sync is in progress.',
    };
    setMarketResponse(marketFixture);
    renderPanel();
    await screen.findByText('$400K');
    expect(screen.queryByLabelText('Supplier coverage')).not.toBeInTheDocument();
    expect(screen.queryByText(/ingested so far/i)).not.toBeInTheDocument();
    expect(
      apiGetMock.mock.calls.some(([url]) => String(url).includes('/supplier-footprint/')),
    ).toBe(false);
  });
});

describe('future signal availability is independent of other rails', () => {
  test.each([
    ['available', ['subaward geography unavailable'], '0'],
    ['unavailable', [], 'Unavailable'],
  ])(
    '%s controls the count even without a legacy warning',
    async (availability, warnings, label) => {
      setMarketResponse({
        data: { ...marketFixture.data, futureSignalsAvailability: availability, warnings },
      });
      renderPanel();
      await screen.findByText('$400K');
      expect(
        screen.getByText('Future signals').parentElement?.querySelector('strong'),
      ).toHaveTextContent(label as string);
    },
  );
});
