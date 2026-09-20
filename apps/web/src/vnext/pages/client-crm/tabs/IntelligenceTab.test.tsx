import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmIntelligenceProto, facilityStatus } from './IntelligenceTab.js';
import {
  buildRealDistricts,
  buildRepresentationByFacilityId,
  buildRepresentativeByDistrict,
  selectV2District,
  sortV2Districts,
} from './district-panel-model.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { ClientFacility } from '../../../../pages/clients/facilities-api.js';
import type { DistrictNexusDistrictDetail } from '../../../../pages/clients/intelligence-v1/district-nexus-api.js';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'test-tenant' }));
vi.mock('../../../components/district-map/DistrictNexusMapLibre.js', () => ({
  default: ({
    facilities,
    districts,
    selectedDistrictKey,
    onSelectDistrict,
  }: {
    facilities: unknown[];
    districts: Array<{ districtKey: string }>;
    selectedDistrictKey: string | null;
    onSelectDistrict: (districtKey: string) => void;
  }) => (
    <div
      data-testid="location-map"
      data-facilities={JSON.stringify(facilities)}
      data-selected-district={selectedDistrictKey ?? ''}
    >
      {districts.map((district) => (
        <button
          key={district.districtKey}
          type="button"
          onClick={() => onSelectDistrict(district.districtKey)}
        >
          Select {district.districtKey} on map
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

// Deterministic per-test control over the intel feature flags. The real
// hook reads /api/intelligence/feature-flags; the district tests below need
// to flip district_nexus_v2 on/off/failing without a network round-trip.
const intelFlags = vi.hoisted(() => ({
  current: { tracker_v2: false, district_nexus_v2: false } as Record<string, boolean>,
}));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({
    enabled: Boolean(intelFlags.current[feature]),
    ready: true,
  }),
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

describe('ClientCrmIntelligenceProto — legislative panel', () => {
  it('navigates to LegiWatch when "Open full board" is clicked', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/clients']}>
          <Routes>
            <Route
              path="/clients"
              element={
                <>
                  <ClientCrmIntelligenceProto client={client} view="legislative" />
                  <LocationProbe />
                </>
              }
            />
            <Route path="/legiwatch" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText('Open full board →'));

    expect(screen.getByTestId('location')).toHaveTextContent(
      '/legiwatch?tab=bills&client=client-1',
    );
  });
});

function renderDistrict() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmIntelligenceProto client={client} view="district" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const FACILITY: ClientFacility = {
  id: 'fac-1',
  clientId: 'client-1',
  name: 'Seattle HQ',
  addressLine: null,
  city: 'Seattle',
  state: 'WA',
  zip: null,
  congressionalDistrict: '07',
  districtSource: 'geocoder',
  employeeCount: 248,
  notes: null,
  latitude: 47.61,
  longitude: -122.33,
  stateHouseDistrict: null,
  stateSenateDistrict: null,
  geocodedAt: '2026-01-01T00:00:00.000Z',
  geocodeStatus: 'matched',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const NEXUS_LINKED = {
  linked: true,
  contractorNames: ['Overland AI Inc'],
  totalAwards: 3,
  totalAmount: 12_000_000,
  districtCount: 1,
  unmappedAmount: 0,
  districts: [
    {
      district: 'WA-07',
      state: 'WA',
      districtNumber: '07',
      awardCount: 3,
      totalAmount: 12_000_000,
      demographics: null,
      representatives: { house: null, senate: [] },
    },
  ],
  disclaimer: 'Figures reflect confirmed contractor mappings only.',
};

const NEXUS_V2 = {
  clientId: 'client-1',
  districts: [
    {
      districtKey: 'WA-07',
      state: 'WA',
      districtCode: '07',
      name: 'WA-07',
      status: 'C',
      score: 75,
      coveragePercent: 80,
      clientCount: 1,
      employeeCount: 248,
      employeesUnreported: false,
      awarded: { contractObligations: 12_000_000, grantObligations: null, grantOutlays: null },
      opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
      breakdown: [],
      strongestDrivers: [],
      evidence: [],
      warnings: [],
    },
  ],
  representativesByFacility: [],
  linkage: {
    contractingLinked: true,
    contractorNames: ['Overland AI Inc'],
    assistanceLinked: false,
    recipientNames: [],
    ueiConfirmedCount: 1,
  },
  facilityFootprint: {
    facilityCount: 1,
    facilitiesWithoutDistrict: 0,
    employeeCount: 248,
    facilitiesMissingEmployeeCount: 0,
  },
  awarded: { contractObligations: 12_000_000, grantObligations: null, grantOutlays: null },
  opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
  opportunitySummary: {
    total: 0,
    active: 0,
    eligible: 0,
    needsReview: 0,
    ineligible: 0,
    unknown: 0,
    totalEstimatedFunding: null,
    totalAwardCeiling: null,
    items: [],
  },
  unmapped: {
    unmappedContractAmount: null,
    unmappedGrantAmount: null,
    unmappedContractCount: 0,
    unmappedGrantCount: 0,
  },
  score: 75,
  bestDistrictKey: 'WA-07',
  coveragePercent: 80,
  breakdown: [],
  strongestDrivers: [],
  freshness: [],
  warnings: [],
  generatedAt: '2026-09-20T00:00:00.000Z',
};

const REPRESENTATION: import('../../../../pages/clients/intelligence-v1/representation-api.js').FacilityRepresentation[] =
  [
    {
      facility: { id: 'fac-1', name: 'Seattle HQ', city: 'Seattle', state: 'WA' },
      representation: {
        unresolved: false,
        federal: {
          house: {
            bioguideId: 'X000000',
            fullName: 'Rep. Jamie Rivera',
            party: 'D',
            state: 'WA',
            district: 7,
            chamber: 'House',
          },
          senate: [],
        },
        state: { lower: null, upper: null },
      },
    },
  ];

describe('DistrictPanel pure selectors', () => {
  it('derives facility fallback districts and representatives without inventing award values', () => {
    const repByFacilityId = buildRepresentationByFacilityId(REPRESENTATION);
    const districts = buildRealDistricts([FACILITY], new Map(), repByFacilityId);
    const representatives = buildRepresentativeByDistrict([FACILITY], repByFacilityId);

    expect(districts).toMatchObject([
      {
        code: 'WA-07',
        totalAmount: null,
        awardCount: null,
        employeeCount: 248,
        repName: 'Rep. Jamie Rivera',
      },
    ]);
    expect(representatives.get('WA-07')).toEqual({
      name: 'Rep. Jamie Rivera',
      party: 'D',
    });
  });

  it('uses a valid explicit v2 selection, then the best district, then sorted first', () => {
    const base = NEXUS_V2.districts[0] as unknown as DistrictNexusDistrictDetail;
    const districts = sortV2Districts([base, { ...base, districtKey: 'CA-12', score: 88 }]);

    expect(selectV2District(districts, 'CA-12', 'WA-07').effectiveSelected).toBe('CA-12');
    expect(selectV2District(districts, 'missing', 'WA-07').effectiveSelected).toBe('WA-07');
    expect(selectV2District(districts, null, null).effectiveSelected).toBe('CA-12');
  });
});

function mockDistrictApis(
  overrides: { facilities?: unknown; nexusV2?: unknown; representation?: unknown } = {},
) {
  const facilities = overrides.facilities ?? [FACILITY];
  const nexusV2 = overrides.nexusV2 ?? NEXUS_V2;
  const representation = overrides.representation ?? REPRESENTATION;
  getMock.mockImplementation((url: string) => {
    if (url === '/api/clients/client-1/facilities') return Promise.resolve({ data: facilities });
    if (url === '/api/intelligence/clients/client-1/district-nexus-v2') {
      return intelFlags.current.district_nexus_v2
        ? Promise.resolve({ data: nexusV2 })
        : Promise.reject({ response: { status: 404 } });
    }
    if (url === '/api/clients/client-1/representation')
      return Promise.resolve({ data: representation });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('ClientCrmIntelligenceProto — district panel (items 1-2, wire-audit)', () => {
  it('supplies saved locations to the shared map even when District Nexus v2 is disabled', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: false };
    const locations = [
      { ...FACILITY, latitude: 47.6, longitude: -122.3 },
      { ...FACILITY, id: 'fac-2', latitude: 47.5, longitude: -122.2 },
    ];
    mockDistrictApis({ facilities: locations });
    renderDistrict();
    const map = await screen.findByTestId('location-map');
    expect(JSON.parse(map.getAttribute('data-facilities')!)).toEqual(locations);
  });
  beforeEach(() => {
    getMock.mockReset();
    intelFlags.current = { tracker_v2: false, district_nexus_v2: false };
  });

  it('binds the map, rail, and selected-district panel to real facilities/district-nexus/representation data', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: true };
    mockDistrictApis();
    renderDistrict();

    await waitFor(() =>
      expect(screen.getByText('Rep. Jamie Rivera (Democrat) · House')).toBeInTheDocument(),
    );
    // Compact money is the app-wide convention (district-nexus-format).
    expect(screen.getAllByText('$12.0M').length).toBeGreaterThan(0);
    expect(screen.getAllByText('WA-07').length).toBeGreaterThan(0);

    // The design fixture's own facility/rep must not leak through as if real.
    expect(screen.queryByText('Seattle headquarters')).not.toBeInTheDocument();
    expect(screen.queryByText('Rep. Jane Doe · House · HASC')).not.toBeInTheDocument();
    expect(screen.queryByText('8 districts · 92% coverage')).not.toBeInTheDocument();
  });

  it('renders successful v2 data and selects another scored district from the map', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: true };
    const secondDistrict = {
      ...NEXUS_V2.districts[0],
      districtKey: 'CA-12',
      state: 'CA',
      districtCode: '12',
      name: 'CA-12',
      score: 88,
      coveragePercent: 92,
      employeeCount: 75,
      awarded: {
        contractObligations: 3_500_000,
        grantObligations: 250_000,
        grantOutlays: null,
      },
    };
    mockDistrictApis({
      nexusV2: {
        ...NEXUS_V2,
        districts: [...NEXUS_V2.districts, secondDistrict],
        bestDistrictKey: 'WA-07',
      },
    });
    renderDistrict();

    const map = await screen.findByTestId('location-map');
    expect(map).toHaveAttribute('data-selected-district', 'WA-07');
    expect(screen.getByText('Strong nexus · 75')).toBeInTheDocument();

    fireEvent.click(within(map).getByRole('button', { name: 'Select CA-12 on map' }));

    await waitFor(() => expect(map).toHaveAttribute('data-selected-district', 'CA-12'));
    expect(screen.getByText('Strong nexus · 88')).toBeInTheDocument();
    expect(screen.getByText('$3.5M')).toBeInTheDocument();
    expect(screen.getByText('$250K')).toBeInTheDocument();
  });

  it('wires the facilities & representation table per-facility', async () => {
    mockDistrictApis();
    renderDistrict();

    await waitFor(() => expect(screen.getByText('Matches saved district')).toBeInTheDocument());
    expect(screen.getAllByText('Seattle HQ').length).toBeGreaterThan(0);
  });

  it('shows an honest empty state instead of the fixture when the client has no facilities', async () => {
    mockDistrictApis({ facilities: [] });
    renderDistrict();

    await waitFor(() =>
      expect(screen.getByText('No facilities recorded for this client')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Seattle headquarters')).not.toBeInTheDocument();
  });

  it('shows a skeleton while loading — never the design fixture masquerading as data', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderDistrict();

    // The invented "8 districts · 92% coverage" fixture must not stand in for
    // a real client while queries are in flight.
    expect(screen.queryByText('8 districts · 92% coverage')).not.toBeInTheDocument();
    expect(screen.queryByText('Seattle headquarters')).not.toBeInTheDocument();
  });

  /**
   * This used to assert `?tab=facilities`, and passed while the button was DEAD:
   * `client-crm-routing` maps that legacy tab back to intelligence/district, so
   * the navigation landed on the view already on screen and nothing happened.
   * Assert the outcome the user needs — an editor — not a URL.
   */
  it('opens the vNext facilities editor from "Manage facilities" (item 3, wire-audit)', async () => {
    getMock.mockResolvedValue({ data: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/clients?clientId=client-1']}>
          <Routes>
            <Route
              path="/clients"
              element={
                <>
                  <ClientCrmIntelligenceProto client={client} view="district" />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByText('Manage facilities'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Facilities — Overland AI');
    expect(within(dialog).getByRole('button', { name: 'Add facility' })).toBeInTheDocument();
    // In-place: no navigation, and in particular not the old dead ?tab=facilities.
    expect(screen.getByTestId('location')).not.toHaveTextContent('tab=facilities');
  });

  it('a v2 request ERROR (not the 404 feature-off answer) is named with a retry, while the v1 facility view still renders', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: true };
    mockDistrictApis();
    // The v2 endpoint 500s; facilities/nexus/representation succeed.
    const original = getMock.getMockImplementation()!;
    getMock.mockImplementation((url: string) =>
      url.includes('district-nexus-v2')
        ? Promise.reject({ response: { status: 500 }, message: 'nexus v2 exploded' })
        : original(url),
    );
    renderDistrict();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Scored district data is unavailable right now');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The v1 fallback still rendered real data — an outage is not an absence.
    await waitFor(() => expect(screen.getAllByText('WA-07').length).toBeGreaterThan(0));
  });

  it('a failed representation fetch is named, not silently rendered as "every facility unmatched"', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: false };
    getMock.mockImplementation((url: string) => {
      if (url === '/api/clients/client-1/facilities')
        return Promise.resolve({ data: [{ ...FACILITY, latitude: 47.6, longitude: -122.3 }] });
      if (url === '/api/clients/client-1/representation')
        return Promise.reject({ response: { status: 500 }, message: 'representation down' });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderDistrict();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Representation for these facilities could not be resolved');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('with the v2 flag OFF the stats strip stays unavailable instead of querying legacy spend', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: false };
    mockDistrictApis();
    renderDistrict();

    const label = await screen.findByText('Districts');
    const cell = label.closest('.capiro-intel-stats-cell');
    if (!cell) throw new Error('District count statistic not found');
    expect(within(cell as HTMLElement).getByText('—', { exact: true })).toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalledWith(
      '/api/intelligence/clients/client-1/district-nexus-spend',
    );
  });
});

function renderLegislative() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmIntelligenceProto client={client} view="legislative" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const RECOMMENDATION_BILL = {
  billId: 'bill-4471',
  displayNum: 'S. 4471',
  title: 'Unmanned Ground Systems Interoperability Act',
  stage: 'introduced',
  probability: 0.4,
  fit: 0.91,
  belowFloor: false,
  matchedTags: [],
  matchReasons: [],
  whyKind: 'capability',
  why: 'Real relevance-engine explanation, not the design fixture copy',
  latestAction: null,
  latestActionDate: null,
  sponsorName: null,
  sponsorParty: null,
  cosponsorsCount: 0,
};

function mockLegislativeApis(overrides: { flags?: unknown; recommendations?: unknown } = {}) {
  const flags = overrides.flags ?? {};
  const recommendations = overrides.recommendations ?? {
    recommendations: [RECOMMENDATION_BILL],
    aboveFloorCount: 1,
    total: 1,
    floor: 0.5,
  };
  getMock.mockImplementation((url: string) => {
    if (url === '/intel-api/feature-flags') return Promise.resolve({ data: flags });
    if (url === '/api/intelligence/clients/client-1/tracker/recommendations') {
      return Promise.resolve({ data: recommendations });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  postMock.mockResolvedValue({ data: {} });
}

describe('ClientCrmIntelligenceProto — Track bill (header, legacy parity)', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('opens the bill-search modal from the header Track bill button', async () => {
    mockLegislativeApis();
    renderLegislative();

    fireEvent.click(screen.getByRole('button', { name: 'Track bill' }));
    expect(await screen.findByLabelText('Search bills')).toBeInTheDocument();
    expect(screen.getByText(/Search Congress by number or title/i)).toBeInTheDocument();
  });

  it('does not render the removed Recommendations section', async () => {
    mockLegislativeApis();
    renderLegislative();

    await waitFor(() => expect(screen.getAllByText('Tracked bills').length).toBeGreaterThan(0));
    expect(screen.queryByText('Recommendations')).not.toBeInTheDocument();
    expect(screen.queryByText('High-fit recommendations')).not.toBeInTheDocument();
  });
});

function renderFootprint() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmIntelligenceProto client={client} view="footprint" />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const LDA_FILING = {
  filingUuid: 'lda-1',
  filingType: 'LD-2',
  filingYear: 2026,
  filingPeriod: '2026 Q2',
  income: 480_000,
  expenses: 0,
  amount: 480_000,
  postedAt: '2026-07-01T00:00:00.000Z',
  registrantName: 'Capitol Strategies Group',
  clientName: 'Overland AI',
  issueCodes: ['DEF', 'HOM'],
  governmentEntities: ['DoD', 'Army'],
  lobbyists: [],
  documentUrl: 'https://lda.senate.gov/filings/lda-1',
};

const LDA_FILINGS_REAL = {
  matched: true,
  ldaClientIds: [123],
  totalFilings: 1,
  totalIncome: 480_000,
  totalExpenses: 0,
  firstFilingYear: 2026,
  latestFilingYear: 2026,
  registrants: [{ name: 'Capitol Strategies Group', filings: 1, income: 480_000 }],
  byYear: [{ year: 2026, income: 480_000, expenses: 0, filings: 1 }],
  filings: [LDA_FILING],
};

const PAC_GIVING_REAL = {
  pacGiving: {
    tracked: true,
    committees: [
      {
        committeeId: 'C001',
        committeeName: 'Overland AI PAC',
        totalAmount: 90_000,
        disbursementCount: 4,
        recipients: [
          {
            recipientName: 'WHITFIELD FOR CONGRESS',
            candidateName: 'Dana Whitfield',
            totalAmount: 60_000,
          },
          { recipientName: 'REYES FOR SENATE', candidateName: 'Luis Reyes', totalAmount: 30_000 },
        ],
      },
    ],
    summary: { totalAmount: 90_000, disbursementCount: 4, recipientCount: 2 },
  },
};

function mockFootprintApis(overrides: { lda?: unknown; nexusV2?: unknown; fec?: unknown } = {}) {
  const lda = overrides.lda ?? LDA_FILINGS_REAL;
  const nexusV2 = overrides.nexusV2 ?? NEXUS_V2;
  const fec = overrides.fec ?? PAC_GIVING_REAL;
  intelFlags.current = { tracker_v2: false, district_nexus_v2: true };
  getMock.mockImplementation((url: string) => {
    if (url === '/api/intelligence/clients/client-1/lda-filings')
      return Promise.resolve({ data: lda });
    if (url === '/api/intelligence/clients/client-1/district-nexus-v2') {
      return Promise.resolve({ data: nexusV2 });
    }
    if (url === '/api/intelligence/clients/client-1/fec-money-flow')
      return Promise.resolve({ data: fec });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('ClientCrmIntelligenceProto — footprint panel (item 7, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('binds the lobbying disclosure table and headline to real LDA filings', async () => {
    mockFootprintApis();
    renderFootprint();

    await waitFor(() => expect(screen.getByText('Capitol Strategies Group')).toBeInTheDocument());
    // Headline (sum of filings) and the single row's amount coincide at $480,000 with only one mock filing.
    expect(screen.getAllByText('$480,000').length).toBeGreaterThan(0);
    expect(screen.getByText('DEF · HOM')).toBeInTheDocument();
    // The fixture's own registrant must not leak through as if real.
    expect(screen.queryByText('Northwest Government Affairs')).not.toBeInTheDocument();
  });

  it('binds the federal awards headline to the real district-nexus total and wires "View awards"', async () => {
    mockFootprintApis();
    renderFootprint();

    await waitFor(() => expect(screen.getAllByText('$12.0M').length).toBeGreaterThan(0));
    expect(getMock).not.toHaveBeenCalledWith(
      '/api/intelligence/clients/client-1/district-nexus-spend',
    );

    fireEvent.click(screen.getByText('View contracts'));
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/intelligence/federal-spending?tab=contracts&clientId=client-1',
    );
  });

  it('shows Federal contracts as unavailable instead of loading forever when v2 is disabled', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: false };
    getMock.mockImplementation((url: string) => {
      if (url === '/api/intelligence/clients/client-1/lda-filings')
        return Promise.resolve({ data: LDA_FILINGS_REAL });
      if (url === '/api/intelligence/clients/client-1/fec-money-flow')
        return Promise.resolve({ data: PAC_GIVING_REAL });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderFootprint();

    expect(
      await screen.findByText(/District Nexus v2 is not enabled.*contract totals are unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Loading federal contracts…')).not.toBeInTheDocument();
  });

  it('shows loading states without invented financial values', () => {
    getMock.mockImplementation(() => new Promise(() => {}));
    renderFootprint();

    // "$1.8M"/"$84.2M" also appear in the domain stats strip's own fixture cells.
    expect(screen.queryByText('$1.8M')).not.toBeInTheDocument();
    expect(screen.getByText('Loading lobbying activity…')).toBeInTheDocument();
    expect(screen.queryByText('$84.2M')).not.toBeInTheDocument();
    expect(screen.queryByText('Northwest Government Affairs')).not.toBeInTheDocument();
  });

  /**
   * Federal Footprint reads three independent sources (LDA, district-nexus
   * spend, FEC). Each of the five domain-stats-strip cells maps to exactly
   * ONE source, so a slow/failed source must only blank ITS OWN cells — not
   * the other two sources' cells, which already have a real answer. This
   * used to require ALL THREE to succeed before showing anything.
   */
  it('fills in LDA- and awards-derived stats immediately even while FEC is still loading', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: true };
    getMock.mockImplementation((url: string) => {
      if (url === '/api/intelligence/clients/client-1/lda-filings')
        return Promise.resolve({ data: LDA_FILINGS_REAL });
      if (url === '/api/intelligence/clients/client-1/district-nexus-v2')
        return Promise.resolve({ data: NEXUS_V2 });
      if (url === '/api/intelligence/clients/client-1/fec-money-flow') return new Promise(() => {}); // never resolves
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderFootprint();

    // Wait on the awards VALUE, not its label: every label renders on the
    // first paint in the dash state, so awaiting the label would resolve
    // before the district-nexus query settles and assert against a cell that
    // is still legitimately loading.
    await screen.findAllByText('$12.0M');
    const awardsCell = screen.getByText('Federal contracts', {
      selector: '.capiro-intel-stats-label',
    });
    expect(
      within(awardsCell.closest('.capiro-intel-stats-cell') as HTMLElement).getByText('$12.0M'),
    ).toBeInTheDocument();

    const ldaCell = screen.getByText('LDA filings').closest('.capiro-intel-stats-cell');
    expect(within(ldaCell as HTMLElement).getByText('1')).toBeInTheDocument();

    // FEC never answered — its own cell stays an honest dash, not $0 and not blank.
    const pacCell = screen
      .getByText('PAC contributions', { selector: '.capiro-intel-stats-label' })
      .closest('.capiro-intel-stats-cell');
    expect(within(pacCell as HTMLElement).getByText('—')).toBeInTheDocument();
  });

  /**
   * "Export profile" (header) previously had no onClick at all — a static
   * <SecondaryBtn> in DOMAIN_META, same defect class as the already-fixed
   * Manage facilities/Configure buttons. The real destination is the
   * report-card export route, now rendering an actual .docx server-side.
   */
  it('downloads the report card .docx when "Export profile" is clicked', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: true };
    const docxBlob = new Blob(['fake-docx-bytes'], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    getMock.mockImplementation((url: string) => {
      if (url === '/api/intelligence/clients/client-1/lda-filings')
        return Promise.resolve({ data: LDA_FILINGS_REAL });
      if (url === '/api/intelligence/clients/client-1/district-nexus-v2')
        return Promise.resolve({ data: NEXUS_V2 });
      if (url === '/api/intelligence/clients/client-1/fec-money-flow')
        return Promise.resolve({ data: PAC_GIVING_REAL });
      if (url === '/api/intelligence/clients/client-1/report-card/export')
        return Promise.resolve({ data: docxBlob });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    const blobs: Blob[] = [];
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        blobs.push(blob as Blob);
        return 'blob:report-card';
      });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    renderFootprint();
    await waitFor(() => expect(screen.getByText('Export profile')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Export profile'));

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    // The mutation wraps the fetched blob in a fresh Blob (to set the download's
    // content type), so it is not the SAME object as the mocked response —
    // assert on the bytes it carries instead.
    await expect(readBlob(blobs[0]!)).resolves.toBe('fake-docx-bytes');

    createUrl.mockRestore();
    revokeUrl.mockRestore();
    clickSpy.mockRestore();
  });
});

describe('ClientCrmIntelligenceProto — political giving (item 20, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('renders the real PAC total and real top recipients instead of the fixture buckets', async () => {
    mockFootprintApis();
    renderFootprint();

    await waitFor(() => expect(screen.getByText('$90,000')).toBeInTheDocument());
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
    expect(screen.getByText('Luis Reyes')).toBeInTheDocument();
    // The fixture's invented categories have no equivalent in the data.
    expect(screen.queryByText('Incumbent members')).not.toBeInTheDocument();
    expect(screen.queryByText('Leadership PACs')).not.toBeInTheDocument();
  });

  it('says no committee is mapped rather than rendering an unmapped client as $0', async () => {
    mockFootprintApis({ fec: { pacGiving: { tracked: false, committees: [] } } });
    renderFootprint();

    await waitFor(() =>
      expect(screen.getByText(/No FEC committee is mapped to this client/)).toBeInTheDocument(),
    );
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('Incumbent members')).not.toBeInTheDocument();
  });

  it.each(['pending', 'partial', 'error'])(
    'does not present incomplete %s ingestion as zero giving',
    async (status) => {
      mockFootprintApis({
        fec: {
          pacGiving: {
            tracked: true,
            committees: [
              {
                committeeId: 'C00763623',
                committeeName: 'Example PAC',
                totalAmount: 0,
                disbursementCount: 0,
                recipients: [],
              },
            ],
            summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
            coverage: {
              status,
              cycles: [2024, 2026],
              lastSyncedAt: null,
              message: 'The source import has not completed.',
            },
          },
        },
      });
      renderFootprint();

      await screen.findByText(/The source import has not completed/);
      expect(screen.queryByText('$0')).not.toBeInTheDocument();
      expect(screen.getByText('2024, 2026 election cycles')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open Example PAC on FEC' })).toHaveAttribute(
        'href',
        'https://www.fec.gov/data/committee/C00763623/',
      );
      expect(
        screen.queryByText(/No political contributions were reported/),
      ).not.toBeInTheDocument();
    },
  );

  it('shows zero only when every mapped committee and cycle has a completed empty import', async () => {
    mockFootprintApis({
      fec: {
        pacGiving: {
          tracked: true,
          committees: [],
          summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
          coverage: {
            status: 'complete',
            cycles: [2026],
            lastSyncedAt: '2026-09-09T07:20:00Z',
            message: null,
          },
        },
      },
    });
    renderFootprint();

    await screen.findByText(/No political contributions were reported/);
    expect(screen.getAllByText('$0').length).toBeGreaterThan(0);
    expect(screen.getByText('2026 election cycle')).toBeInTheDocument();
  });

  it('retains the available amount but labels incomplete source coverage when an update fails', async () => {
    mockFootprintApis({
      fec: {
        pacGiving: {
          ...PAC_GIVING_REAL.pacGiving,
          coverage: {
            status: 'error',
            cycles: [2026],
            lastSyncedAt: null,
            message: 'The source import failed.',
          },
        },
      },
    });
    renderFootprint();

    await screen.findByText('Source update failed.');
    expect(screen.getByText('$90,000')).toBeInTheDocument();
    expect(screen.getByText(/The amount shown reflects the available records/)).toBeInTheDocument();
    expect(
      screen.getByText('PAC contributions · incomplete', { selector: '.capiro-intel-stats-label' }),
    ).toBeInTheDocument();
  });
});

describe('ClientCrmIntelligenceProto — bill board (item 19, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  const BOARD = {
    columns: [
      {
        id: 'introduced',
        label: 'Introduced',
        count: 1,
        bills: [
          {
            billId: 'b1',
            displayNum: 'H.R. 5150',
            title: 'Maritime Uncrewed Logistics Act',
            stage: 'introduced',
            probability: 0.62,
            tags: [],
            isManual: true,
            trackedAt: '2026-06-01T00:00:00.000Z',
            unread: true,
            change: { tone: 'notable', label: 'Committee action', dot: true },
            latestActionText: 'Referred to House Armed Services',
          },
        ],
      },
      { id: 'committee', label: 'In committee', count: 0, bills: [] },
      { id: 'passed', label: 'Passed chamber', count: 0, bills: [] },
      { id: 'enacted', label: 'Enacted', count: 0, bills: [] },
    ],
    total: 1,
  };

  function mockBoardApis(board: unknown = BOARD, withheld?: number) {
    const payload = withheld == null ? board : { ...(board as object), withheld };
    getMock.mockImplementation((url: string) => {
      if (url === '/intel-api/feature-flags') return Promise.resolve({ data: {} });
      if (url === '/api/intelligence/clients/client-1/tracker/board')
        return Promise.resolve({ data: payload });
      if (url === '/api/intelligence/clients/client-1/tracker/recommendations') {
        return Promise.resolve({
          data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  }

  it('renders real board bills, labelling probability as passage rather than fit', async () => {
    mockBoardApis();
    renderLegislative();

    await waitFor(() =>
      expect(screen.getByText('Maritime Uncrewed Logistics Act')).toBeInTheDocument(),
    );
    expect(screen.getByText('H.R. 5150')).toBeInTheDocument();
    expect(screen.getByText('62% pass')).toBeInTheDocument();
    expect(screen.getByText('Referred to House Armed Services')).toBeInTheDocument();
    // The BILLS fixture must not leak through as if real.
    expect(screen.queryByText('Defense Autonomy Test Range Act')).not.toBeInTheDocument();
  });

  it('states withheld bills rather than silently bounding the board', async () => {
    mockBoardApis(BOARD, 7);
    renderLegislative();

    await waitFor(() =>
      expect(screen.getByText('7 more tracked bills not shown')).toBeInTheDocument(),
    );
  });

  it('shows a real empty state when the board is genuinely empty', async () => {
    mockBoardApis({ columns: [], total: 0 });
    renderLegislative();

    await waitFor(() =>
      expect(
        screen.getByText(
          (content, el) => el?.tagName === 'P' && /No bills are on this client/.test(content),
        ),
      ).toBeInTheDocument(),
    );
  });
});

/* ═══════ wire-audit "3 Compose extend" items 4-5 ═════════════════════════ */

// Regulatory used to be its own view key; it is now rendered as a section
// inside the merged "legislative" (Legislative & Regulatory) view, so every
// call site below renders that one view regardless of which content it's
// asserting on.
function renderWithRoutes(view: 'legislative' = 'legislative') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmIntelligenceProto client={client} view={view} />
                <LocationProbe />
              </>
            }
          />
          <Route path="/legiwatch" element={<LocationProbe />} />
          <Route path="/radar" element={<LocationProbe />} />
          <Route path="/intelligence/changes" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientCrmIntelligenceProto — Configure (item 4, "3 Compose extend")', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('opens LegiWatch Bills, scoped to this client (Q07 — was /radar?tab=watchlist, unreachable + removed tab)', () => {
    mockLegislativeApis();
    renderWithRoutes('legislative');

    fireEvent.click(screen.getByText('Configure'));

    // Q07 (evidence #58/#65): /radar is a query-preserving redirect straight to
    // /legiwatch, and vNext's LegiWatch module treats `watchlist` as a REMOVED
    // tab (silently redirected to Hearings) — so the old /radar?tab=watchlist
    // destination never actually opened a bills/watchlist view. LegiWatch's own
    // Bills tab is the real, still-live destination; ?client= keeps this client's
    // scope instead of landing on all clients.
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/legiwatch?tab=bills&client=client-1',
    );
  });
});

/* ── item 5, Calendar ────────────────────────────────────────────────────── */

const AGGREGATE_WITH_DEADLINES = {
  client: { id: 'client-1', name: 'Overland AI' },
  generatedAt: '2026-08-16T00:00:00.000Z',
  links: {},
  sections: {
    legislativeRegulatory: {
      regulatoryLifecycle: {
        totalRegulations: 2,
        rails: [
          {
            documentNumber: '2026-17422',
            // Deliberately absent from portfolio-fixtures.ts.
            title: 'Unmanned Systems Cyber Baseline; Proposed Rule',
            agencyNames: ['Department of the Navy'],
            linkedBills: [],
            currentStage: 'Comment period open',
            deadline: '2027-02-11T00:00:00.000Z',
            stages: [],
          },
          {
            documentNumber: '2026-17999',
            title: 'Rule with no comment deadline',
            agencyNames: ['GSA'],
            linkedBills: [],
            currentStage: 'Final rule',
            deadline: null,
            stages: [],
          },
        ],
      },
    },
  },
};

function regulatoryResponse(data: any) {
  return {
    clientId: client.id,
    generatedAt: data.generatedAt,
    partial: false,
    sources: [],
    regulatoryLifecycle: data.sections?.legislativeRegulatory?.regulatoryLifecycle ?? { rails: [] },
  };
}

function mockAggregate(data: unknown) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/intelligence/clients/client-1/regulatory-profile')
      return Promise.resolve({ data: regulatoryResponse(data) });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('ClientCrmIntelligenceProto — Calendar (item 5, "3 Compose extend")', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('renders the real comment deadlines instead of the DEADLINES fixture', async () => {
    mockAggregate(AGGREGATE_WITH_DEADLINES);
    renderWithRoutes();

    const deadlineRail = await screen.findByTestId('capiro-intel-deadline-rail');
    await waitFor(() =>
      expect(
        within(deadlineRail).getByText('Unmanned Systems Cyber Baseline; Proposed Rule'),
      ).toBeInTheDocument(),
    );
    // A rail with no deadline is not a deadline — it must not appear on the
    // deadline rail specifically (it legitimately appears in Active matters
    // below, which lists every rail regardless of whether it has a deadline).
    expect(
      within(deadlineRail).queryByText('Rule with no comment deadline'),
    ).not.toBeInTheDocument();
    // The fixture's own deadlines must not leak through as if real.
    expect(screen.queryByText('Submit or approve comment strategy')).not.toBeInTheDocument();
    expect(screen.queryByText('Final rule becomes effective')).not.toBeInTheDocument();

    // Active matters is now wired to the same real `rails` array (previously
    // it rendered the MATTERS fixture unconditionally) — it shows BOTH rails,
    // including the one with no deadline, and none of the MATTERS fixture's
    // own titles leak through as if real.
    const activeMatters = screen.getByTestId('capiro-intel-active-matters');
    expect(
      within(activeMatters).getByText('Unmanned Systems Cyber Baseline; Proposed Rule'),
    ).toBeInTheDocument();
    expect(within(activeMatters).getByText('Rule with no comment deadline')).toBeInTheDocument();
    expect(screen.queryByText('Autonomous Vehicle Safety Framework')).not.toBeInTheDocument();
    expect(screen.queryByText('AI Assurance for Defense Systems')).not.toBeInTheDocument();
  });

  it('"Open matter" links to the real Federal Register document when the rail carries an htmlUrl, and renders nothing when it does not', async () => {
    mockAggregate({
      ...AGGREGATE_WITH_DEADLINES,
      sections: {
        legislativeRegulatory: {
          regulatoryLifecycle: {
            ...AGGREGATE_WITH_DEADLINES.sections.legislativeRegulatory.regulatoryLifecycle,
            rails: [
              {
                ...AGGREGATE_WITH_DEADLINES.sections.legislativeRegulatory.regulatoryLifecycle
                  .rails[0],
                htmlUrl: 'https://www.federalregister.gov/documents/2026/08/16/2026-17422',
              },
              AGGREGATE_WITH_DEADLINES.sections.legislativeRegulatory.regulatoryLifecycle.rails[1],
            ],
          },
        },
      },
    });
    renderWithRoutes();

    const activeMatters = await screen.findByTestId('capiro-intel-active-matters');
    const link = await within(activeMatters).findByRole('link', { name: 'Open matter →' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.federalregister.gov/documents/2026/08/16/2026-17422',
    );
    expect(link).toHaveAttribute('target', '_blank');
    // Only ONE link: the second rail has no htmlUrl and must render no
    // control at all rather than a button with nowhere to go.
    expect(within(activeMatters).getAllByRole('link', { name: 'Open matter →' })).toHaveLength(1);
  });

  it('does not render a dead "View all" control on Active matters', async () => {
    mockAggregate(AGGREGATE_WITH_DEADLINES);
    renderWithRoutes();

    const activeMattersCard = (await screen.findByTestId('capiro-intel-active-matters')).closest(
      'section',
    );
    expect(activeMattersCard).not.toBeNull();
    expect(
      within(activeMattersCard as HTMLElement).queryByText('View all'),
    ).not.toBeInTheDocument();
  });

  it('downloads an .ics built from the real deadlines', async () => {
    mockAggregate(AGGREGATE_WITH_DEADLINES);
    const blobs: Blob[] = [];
    const createUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob: Blob | MediaSource) => {
        blobs.push(blob as Blob);
        return 'blob:ics';
      });
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    renderWithRoutes();
    const deadlineRail = await screen.findByTestId('capiro-intel-deadline-rail');
    await waitFor(() =>
      expect(
        within(deadlineRail).getByText('Unmanned Systems Cyber Baseline; Proposed Rule'),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Calendar'));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    const ics = await readBlob(blobs[0]!);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART;VALUE=DATE:20270211');
    // RFC 5545 escaping: the ';' inside the rule title must be escaped, or the
    // line parses as a property parameter and the event breaks.
    expect(ics).toContain(
      'SUMMARY:Comment deadline · Unmanned Systems Cyber Baseline\\; Proposed Rule',
    );
    // One VEVENT — the deadline-less rail contributes nothing.
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);

    createUrl.mockRestore();
    revokeUrl.mockRestore();
    clickSpy.mockRestore();
  });

  it('disables Calendar rather than exporting the design fixture', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderWithRoutes();

    expect(screen.getByText('Loading regulatory matters…')).toBeInTheDocument();
    expect(screen.queryByText('Autonomous Vehicle Safety Framework')).not.toBeInTheDocument();
    expect(screen.getByText('Calendar')).toBeDisabled();
  });
});

describe('ClientCrmIntelligenceProto — Legislative & Regulatory (consolidated)', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('renders Legislative and Regulatory content together on the merged domain view', async () => {
    // Both the Legislative endpoints (feature flags, tracker board,
    // recommendations) and the Regulatory aggregate must answer on the same
    // screen now — this used to be two independently-mocked views.
    getMock.mockImplementation((url: string) => {
      if (url === '/intel-api/feature-flags') return Promise.resolve({ data: {} });
      if (url === '/api/intelligence/clients/client-1/tracker/board') {
        return Promise.resolve({ data: { total: 4, withheld: 0, columns: [] } });
      }
      if (url === '/api/intelligence/clients/client-1/tracker/recommendations') {
        return Promise.resolve({
          data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 },
        });
      }
      if (url === '/api/intelligence/clients/client-1/regulatory-profile') {
        return Promise.resolve({ data: regulatoryResponse(AGGREGATE_WITH_DEADLINES) });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    postMock.mockResolvedValue({ data: {} });
    renderWithRoutes();

    // Legislative content (tracked bills board) ...
    expect((await screen.findAllByText('Tracked bills')).length).toBeGreaterThan(0);
    // ...and Regulatory content (deadline rail) on the SAME screen, with no
    // second tab/view switch required — this used to be two separate
    // segmented-tab views. (The same real rail title also now renders in the
    // Active-matters card beside it, so this is asserted with getAllByText
    // rather than a single-match query.)
    expect(
      (await screen.findAllByText('Unmanned Systems Cyber Baseline; Proposed Rule')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Legislative & Regulatory' })).toBeInTheDocument();
    // No leftover standalone "Regulatory" domain heading/tab remains.
    expect(screen.queryByRole('heading', { name: 'Regulatory', level: 1 })).not.toBeInTheDocument();
  });
});

/**
 * Design-system reconciliation pass (styling + "never fabricate" fixes):
 * confirmed query errors must render an honest "could not be loaded" state,
 * never the design fixture that used to stand in for "not yet successful"
 * (a state that conflated loading with error). These pin the NEW behavior
 * for the panels that previously fell back to a fixture on error.
 */
describe('ClientCrmIntelligenceProto — honest error states (never a fixture on a confirmed error)', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('shows an honest error, not the BILLS/STAGES fixture, when the tracked-bill board request fails', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/intel-api/feature-flags') return Promise.resolve({ data: {} });
      if (url === '/api/intelligence/clients/client-1/tracker/board') {
        return Promise.reject(new Error('board service unavailable'));
      }
      if (url === '/api/intelligence/clients/client-1/tracker/recommendations') {
        return Promise.resolve({
          data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderLegislative();

    await waitFor(() =>
      expect(screen.getByText(/The tracked-bill board could not be loaded/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/board service unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The BILLS design fixture must never stand in for a confirmed error.
    expect(screen.queryByText('Autonomous Systems Readiness Act')).not.toBeInTheDocument();
    // The real "Open full board" navigation stays available regardless.
    expect(screen.getByText('Open full board →')).toBeInTheDocument();
  });

  it('shows an honest error, not the MATTERS fixture, when the regulatory aggregate request fails', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/intel-api/feature-flags') return Promise.resolve({ data: {} });
      if (url === '/api/intelligence/clients/client-1/tracker/board') {
        return Promise.resolve({ data: { total: 0, withheld: 0, columns: [] } });
      }
      if (url === '/api/intelligence/clients/client-1/tracker/recommendations') {
        return Promise.resolve({
          data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 },
        });
      }
      if (url === '/api/intelligence/clients/client-1/regulatory-profile') {
        return Promise.reject(new Error('aggregate service unavailable'));
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderWithRoutes();

    // `aggregate` sets an explicit retry: 1 on the query itself, which
    // overrides this test's QueryClient-level retry:false default — reaching
    // isError takes a real backoff delay, so the default 1000ms waitFor
    // window isn't enough.
    await waitFor(
      () =>
        expect(
          screen.getByText(/Active regulatory matters could not be loaded/),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(screen.getByText(/The deadline rail could not be loaded/)).toBeInTheDocument();
    // The MATTERS/DEADLINES design fixtures must never stand in for a confirmed error.
    expect(screen.queryByText('Autonomous Vehicle Safety Framework')).not.toBeInTheDocument();
    expect(screen.queryByText('Submit or approve comment strategy')).not.toBeInTheDocument();
    // Calendar can't export a fixture, and there is nothing real to export either.
    expect(screen.getByText('Calendar')).toBeDisabled();
  });

  it('shows an honest error, not the $1.8M/Sparkline or LDA-rows fixtures, when the LDA request fails', async () => {
    intelFlags.current = { tracker_v2: false, district_nexus_v2: true };
    getMock.mockImplementation((url: string) => {
      if (url === '/api/intelligence/clients/client-1/lda-filings') {
        return Promise.reject(new Error('lda service unavailable'));
      }
      if (url === '/api/intelligence/clients/client-1/district-nexus-v2')
        return Promise.resolve({ data: NEXUS_V2 });
      if (url === '/api/intelligence/clients/client-1/fec-money-flow')
        return Promise.resolve({ data: PAC_GIVING_REAL });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderFootprint();

    await waitFor(() =>
      expect(screen.getAllByText(/could not be loaded/).length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.getByText(/Lobbying activity could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText(/Lobbying disclosure history could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText('$1.8M')).not.toBeInTheDocument();
    expect(screen.queryByText('Northwest Government Affairs')).not.toBeInTheDocument();
    // The unrelated Federal awards card still renders its real data.
    expect(screen.getAllByText('$12.0M').length).toBeGreaterThan(0);
  });
});
describe('facility verification evidence', () => {
  it('separates a Census match, manual district and representative match in the actual card', async () => {
    mockDistrictApis({
      facilities: [
        {
          ...FACILITY,
          districtSource: 'user',
          stateHouseDistrict: 'WA',
          stateSenateDistrict: 'First Bristol and Plymouth',
        },
      ],
    });
    renderDistrict();
    expect(await screen.findByText('Geocoder: Matched')).toBeInTheDocument();
    expect(screen.getByText('U.S. House source: Manual')).toBeInTheDocument();
    expect(screen.getByText('State House: Not resolved')).toBeInTheDocument();
    expect(screen.getByText('State Senate: First Bristol and Plymouth')).toBeInTheDocument();
    expect(screen.getByText('Matches saved district')).toBeInTheDocument();
    expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs address verification')).not.toBeInTheDocument();
  });

  it('does not turn a state-only facility into a district or a confirmed representative', async () => {
    mockDistrictApis({
      facilities: [
        {
          ...FACILITY,
          congressionalDistrict: null,
          stateHouseDistrict: 'CA',
          stateSenateDistrict: 'FL',
        },
      ],
    });
    renderDistrict();
    expect(await screen.findByText('U.S. House: Not resolved')).toBeInTheDocument();
    expect(screen.getByText('U.S. House district missing')).toBeInTheDocument();
    expect(screen.queryByText('WA')).not.toBeInTheDocument();
  });

  it('flags mismatched and missing representative district values, including at-large null', () => {
    const resolved = REPRESENTATION[0]!.representation;
    if (resolved.unresolved) throw new Error('fixture must carry resolved representation');
    for (const district of [8, null]) {
      const representation = {
        ...resolved,
        federal: {
          house: { ...resolved.federal.house, district },
          senate: [],
        },
      };
      expect(facilityStatus(FACILITY as any, representation as any).label).toBe(
        'Representation mismatch',
      );
    }
    const atLarge = {
      ...resolved,
      federal: {
        house: { ...resolved.federal.house, state: 'AK', district: null },
        senate: [],
      },
    };
    expect(
      facilityStatus(
        { ...FACILITY, state: 'AK', congressionalDistrict: '00' } as any,
        atLarge as any,
      ).label,
    ).toBe('Representation mismatch');
  });

  it.each([
    ['FL', 'Florida', '08', 8],
    ['CA', 'California', '12', 12],
    ['WY', 'Wyoming', '00', 0],
    ['WA', ' washington ', '07', 7],
  ])(
    'compares postal state %s with the roster full name %s',
    (state, fullName, district, houseDistrict) => {
      const representation = {
        unresolved: false,
        federal: { house: { state: fullName, district: houseDistrict }, senate: [] },
        state: { lower: null, upper: null },
      };
      expect(
        facilityStatus(
          { ...FACILITY, state, congressionalDistrict: district } as any,
          representation as any,
        ).label,
      ).toBe('Matches saved district');
      expect(
        facilityStatus(
          { ...FACILITY, state: 'AZ', congressionalDistrict: '01' } as any,
          representation as any,
        ).label,
      ).toBe('Representation mismatch');
    },
  );
});
