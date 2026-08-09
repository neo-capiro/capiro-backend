import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { FundingOpportunityDetail, FundingOpportunityDetailPage } from './FundingOpportunityDetail.js';
import { FundingOpportunityDrawer } from './FundingOpportunityDrawer.js';
import {
  decodeOpportunityRef,
  encodeOpportunityRef,
  opportunityDetailPath,
  type CatalogOpportunityRef,
  type ForecastOpportunityRecord,
  type FundingOpportunity,
  type OpportunityRef,
} from './funding-opportunities-api.js';

/**
 * The detail shell.
 *
 * Uses a REAL MemoryRouter rather than the module mock the list specs use: this
 * phase is about routing — a path with two params, a query string, browser Back,
 * and one body rendered inside two different frames — and a hand-rolled
 * `useSearchParams` double cannot exercise any of that.
 */

const { flags, apiGetMock } = vi.hoisted(() => ({
  flags: { funding_opportunities: true } as Record<string, boolean>,
  apiGetMock: vi.fn(),
}));

vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), patch: vi.fn() }),
}));

function setupBrowserMocks() {
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
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
}

function opportunity(partial: Partial<FundingOpportunity> = {}): FundingOpportunity {
  return {
    id: 'sam_gov:notice-1',
    source: 'sam_gov',
    sourceRecordId: 'notice-1',
    sourceReference: 'W911-26-R-0001',
    sourceUrl: 'https://sam.gov/opp/N-1/view',
    kind: 'solicitation',
    kindRaw: 'Solicitation',
    baseKind: 'presolicitation',
    recommendation: null,
    acquisitionPosition: null,
    decision: null,
    title: 'Turbofan Engine Sustainment',
    agency: 'Department of the Army',
    subAgency: null,
    office: null,
    status: 'active',
    postedDate: '2026-06-01T00:00:00.000Z',
    responseDeadline: new Date(Date.now() + 12 * 86_400_000).toISOString(),
    responseDeadlineNote: null,
    closeOrArchiveDate: null,
    isActive: true,
    isPursuable: true,
    summary: 'Sustainment of turbofan engines.',
    summaryIsLink: false,
    naicsCodes: ['336411'],
    pscCodes: [],
    setAside: null,
    setAsideCode: null,
    eligibleApplicantTypes: [],
    assistanceListings: [],
    fundingInstrument: null,
    category: null,
    grantFunding: null,
    contractValue: { estimatedValue: null, basis: 'not_stated_by_source' },
    placeOfPerformance: null,
    districtKey: null,
    districtBasis: null,
    relevanceScore: 62,
    eligibility: {
      state: 'unknown',
      reason: 'This notice records no set-aside in the fields Capiro holds.',
    },
    matchedSignals: [{ signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '336411' }],
    missingProfileFields: [],
    sourceUpdatedAt: '2026-07-20T00:00:00.000Z',
    workflow: null,
    clientId: 'client-1',
    ...partial,
  };
}

let detail: FundingOpportunity | Error = opportunity();
let requestedUrls: string[] = [];

function notFoundError() {
  const error = new Error('Request failed with status code 404') as Error & {
    response: { status: number };
  };
  error.response = { status: 404 };
  return error;
}

/**
 * The forecast read's own payload (P26).
 *
 * A separate fixture from `opportunity()`, because the two records are
 * DIFFERENT SHAPES — that is the whole reason the forecast has its own route and
 * its own body. Serving one from the other's fixture is exactly the conflation
 * the split exists to prevent.
 */
function forecastRecord(): ForecastOpportunityRecord {
  return {
    source: 'agency_forecast',
    sourceRecordId: 'FCST-1',
    externalId: 'APFS-9001',
    title: 'Depot-level turbofan sustainment',
    description: null,
    agency: 'Department of the Navy',
    departmentName: null,
    organizationAgencyName: null,
    officeName: null,
    facts: {
      anticipatedAwardDate: '2027-03-01',
      anticipatedSolicitationDate: null,
      estimatedPeriod: null,
      fiscalYear: 2027,
      sourceSystem: 'APFS',
      status: 'Forecasted',
      isActive: true,
      lastSyncedAt: '2026-08-06T02:00:00.000Z',
      providerModifiedAt: null,
    },
    naicsCode: '336412',
    pscCode: null,
    setAside: null,
    contractVehicle: null,
    placeOfPerformance: null,
    primaryContact: null,
    sourceUrl: null,
    recommendation: null,
    clientId: 'client-1',
    decision: null,
    workflow: null,
    linkedOpportunity: null,
    missingProfileFields: [],
    generatedAt: '2026-08-07T12:00:00.000Z',
  };
}

function mockApi() {
  apiGetMock.mockImplementation(async (url: string) => {
    requestedUrls.push(url);
    if (url.includes('/opportunities/forecasts/')) return { data: forecastRecord() };
    if (detail instanceof Error) throw detail;
    return { data: detail };
  });
}

/**
 * A CATALOG ref, which is what `FundingOpportunityDetail` takes (P26).
 *
 * The wider `OpportunityRef` now admits `agency_forecast`, and a forecast is a
 * different record shape rendered by a different body — so the compiler, not a
 * comment, keeps a forecast ref out of this component.
 */
const REF: CatalogOpportunityRef = {
  source: 'sam_gov',
  sourceRecordId: 'notice-1',
  clientId: 'client-1',
};

function wrap(children: React.ReactNode, initialEntries: string[] = ['/']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

/** Mounts the real route so the path params come from the router, not from props. */
function renderRoute(path: string) {
  return wrap(
    <Routes>
      <Route
        path="/intelligence/opportunities/:source/:sourceRecordId"
        element={<FundingOpportunityDetailPage />}
      />
      <Route path="/intelligence/opportunities" element={<div data-testid="fo-list">list</div>} />
    </Routes>,
    [path],
  );
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  flags.funding_opportunities = true;
  // P26. Off by default, matching every real tenant — a forecast test turns it on
  // explicitly, so no existing assertion can start depending on it silently.
  flags.funding_opportunities_forecasts = false;
  detail = opportunity();
  requestedUrls = [];
  mockApi();
});

describe('the ref is the identity, and it round-trips', () => {
  test('a ref encodes and decodes back to itself', () => {
    expect(decodeOpportunityRef(encodeOpportunityRef(REF))).toEqual(REF);
  });

  test('a source record id containing a separator survives the round trip', () => {
    // Grants.gov opportunity numbers are free-form source strings. A colon in one
    // would split the ref into the wrong pieces if the parts were not encoded —
    // the kind of bug that only appears on the one record that has the character.
    const awkward: CatalogOpportunityRef = {
      source: 'grants_gov',
      sourceRecordId: 'DE-FOA:0001/A B',
      clientId: 'client-1',
    };
    expect(decodeOpportunityRef(encodeOpportunityRef(awkward))).toEqual(awkward);
  });

  test('an unscoped ref round-trips with a null client', () => {
    const unscoped: CatalogOpportunityRef = {
      source: 'sam_gov',
      sourceRecordId: 'notice-1',
      clientId: null,
    };
    expect(decodeOpportunityRef(encodeOpportunityRef(unscoped))).toEqual(unscoped);
  });

  test.each([
    ['', 'empty'],
    ['sam_gov', 'too few parts'],
    ['sam_gov:notice-1', 'still too few'],
    ['sam_gov:notice-1:client:extra', 'too many parts'],
    ['fpds:notice-1:client-1', 'unknown source'],
    ['sam_gov::client-1', 'no record id'],
  ])('a malformed ref (%s — %s) decodes to null rather than throwing', (raw) => {
    expect(decodeOpportunityRef(raw)).toBeNull();
  });

  test('the full-page path carries the client, because the detail is about the pair', () => {
    expect(opportunityDetailPath(REF)).toBe(
      '/intelligence/opportunities/sam_gov/notice-1?clientId=client-1',
    );
  });

  test('an unscoped path omits the client rather than sending an empty one', () => {
    expect(opportunityDetailPath({ ...REF, clientId: null })).toBe(
      '/intelligence/opportunities/sam_gov/notice-1',
    );
  });
});

describe('all eight sections exist from this phase onwards', () => {
  test.each([
    ['fo-detail-assessment', 'Executive assessment'],
    ['fo-detail-fit', 'Fit and eligibility'],
    ['fo-detail-acquisition', 'Acquisition position'],
    ['fo-detail-landscape', 'Government landscape'],
    ['fo-detail-pursuit', 'Pursuit plan'],
    ['fo-detail-timeline', 'Timeline'],
    ['fo-detail-requirements', 'Requirements'],
    ['fo-detail-source', 'Source record'],
  ])('%s renders', async (testId, title) => {
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId(testId);
    expect(section).toHaveTextContent(title);
  });

  test('a section with no data yet SAYS it has none — it never renders blank', async () => {
    // Every one of the eight is real now: P23 acquisition position, P28 notice
    // history, P31 requirements and P33 landscape all replaced their
    // PendingSection with a panel that states WHY it is empty. Each owns its
    // own coverage in its own suite; what this test still holds is the shape
    // that made the placeholders honest — with the capability off, the section
    // says so and explicitly says it means nothing about the opportunity.
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const landscape = await screen.findByTestId('fo-detail-landscape');
    expect(landscape).toHaveTextContent(/not enabled for this workspace/i);
    expect(landscape).toHaveTextContent(/says nothing about what context exists/i);
    expect(landscape.textContent ?? '').not.toMatch(/no context|none exists/i);
  });

  test('an absent acquisition position never reads as "cannot bid"', async () => {
    // Absence of provider evidence is unknown, not a negative determination, and it
    // is not the same question as legal eligibility. This fixture's opportunity has
    // no acquisitionPosition (the mocked flag-off/unbuilt shape), so the panel falls
    // through to its own "not yet available" copy — never a bid determination.
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId('fo-detail-acquisition');
    expect(section.textContent ?? '').not.toMatch(/cannot bid|not eligible|no access/i);
    expect(section).toHaveTextContent(/not yet available/i);
  });

  test('an empty requirements panel does not imply the solicitation has none (P31)', async () => {
    wrap(<FundingOpportunityDetail refValue={REF} />);
    // P31 replaced the placeholder with the real panel. With the documents flag
    // off — the default in this suite and for every real tenant — it says the
    // CAPABILITY is off and, explicitly, that this says nothing about what the
    // solicitation requires. Four kinds of empty, and this is not the one that
    // is a fact about the solicitation.
    const section = await screen.findByTestId('fo-detail-requirements');
    expect(section).toHaveTextContent(/Document analysis is not enabled/i);
    expect(section).toHaveTextContent(/says nothing about what this solicitation requires/i);
    expect(section).not.toHaveTextContent(/no requirements/i);
  });

  test('a source field the source did not provide says "Not provided", not "Not yet available"', async () => {
    // Two different facts. "Not provided" is about the SOURCE; "Not yet available"
    // is about Capiro. Collapsing them blames the wrong party.
    detail = opportunity({ setAside: null, status: null, pscCodes: [] });
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId('fo-detail-source');
    expect(within(section).getAllByText('Not provided').length).toBeGreaterThan(0);
  });
});

describe('the record is rendered honestly', () => {
  test('provenance and the source URL are preserved', async () => {
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId('fo-detail-source');
    expect(section).toHaveTextContent('notice-1');
    expect(section).toHaveTextContent('W911-26-R-0001');
    expect(within(section).getByRole('link', { name: /sam\.gov/ })).toHaveAttribute(
      'href',
      'https://sam.gov/opp/N-1/view',
    );
  });

  test('a SAM notice with no stated value shows "Not stated", never $0', async () => {
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId('fo-detail-source');
    expect(section).toHaveTextContent('Not stated');
    expect(section.textContent ?? '').not.toContain('$0');
  });

  test('fit and eligibility stay two separate facts', async () => {
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId('fo-detail-fit');
    expect(section).toHaveTextContent('Fit');
    expect(section).toHaveTextContent('Eligibility');
    expect(section).toHaveTextContent('Unknown');
    expect(section).toHaveTextContent('Strong fit');
  });

  test('no matching signals reads as absence of evidence, not as a poor fit', async () => {
    detail = opportunity({ matchedSignals: [] });
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId('fo-detail-fit');
    expect(section).toHaveTextContent(/absence of evidence, not evidence of a poor fit/i);
  });

  test('confidence is labelled as evidence quality, never as a win probability', async () => {
    detail = opportunity({
      recommendation: {
        machineRecommendation: 'pass',
        recommendationConfidence: 'high',
        primaryReason: 'The client is barred by the set-aside.',
        primaryRisk: null,
        recommendedNextAction: 'No action.',
        reasonCodes: ['set_aside_ineligible'],
      },
    });
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId('fo-detail-assessment');
    expect(section).toHaveTextContent('Confidence: high');
    expect(section.textContent ?? '').not.toMatch(/win|probability|%/i);
  });

  test('decision, workflow stage and owner are three separate facts', async () => {
    detail = opportunity({
      decision: {
        decision: 'monitor',
        reason: 'Waiting for the amendment.',
        decidedAt: '2026-08-01T00:00:00.000Z',
        decidedByUserId: 'user-1',
        nextAction: 'Recheck after the amendment posts.',
        nextActionDueAt: '2026-08-20T00:00:00.000Z',
      },
      workflow: {
        id: 'wf-1',
        status: 'saved',
        owner: { userId: 'user-1', name: 'Ada Byron', email: 'ada@example.com' },
        facility: null,
        notes: null,
        dismissedReason: null,
        outcomeNote: null,
        userCreated: true,
        staleAt: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const section = await screen.findByTestId('fo-detail-pursuit');
    expect(section).toHaveTextContent('monitor');
    expect(section).toHaveTextContent('Saved');
    expect(section).toHaveTextContent('Ada Byron');
    expect(section).toHaveTextContent('Recheck after the amendment posts.');
  });

  test('with no client, the page says the scored fields are not calculated', async () => {
    wrap(<FundingOpportunityDetail refValue={{ ...REF, clientId: null }} />);
    expect(await screen.findByTestId('fo-detail-unscored')).toHaveTextContent(
      /No client is selected/i,
    );
  });
});

describe('it calls exactly one endpoint, and no future one', () => {
  test('the request carries the source, the record and the client', async () => {
    wrap(<FundingOpportunityDetail refValue={REF} />);
    await screen.findByTestId('fo-detail');
    expect(requestedUrls).toEqual([
      '/api/intelligence/opportunities/sam_gov/notice-1?clientId=client-1',
    ]);
  });

  test('no Tango endpoint is called', async () => {
    // P12 is a shell. Every provider surface it reserves space for arrives later,
    // and calling one now would make the shell depend on a phase that does not exist.
    wrap(<FundingOpportunityDetail refValue={REF} />);
    await screen.findByTestId('fo-detail');
    for (const url of requestedUrls) {
      expect(url).not.toMatch(/tango|makegov|forecast|vehicle|entit(y|ies)|attachment/i);
    }
  });

  test('an unscoped ref omits clientId rather than sending an empty one', async () => {
    wrap(<FundingOpportunityDetail refValue={{ ...REF, clientId: null }} />);
    await screen.findByTestId('fo-detail');
    expect(requestedUrls[0]).toBe('/api/intelligence/opportunities/sam_gov/notice-1');
  });
});

describe('bad input is a named state, not a blank page', () => {
  test('a 404 says the record does not exist and offers no retry', async () => {
    detail = notFoundError();
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const el = await screen.findByTestId('fo-detail-not-found');
    expect(el).toHaveTextContent(/No such opportunity/i);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  test('a transport failure is NOT reported as not-found', async () => {
    // "Not found" on a network blip would tell somebody a live solicitation had
    // been withdrawn.
    detail = new Error('network down');
    wrap(<FundingOpportunityDetail refValue={REF} />);
    const el = await screen.findByTestId('fo-detail-error');
    expect(el).toHaveTextContent(/request failure, not an empty record/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('an unknown source in the URL is refused before any request is made', async () => {
    renderRoute('/intelligence/opportunities/fpds/notice-1');
    expect(await screen.findByTestId('fo-detail-bad-ref')).toHaveTextContent(
      /not a source Capiro holds/i,
    );
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});

describe('the same route serves agency forecasts, as a different record type (P26)', () => {
  test('a forecast deep link renders the FORECAST body and hits the forecast route', async () => {
    flags.funding_opportunities_forecasts = true;
    renderRoute('/intelligence/opportunities/agency_forecast/FCST-1?clientId=client-1');
    await screen.findByTestId('fo-forecast-detail');
    // A different endpoint, because a forecast is a different record shape — not
    // `opportunities/:source/:id`, which would have to invent a deadline, an
    // eligibility state and a money figure the provider never states.
    expect(requestedUrls[0]).toBe(
      '/api/intelligence/opportunities/forecasts/FCST-1?clientId=client-1',
    );
    // And the opportunity body is NOT rendered alongside it.
    expect(screen.queryByTestId('fo-detail')).not.toBeInTheDocument();
  });

  test('with the forecast flag OFF the link says the CAPABILITY is off, not that the record is missing', async () => {
    // Two different facts, and only one of them is about the forecast. The API's
    // own forecast guard 404s with the flag off, so rendering the body first
    // would show "No such agency forecast" for a record that exists.
    flags.funding_opportunities_forecasts = false;
    renderRoute('/intelligence/opportunities/agency_forecast/FCST-1?clientId=client-1');
    const el = await screen.findByTestId('fo-forecast-not-enabled');
    expect(el).toHaveTextContent(/Agency forecasts are not enabled for this workspace/i);
    expect(el).toHaveTextContent(/says nothing about whether the forecast exists/i);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('the master flag still gates the forecast route, before the forecast flag is consulted', async () => {
    flags.funding_opportunities = false;
    flags.funding_opportunities_forecasts = true;
    renderRoute('/intelligence/opportunities/agency_forecast/FCST-1');
    expect(
      await screen.findByText(/Funding Opportunities is not enabled for this workspace/i),
    ).toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('the bad-ref message names all five rails the route accepts', async () => {
    renderRoute('/intelligence/opportunities/fpds/notice-1');
    expect(await screen.findByTestId('fo-detail-bad-ref')).toHaveTextContent(
      /grants_gov, sam_gov, agency_forecast, dibbs and sbir_sttr/,
    );
  });

  test('an sbir_sttr link says the DETAIL PAGE is missing, never that the source is unknown', async () => {
    renderRoute('/intelligence/opportunities/sbir_sttr/TOPIC-9001');
    const panel = await screen.findByTestId('fo-sbir-no-detail');
    expect(panel).toHaveTextContent('do not have a detail page yet');
    expect(screen.queryByTestId('fo-detail-bad-ref')).not.toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  /**
   * P41. `dibbs` is a legal inbox source, so this route WILL be reached with one
   * — and the malformed-URL branch above would have told the reader that “dibbs”
   * is not a source Capiro holds, which is false about Capiro's own data. The
   * two errors send a reader to different places: "no such source" to a broken
   * import, "no detail page yet" back to the queue where the item actually is.
   */
  test('a dibbs link says the DETAIL PAGE is missing, never that the source is unknown', async () => {
    renderRoute('/intelligence/opportunities/dibbs/SPE4A625T1234');
    const panel = await screen.findByTestId('fo-dibbs-no-detail');
    expect(panel).toHaveTextContent('do not have a detail page yet');
    expect(panel).toHaveTextContent('says nothing about whether the item exists');
    expect(screen.queryByTestId('fo-detail-bad-ref')).not.toBeInTheDocument();
    // A rail with no detail body has nothing to ask the API about.
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});

describe('the route is deep-linkable', () => {
  test('the path params and clientId drive the request', async () => {
    renderRoute('/intelligence/opportunities/sam_gov/notice-1?clientId=client-1');
    await screen.findByTestId('fo-detail');
    expect(requestedUrls[0]).toBe(
      '/api/intelligence/opportunities/sam_gov/notice-1?clientId=client-1',
    );
  });

  test('an encoded record id is decoded by the router and re-encoded for the API', async () => {
    renderRoute('/intelligence/opportunities/grants_gov/DE-FOA%3A0001?clientId=client-1');
    await screen.findByTestId('fo-detail');
    expect(requestedUrls[0]).toBe(
      '/api/intelligence/opportunities/grants_gov/DE-FOA%3A0001?clientId=client-1',
    );
  });

  test('an un-flagged tenant gets the availability message, not the record', async () => {
    flags.funding_opportunities = false;
    renderRoute('/intelligence/opportunities/sam_gov/notice-1');
    expect(
      await screen.findByText(/Funding Opportunities is not enabled for this workspace/i),
    ).toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('the back control returns to the list', async () => {
    renderRoute('/intelligence/opportunities/sam_gov/notice-1?clientId=client-1');
    fireEvent.click(await screen.findByRole('button', { name: /Funding Opportunities/ }));
    expect(await screen.findByTestId('fo-list')).toBeInTheDocument();
  });
});

describe('the drawer and the page render the SAME body', () => {
  function DrawerHarness({ initial }: { initial: OpportunityRef | null }) {
    return <FundingOpportunityDrawer refValue={initial} onClose={onCloseMock} />;
  }
  const onCloseMock = vi.fn();

  beforeEach(() => onCloseMock.mockClear());

  test('the drawer renders the identical section set', async () => {
    wrap(<DrawerHarness initial={REF} />);
    for (const testId of [
      'fo-detail-assessment',
      'fo-detail-fit',
      'fo-detail-acquisition',
      'fo-detail-landscape',
      'fo-detail-pursuit',
      'fo-detail-timeline',
      'fo-detail-requirements',
      'fo-detail-source',
    ]) {
      expect(await screen.findByTestId(testId)).toBeInTheDocument();
    }
  });

  test('a null ref renders nothing at all', () => {
    wrap(<DrawerHarness initial={null} />);
    expect(screen.queryByTestId('fo-detail')).not.toBeInTheDocument();
  });

  test('Escape closes it through the same handler a mask click uses', async () => {
    wrap(<DrawerHarness initial={REF} />);
    await screen.findByTestId('fo-detail');
    // Fired on the panel, which is where rc-drawer attaches its key handler. Both
    // Escape and the mask route through `onClose`, so the URL is cleared by one
    // path and the drawer cannot end up open with no ref (or closed with one).
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', code: 'Escape', keyCode: 27 });
    await waitFor(() => expect(onCloseMock).toHaveBeenCalled());
  });

  test('the close button closes it', async () => {
    wrap(<DrawerHarness initial={REF} />);
    fireEvent.click(await screen.findByRole('button', { name: /close/i }));
    await waitFor(() => expect(onCloseMock).toHaveBeenCalled());
  });

  test('it offers the full page at its own URL', async () => {
    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
    }
    wrap(
      <>
        <DrawerHarness initial={REF} />
        <LocationProbe />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open full page' }));
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent(
        '/intelligence/opportunities/sam_gov/notice-1?clientId=client-1',
      ),
    );
  });

  test('every control lives inside the dialog, so keyboard focus stays in it', async () => {
    // Asserts what a keyboard user actually needs: the dismiss and navigate
    // controls are INSIDE the dialog element, so Tab cycles within the drawer
    // rather than through the list sitting behind the mask, and focus placed on
    // one of them is focus inside the drawer.
    //
    // Deliberately not asserting `document.activeElement` right after open: that
    // measures whether rc-motion's enter transition has run under jsdom, which is
    // a fact about the animation library rather than about this component.
    // Dismissal itself is covered by the Escape and close-button tests above.
    wrap(<DrawerHarness initial={REF} />);
    const panel = await screen.findByRole('dialog');
    const close = within(panel).getByRole('button', { name: /close/i });
    expect(within(panel).getByRole('button', { name: 'Open full page' })).toBeInTheDocument();
    close.focus();
    expect(document.activeElement).toBe(close);
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  test('below the md breakpoint the drawer is FULL width, not a sliver under a mask', () => {
    // setupBrowserMocks answers every media query with matches:false, which is what
    // AntD's breakpoint hook reads as "narrower than md". A fixed 720px drawer on a
    // 375px phone renders as a strip of content the reader cannot use.
    wrap(<DrawerHarness initial={REF} />);
    const wrapper = document.querySelector('.ant-drawer-content-wrapper') as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.style.width).toBe('100%');
  });
});
