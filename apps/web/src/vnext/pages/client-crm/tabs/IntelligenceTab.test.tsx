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

  /**
   * Federal Footprint reads three independent sources (LDA, district-nexus
   * spend, FEC). Each of the five domain-stats-strip cells maps to exactly
   * ONE source, so a slow/failed source must only blank ITS OWN cells — not
   * the other two sources' cells, which already have a real answer. This
   * used to require ALL THREE to succeed before showing anything.
   */
  it('fills in LDA- and awards-derived stats immediately even while FEC is still loading', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/api/intelligence/clients/client-1/lda-filings') return Promise.resolve({ data: LDA_FILINGS_REAL });
      if (url === '/api/intelligence/clients/client-1/district-nexus-spend') {
        return Promise.resolve({
          data: { linked: true, contractorNames: [], totalAwards: 3, totalAmount: 12_000_000, districtCount: 1, unmappedAmount: 0, districts: [], disclaimer: '' },
        });
      }
      if (url === '/api/intelligence/clients/client-1/fec-money-flow') return new Promise(() => {}); // never resolves
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderFootprint();

    // Wait on the awards VALUE, not its label: every label renders on the
    // first paint in the dash state, so awaiting the label would resolve
    // before the district-nexus query settles and assert against a cell that
    // is still legitimately loading.
    await screen.findByText('$12.0M');
    const awardsCell = screen.getByText('Federal awards · TTM');
    expect(within(awardsCell.closest('.capiro-intel-stats-cell') as HTMLElement).getByText('$12.0M')).toBeInTheDocument();

    const ldaCell = screen.getByText('LDA filings').closest('.capiro-intel-stats-cell');
    expect(within(ldaCell as HTMLElement).getByText('1')).toBeInTheDocument();

    // FEC never answered — its own cell stays an honest dash, not $0 and not blank.
    const pacCell = screen.getByText('PAC disbursements').closest('.capiro-intel-stats-cell');
    expect(within(pacCell as HTMLElement).getByText('—')).toBeInTheDocument();
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
    renderWithRoutes();

    const deadlineRail = await screen.findByTestId('capiro-intel-deadline-rail');
    await waitFor(() =>
      expect(within(deadlineRail).getByText('Unmanned Systems Cyber Baseline; Proposed Rule')).toBeInTheDocument(),
    );
    // A rail with no deadline is not a deadline — it must not appear on the
    // deadline rail specifically (it legitimately appears in Active matters
    // below, which lists every rail regardless of whether it has a deadline).
    expect(within(deadlineRail).queryByText('Rule with no comment deadline')).not.toBeInTheDocument();
    // The fixture's own deadlines must not leak through as if real.
    expect(screen.queryByText('Submit or approve comment strategy')).not.toBeInTheDocument();
    expect(screen.queryByText('Final rule becomes effective')).not.toBeInTheDocument();

    // Active matters is now wired to the same real `rails` array (previously
    // it rendered the MATTERS fixture unconditionally) — it shows BOTH rails,
    // including the one with no deadline, and none of the MATTERS fixture's
    // own titles leak through as if real.
    const activeMatters = screen.getByTestId('capiro-intel-active-matters');
    expect(within(activeMatters).getByText('Unmanned Systems Cyber Baseline; Proposed Rule')).toBeInTheDocument();
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
                ...AGGREGATE_WITH_DEADLINES.sections.legislativeRegulatory.regulatoryLifecycle.rails[0],
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
    expect(link).toHaveAttribute('href', 'https://www.federalregister.gov/documents/2026/08/16/2026-17422');
    expect(link).toHaveAttribute('target', '_blank');
    // Only ONE link: the second rail has no htmlUrl and must render no
    // control at all rather than a button with nowhere to go.
    expect(within(activeMatters).getAllByRole('link', { name: 'Open matter →' })).toHaveLength(1);
  });

  it('does not render a dead "View all" control on Active matters', async () => {
    mockAggregate(AGGREGATE_WITH_DEADLINES);
    renderWithRoutes();

    const activeMattersCard = (await screen.findByTestId('capiro-intel-active-matters')).closest('section');
    expect(activeMattersCard).not.toBeNull();
    expect(within(activeMattersCard as HTMLElement).queryByText('View all')).not.toBeInTheDocument();
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

    renderWithRoutes();
    const deadlineRail = await screen.findByTestId('capiro-intel-deadline-rail');
    await waitFor(() =>
      expect(within(deadlineRail).getByText('Unmanned Systems Cyber Baseline; Proposed Rule')).toBeInTheDocument(),
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
    renderWithRoutes();

    // The fixture is on screen for pixel review, but it must never become a
    // calendar file full of invented events.
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
        return Promise.resolve({ data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 } });
      }
      if (url === '/api/intelligence/clients/client-1/profile-v1') {
        return Promise.resolve({ data: AGGREGATE_WITH_DEADLINES });
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
    expect((await screen.findAllByText('Unmanned Systems Cyber Baseline; Proposed Rule')).length).toBeGreaterThan(0);
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
        return Promise.resolve({ data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 } });
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
        return Promise.resolve({ data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 } });
      }
      if (url === '/api/intelligence/clients/client-1/profile-v1') {
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
      () => expect(screen.getByText(/Active regulatory matters could not be loaded/)).toBeInTheDocument(),
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
    getMock.mockImplementation((url: string) => {
      if (url === '/api/intelligence/clients/client-1/lda-filings') {
        return Promise.reject(new Error('lda service unavailable'));
      }
      if (url === '/api/intelligence/clients/client-1/district-nexus-spend') {
        return Promise.resolve({
          data: { linked: true, contractorNames: [], totalAwards: 3, totalAmount: 12_000_000, districtCount: 1, unmappedAmount: 0, districts: [], disclaimer: '' },
        });
      }
      if (url === '/api/intelligence/clients/client-1/fec-money-flow') return Promise.resolve({ data: PAC_GIVING_REAL });
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
    expect(screen.getByText('$12,000,000')).toBeInTheDocument();
  });
});
