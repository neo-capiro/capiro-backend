import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmIntelligenceProto } from './IntelligenceTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
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

    expect(screen.getByTestId('location')).toHaveTextContent('/legiwatch');
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

const FACILITY = {
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

const REPRESENTATION = [
  {
    facility: { id: 'fac-1', name: 'Seattle HQ', city: 'Seattle', state: 'WA' },
    representation: {
      unresolved: false,
      federal: {
        house: { bioguideId: 'X000000', fullName: 'Rep. Jamie Rivera', party: 'D', state: 'WA', district: 7, chamber: 'House' },
        senate: [],
      },
      state: { lower: null, upper: null },
    },
  },
];

function mockDistrictApis(overrides: { facilities?: unknown; nexus?: unknown; representation?: unknown } = {}) {
  const facilities = overrides.facilities ?? [FACILITY];
  const nexus = overrides.nexus ?? NEXUS_LINKED;
  const representation = overrides.representation ?? REPRESENTATION;
  getMock.mockImplementation((url: string) => {
    if (url === '/api/clients/client-1/facilities') return Promise.resolve({ data: facilities });
    if (url === '/api/intelligence/clients/client-1/district-nexus-spend') return Promise.resolve({ data: nexus });
    if (url === '/api/clients/client-1/representation') return Promise.resolve({ data: representation });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('ClientCrmIntelligenceProto — district panel (items 1-2, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('binds the map, rail, and selected-district panel to real facilities/district-nexus/representation data', async () => {
    mockDistrictApis();
    renderDistrict();

    await waitFor(() => expect(screen.getByText('Rep. Jamie Rivera (Democrat) · House')).toBeInTheDocument());
    // Compact money is the app-wide convention (district-nexus-format).
    expect(screen.getAllByText('$12.0M').length).toBeGreaterThan(0);
    expect(screen.getAllByText('WA-07').length).toBeGreaterThan(0);

    // The design fixture's own facility/rep must not leak through as if real.
    expect(screen.queryByText('Seattle headquarters')).not.toBeInTheDocument();
    expect(screen.queryByText('Rep. Jane Doe · House · HASC')).not.toBeInTheDocument();
    expect(screen.queryByText('8 districts · 92% coverage')).not.toBeInTheDocument();
  });

  it('wires the facilities & representation table per-facility', async () => {
    mockDistrictApis();
    renderDistrict();

    await waitFor(() => expect(screen.getByText('Confirmed')).toBeInTheDocument());
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
});

function renderFunding() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmIntelligenceProto client={client} view="funding" />
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

const RELEVANT_PE = {
  peCode: '0602308A',
  title: 'Advanced Robotics Research',
  score: 0.82,
  paths: [{ path: 'capability_pe_direct', score: 0.82, evidence: ['Capability "Autonomy stack" lists PE 0602308A'] }],
};

const OPPORTUNITY_SUMMARY = {
  clientId: 'client-1',
  counts: { activeGrants: 2, activeContracts: 3, saved: 1, pursuing: 1, dismissed: 0, deadlinesIn30Days: 1 },
  nextDeadline: null,
  topGrants: [
    {
      id: 'opp-1',
      source: 'grants_gov',
      sourceUrl: 'https://grants.gov/opp-1',
      kind: 'grant',
      title: 'Autonomy Research Grant',
      agency: 'DARPA',
      responseDeadline: '2026-09-01T00:00:00.000Z',
      responseDeadlineNote: null,
      grantFunding: { estimatedProgramFunding: 2_000_000, awardFloor: null, awardCeiling: 2_400_000, expectedAwardCount: null, costSharingRequired: null },
      contractValue: null,
      relevanceScore: 87,
      workflow: { id: 'wf-1', status: 'pursuing', owner: null, facility: null, notes: null, dismissedReason: null, outcomeNote: null, userCreated: false, staleAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
    },
  ],
  topContracts: [],
  missingProfileFields: [],
  freshness: [],
  emptyReason: null,
  emptyExplanation: null,
  generatedAt: '2026-08-16T00:00:00.000Z',
};

function mockFundingApis(overrides: { pes?: unknown; flags?: unknown; opportunities?: unknown } = {}) {
  const pes = overrides.pes ?? { data: [RELEVANT_PE], total: 1, page: 1, limit: 12 };
  const flags = overrides.flags ?? { funding_opportunities: true };
  const opportunities = overrides.opportunities ?? OPPORTUNITY_SUMMARY;
  getMock.mockImplementation((url: string) => {
    if (url === '/api/intelligence/clients/client-1/pe-relevance') return Promise.resolve({ data: pes });
    if (url === '/intel-api/feature-flags') return Promise.resolve({ data: flags });
    if (url === '/api/intelligence/clients/client-1/opportunities/summary') return Promise.resolve({ data: opportunities });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('ClientCrmIntelligenceProto — funding panel (items 4-5, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('re-fetches the opportunities and PE-relevance sources when Sync sources is clicked', async () => {
    mockFundingApis();
    renderFunding();

    await waitFor(() => expect(screen.getByText('Advanced Robotics Research')).toBeInTheDocument());
    const callsBeforeSync = getMock.mock.calls.length;

    fireEvent.click(screen.getByText('Sync sources'));

    // A static button with no onClick did nothing on click; this asserts a
    // real re-read of the same sources the panel below already renders.
    await waitFor(() => expect(getMock.mock.calls.length).toBeGreaterThan(callsBeforeSync));
  });

  it('renders real relevant PEs and wires "Open PE" navigation using the real peCode (item 4)', async () => {
    mockFundingApis();
    renderFunding();

    await waitFor(() => expect(screen.getByText('Advanced Robotics Research')).toBeInTheDocument());
    expect(screen.getByText('82%')).toBeInTheDocument();
    // The fixture's own PE must not leak through as if real.
    expect(screen.queryByText('Ground Vehicle Autonomy Kit')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Open PE →'));
    expect(screen.getByTestId('location')).toHaveTextContent('/program-elements/0602308A');
  });

  it('wires the "Open budget" header link to the real Program Elements index (item 4)', async () => {
    mockFundingApis();
    renderFunding();

    await waitFor(() => expect(screen.getByText('Advanced Robotics Research')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Open budget'));
    expect(screen.getByTestId('location')).toHaveTextContent('/program-elements');
  });

  it('renders the real opportunities list when funding_opportunities is enabled (item 5)', async () => {
    mockFundingApis();
    renderFunding();

    await waitFor(() => expect(screen.getByText('Autonomy Research Grant')).toBeInTheDocument());
    // "Pursuing" also appears in the domain stats strip's own fixture cell.
    expect(screen.getAllByText('Pursuing').length).toBeGreaterThan(0);
    expect(screen.getByText('87% fit')).toBeInTheDocument();
    // The fixture's own opportunities must not leak through as if real.
    expect(screen.queryByText('Ground Robotics Autonomy Kit')).not.toBeInTheDocument();
  });

  it('keeps the opportunities design fixture when funding_opportunities is disabled for the tenant', async () => {
    mockFundingApis({ flags: {} });
    renderFunding();

    await waitFor(() => expect(screen.getByText('Advanced Robotics Research')).toBeInTheDocument());
    expect(screen.getByText('View all 7')).toBeInTheDocument();
    expect(screen.queryByText('Autonomy Research Grant')).not.toBeInTheDocument();
  });

  it('shows an honest empty message when no program element clears the relevance threshold', async () => {
    mockFundingApis({ pes: { data: [], total: 0, page: 1, limit: 12 } });
    renderFunding();

    await waitFor(() =>
      expect(
        screen.getByText('No program elements scored above the relevance threshold for this client.'),
      ).toBeInTheDocument(),
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
          { recipientName: 'WHITFIELD FOR CONGRESS', candidateName: 'Dana Whitfield', totalAmount: 60_000 },
          { recipientName: 'REYES FOR SENATE', candidateName: 'Luis Reyes', totalAmount: 30_000 },
        ],
      },
    ],
    summary: { totalAmount: 90_000, disbursementCount: 4, recipientCount: 2 },
  },
};

function mockFootprintApis(overrides: { lda?: unknown; nexus?: unknown; fec?: unknown } = {}) {
  const lda = overrides.lda ?? LDA_FILINGS_REAL;
  const nexus = overrides.nexus ?? {
    linked: true,
    contractorNames: ['Overland AI Inc'],
    totalAwards: 3,
    totalAmount: 12_000_000,
    districtCount: 1,
    unmappedAmount: 0,
    districts: [],
    disclaimer: 'Figures reflect confirmed contractor mappings only.',
  };
  const fec = overrides.fec ?? PAC_GIVING_REAL;
  getMock.mockImplementation((url: string) => {
    if (url === '/api/intelligence/clients/client-1/lda-filings') return Promise.resolve({ data: lda });
    if (url === '/api/intelligence/clients/client-1/district-nexus-spend') return Promise.resolve({ data: nexus });
    if (url === '/api/intelligence/clients/client-1/fec-money-flow') return Promise.resolve({ data: fec });
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

    await waitFor(() => expect(screen.getByText('$12,000,000')).toBeInTheDocument());
    expect(screen.getByText('3 awards')).toBeInTheDocument();

    fireEvent.click(screen.getByText('View awards'));
    expect(screen.getByTestId('location')).toHaveTextContent('/intelligence/federal-spending?tab=contracts&clientId=client-1');
  });

  it('keeps the design fixture on screen while footprint queries are loading or errored', () => {
    getMock.mockImplementation(() => new Promise(() => {}));
    renderFootprint();

    // "$1.8M"/"$84.2M" also appear in the domain stats strip's own fixture cells.
    expect(screen.getAllByText('$1.8M').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$84.2M').length).toBeGreaterThan(0);
    expect(screen.getByText('Northwest Government Affairs')).toBeInTheDocument();
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
      if (url === '/api/intelligence/clients/client-1/tracker/board') return Promise.resolve({ data: payload });
      if (url === '/api/intelligence/clients/client-1/tracker/recommendations') {
        return Promise.resolve({ data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  }

  it('renders real board bills, labelling probability as passage rather than fit', async () => {
    mockBoardApis();
    renderLegislative();

    await waitFor(() => expect(screen.getByText('Maritime Uncrewed Logistics Act')).toBeInTheDocument());
    expect(screen.getByText('H.R. 5150')).toBeInTheDocument();
    expect(screen.getByText('62% pass')).toBeInTheDocument();
    expect(screen.getByText('Referred to House Armed Services')).toBeInTheDocument();
    // The BILLS fixture must not leak through as if real.
    expect(screen.queryByText('Defense Autonomy Test Range Act')).not.toBeInTheDocument();
  });

  it('states withheld bills rather than silently bounding the board', async () => {
    mockBoardApis(BOARD, 7);
    renderLegislative();

    await waitFor(() => expect(screen.getByText('7 more tracked bills not shown')).toBeInTheDocument());
  });

  it('shows a real empty state when the board is genuinely empty', async () => {
    mockBoardApis({ columns: [], total: 0 });
    renderLegislative();

    await waitFor(() =>
      expect(screen.getByText((content, el) => el?.tagName === 'P' && /No bills are on this client/.test(content))).toBeInTheDocument(),
    );
  });
});

/* ═══════ wire-audit "3 Compose extend" items 4-5 ═════════════════════════ */

function renderWithRoutes(view: 'legislative' | 'regulatory') {
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

  it('opens the real tracker Configure panel scoped to this client', () => {
    mockLegislativeApis();
    renderWithRoutes('legislative');

    fireEvent.click(screen.getByText('Configure'));

    // ?tab=watchlist is the Configure panel on the canonical Radar page (NOT
    // /legiwatch — vNext's LegiWatch module treats `watchlist` as a removed
    // tab and silently redirects it to Hearings); ?client= scopes it, or the
    // panel lands on the client picker instead of this client.
    expect(screen.getByTestId('location')).toHaveTextContent('/radar?tab=watchlist&client=client-1');
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

function mockAggregate(data: unknown) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/intelligence/clients/client-1/profile-v1') return Promise.resolve({ data });
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
    renderWithRoutes('regulatory');

    await waitFor(() =>
      expect(screen.getByText('Unmanned Systems Cyber Baseline; Proposed Rule')).toBeInTheDocument(),
    );
    // A rail with no deadline is not a deadline — it must not appear on the rail.
    expect(screen.queryByText('Rule with no comment deadline')).not.toBeInTheDocument();
    // The fixture's own deadlines must not leak through as if real. Asserted on
    // the DEADLINES `ask` copy, not its titles: the titles are also in MATTERS,
    // which the Active matters card still renders as fixture on purpose, so a
    // title assertion would fail against a card this item never claimed.
    expect(screen.queryByText('Submit or approve comment strategy')).not.toBeInTheDocument();
    expect(screen.queryByText('Final rule becomes effective')).not.toBeInTheDocument();
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
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderWithRoutes('regulatory');
    await waitFor(() =>
      expect(screen.getByText('Unmanned Systems Cyber Baseline; Proposed Rule')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('Calendar'));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    const ics = await blobs[0]!.text();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART;VALUE=DATE:20270211');
    // RFC 5545 escaping: the ';' inside the rule title must be escaped, or the
    // line parses as a property parameter and the event breaks.
    expect(ics).toContain('SUMMARY:Comment deadline · Unmanned Systems Cyber Baseline\\; Proposed Rule');
    // One VEVENT — the deadline-less rail contributes nothing.
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);

    createUrl.mockRestore();
    revokeUrl.mockRestore();
    clickSpy.mockRestore();
  });

  it('disables Calendar rather than exporting the design fixture', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderWithRoutes('regulatory');

    // The fixture is on screen for pixel review, but it must never become a
    // calendar file full of invented events.
    expect(screen.getByText('Calendar')).toBeDisabled();
  });
});
