/**
 * PeProfileVNext — behavior tests for the native vNext line profile.
 *
 * Ported from the canonical V2 profile's assertions where they carry meaning
 * (real derived money values, stage labels, missing-≠-zero state words, load /
 * failure states, watch + data-issue endpoints). Mock values deliberately use
 * DISTINGUISHING figures (215.3 / 310.5 → +44.2%) so a fixture-echo can never
 * pass vacuously.
 *
 * The component is mounted WITHOUT a param route — VNextRouter mounts above
 * the canonical param <Route>s, so the PE code must come from the pathname
 * (Phase 3 lesson #2); the first test proves exactly that.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PeProfileVNext } from './PeProfileVNext.js';
import type { ProgramElementDetail } from '../../../../pages/program-element/types.js';
import type { ProgramElementSourceItem } from '../../../../pages/program-element/types.js';

const apiGet = vi.fn();
const apiPost = vi.fn();
let tenantSlug = 'capiro-internal';
let sourceItems: ProgramElementSourceItem[] = [];
let sourcesFail = false;
let dossierMode: 'empty'|'pending'|'error'|'fields' = 'empty';
let dossierFailRefresh = false;
let profileClient: QueryClient;
const fieldNames=['mission','plans','accomplishments','strategy_alignment','performance_measures','related_program_funding','remarks','analyst_questions'];
const dossier={subject:{type:'program_element',id:'0601102A',label:'Defense Research Sciences'},projectionVersion:'defense-dossier-v1',fields:fieldNames.map((field,index)=>({field,value:'Actual '+field,availability:index===0?'available':'partial',reason:index===0?'Field-bound evidence accepted':'canonical_value_field_provenance_unavailable',fiscalPeriod:null,metric:null,unit:null,evidence:[{evidenceRefId:'ref-'+field,sourceDocumentId:'doc-'+field,sourceRevisionId:'rev-'+field,sourceFamily:'budget',publisher:'Qualified publisher',sourceUrl:'https://example.gov/'+field,nativeLocator:{page:index+1,section:'Section '+field,occurrenceId:'occ-'+field},contentHash:'hash-'+field,edition:null,observedAt:null,availability:'partial',reason:'Context only'}]})),coverage:{state:'partial',reason:'Field-specific provenance is partial.',expectedFields:8,availableFields:1,partialFields:7,unavailableFields:0}};

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet, post: apiPost }),
}));

vi.mock('../../../../lib/me.js', () => ({
  useMe: () => ({ data: { tenant: { slug: tenantSlug } }, isLoading: false }),
}));

const DETAIL: ProgramElementDetail = {
  peCode: '0601102A',
  title: 'Defense Research Sciences',
  description: 'Basic research program.',
  service: 'ARMY',
  budgetActivity: '6.1 Basic Research',
  appropriationType: 'RDT&E',
  status: 'active',
  firstSeenFy: 2019,
  lastSyncedAt: '2026-08-01T00:00:00.000Z',
  currentUserIsWatching: false,
  years: [
    {
      id: 'y-2026',
      fy: 2026,
      request: 200,
      conference: null,
      enacted: 250,
    },
    {
      id: 'y-2027',
      fy: 2027,
      request: 215.3,
      hacDMark: 310.5,
      conference: null,
      enacted: null,
    },
  ],
  projectCount: 1,
  sourceCount: 3,
  billCount: 2,
  currentCycleFy: 2027,
  fundingSummary: null,
  openReconciliationConflictCount: 0,
  unsupportedSourceFamily: false,
};

function mockEndpoints(detail: ProgramElementDetail | (() => Promise<never>) = DETAIL) {
  apiGet.mockImplementation(async (url: string) => {
    if (url === '/api/defense-budget/dossiers/program_element/0601102A') {
      if(dossierMode==='pending') return new Promise(()=>{});
      if(dossierMode==='error'||dossierFailRefresh) throw Error('dossier down');
      return {data:dossierMode==='fields'?dossier:{...dossier,fields:[],coverage:{state:'unavailable',expectedFields:8,availableFields:0,partialFields:0,unavailableFields:8}}};
    }
    if (url === '/api/program-elements/0601102A') {
      if (typeof detail === 'function') return detail();
      return { data: detail };
    }
    if (url === '/api/program-elements/0601102A/sources') {
      if (sourcesFail) throw new Error('source service unavailable');
      return { data: sourceItems };
    }
    if (url.includes('/deltas')) return { data: { data: [], total: 0, page: 1, limit: 25 } };
    if (url === '/api/intelligence/actions')
      return { data: { data: [], total: 0, page: 1, limit: 100 } };
    if (url.includes('/client-relevance')) return { data: [] };
    return { data: [] };
  });
  apiPost.mockResolvedValue({ data: { id: 'issue-abcdef1234', status: 'open' } });
}

function LocationProbe() {
  const location = useLocation(); const navigate=useNavigate();
  return <><div data-testid="location-probe">{`${location.pathname}${location.search}`}</div><button onClick={()=>navigate('?tab=funding')}>URL funding</button><button onClick={()=>navigate(-1)}>History back</button><button onClick={()=>navigate(1)}>History forward</button></>;
}

function renderProfile(initialEntry = '/program-elements/0601102A', peCodeOverride?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  profileClient=queryClient;
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <PeProfileVNext peCode={peCodeOverride} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PeProfileVNext', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    tenantSlug = 'capiro-internal';
    sourceItems = [];
    sourcesFail = false;
    dossierMode='empty';dossierFailRefresh=false;
  });

  test('parses the PE code from the pathname (useParams is empty under VNextRouter) and renders real derived figures', async () => {
    mockEndpoints();
    renderProfile('/program-elements/0601102A');

    // Detail fetched with the canonical uppercase code parsed from the path.
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/program-elements/0601102A'));

    expect(await screen.findByText('Defense Research Sciences')).toBeInTheDocument();
    expect(screen.getByText('0601102A')).toBeInTheDocument();
    // Header meta: appropriation, friendly service label, budget activity.
    expect(screen.getByText('RDT&E, Army · 6.1 Basic Research')).toBeInTheDocument();
    // Current = furthest-along FY27 stage (HAC-D 310.5), NOT the FY26 enacted.
    // (The figure also labels the FY27 bar; the stage also appears in WHAT CHANGED.)
    expect(screen.getAllByText('$310.5M').length).toBeGreaterThan(0);
    expect(screen.getAllByText('HAC-D').length).toBeGreaterThan(0);
    // Delta sentence derives from current − request: +95.2 / 215.3 = +44.2%.
    expect(screen.getByText('+$95.2M · +44.2% vs FY2027 request')).toBeInTheDocument();
    // Trust strip facts.
    expect(screen.getByText('3 verified sources')).toBeInTheDocument();
    expect(screen.getByText('No blocking conflicts')).toBeInTheDocument();
    // Overview tab is the default and renders the FY bar chart with real bars.
    expect(
      screen.getByRole('img', { name: 'Funding by fiscal year bar chart' }),
    ).toBeInTheDocument();
    // FY26 enacted bar (250) + FY27 current bar (310.5): both money labels present.
    expect(screen.getByText('$250.0M')).toBeInTheDocument();
  });

  test('deep link ?tab=funding selects the Funding tab and renders the stage ladders with missing-≠-zero words', async () => {
    mockEndpoints();
    renderProfile('/program-elements/0601102A?tab=funding');

    await screen.findByText('Defense Research Sciences');

    const fundingTab = screen.getByRole('tab', { name: 'Funding & lifecycle' });
    expect(fundingTab).toHaveAttribute('aria-selected', 'true');

    // Both parallel tracks render.
    expect(await screen.findByText('AUTHORIZATION')).toBeInTheDocument();
    expect(screen.getByText('APPROPRIATIONS')).toBeInTheDocument();
    // The absent enacted stage says NOT ENACTED — never a coerced zero.
    expect(screen.getAllByText('NOT ENACTED').length).toBeGreaterThan(0);
    // Unfiled marks say NOT FILED (auth track has none filed beyond request).
    expect(screen.getAllByText(/NOT FILED/).length).toBeGreaterThan(0);
    // HAC-D carries the real filed value and its delta vs request.
    expect(screen.getAllByText('+$95.2M vs request').length).toBeGreaterThan(0);
    // The current stage is badged on the ladder.
    expect(screen.getAllByText('CURRENT').length).toBeGreaterThan(0);
  });

  test('switching tabs updates the ?tab= URL param (replace) like the canonical page', async () => {
    mockEndpoints();
    renderProfile('/program-elements/0601102A');

    await screen.findByText('Defense Research Sciences');
    fireEvent.click(screen.getByRole('tab', { name: 'Sources & proof' }));

    expect(screen.getByTestId('location-probe')).toHaveTextContent(
      '/program-elements/0601102A?tab=sources',
    );
    expect(await screen.findByText(/evidence coverage/)).toBeInTheDocument();
    expect(
      screen.getByText('MISSING IS NEVER ZERO · EVERY CELL STATES WHAT EXISTS'),
    ).toBeInTheDocument();

    // Back to Overview clears the param (canonical behavior).
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.getByTestId('location-probe')).toHaveTextContent(/\/program-elements\/0601102A$/);
  });

  test('external tenants do not call the internal lifecycle coverage endpoint from Sources & proof', async () => {
    tenantSlug = 'maven';
    mockEndpoints();
    renderProfile('/program-elements/0601102A?tab=sources');

    expect(await screen.findByText(/evidence coverage/)).toBeInTheDocument();
    expect(apiGet).not.toHaveBeenCalledWith('/api/budget-lifecycle/cycles/2027/health');
  });

  test('source ledger keeps unknown verification unknown and marks linked unverified URLs as candidates', async () => {
    sourceItems = [
      {
        id: 'candidate-source',
        docType: 'committee_report',
        exhibitType: null,
        fy: 2027,
        sourceUrl: 'https://example.gov/report',
        pageNumber: 12,
        pageEnd: null,
        snippet: null,
        publisher: 'House Appropriations',
        confidence: null,
        sourceDocument: null,
      },
      {
        id: 'verified-source',
        docType: 'budget_justification',
        exhibitType: 'R-1',
        fy: 2027,
        sourceUrl: 'https://example.gov/verified',
        pageNumber: 4,
        pageEnd: null,
        snippet: null,
        publisher: null,
        confidence: 0.9,
        sourceDocument: { title: 'R-1 Book', budgetCycle: 'FY2027', sha256: null },
      },
    ];
    mockEndpoints();
    renderProfile('/program-elements/0601102A?tab=sources');

    expect(await screen.findByText('STATUS UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText('CANDIDATE →')).toBeInTheDocument();
    expect(
      screen.getByText('Link is a candidate; source verification is not established.'),
    ).toBeInTheDocument();
    expect(screen.getByText('✓ VERIFIED')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CANDIDATE →' })).toHaveAttribute('rel', 'noreferrer');
  });

  test('source lookup errors are not rendered as an empty ledger', async () => {
    sourcesFail = true;
    mockEndpoints();
    renderProfile('/program-elements/0601102A?tab=sources');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Source records could not be loaded',
    );
    expect(
      screen.queryByText('No page-level sources are attached to this line yet.'),
    ).not.toBeInTheDocument();
  });

  test('Monitor toggles the watch state through the canonical endpoint', async () => {
    mockEndpoints();
    apiPost.mockResolvedValue({ data: { peCode: '0601102A', watching: true } });
    renderProfile();

    await screen.findByText('Defense Research Sciences');
    fireEvent.click(screen.getByRole('button', { name: 'Monitor' }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/program-elements/0601102A/watch', {
        watching: true,
      }),
    );
  });

  test('Report issue opens the data-issue modal; validation blocks an empty description; a valid report posts to the canonical endpoint', async () => {
    mockEndpoints();
    renderProfile();

    await screen.findByText('Defense Research Sciences');
    fireEvent.click(screen.getByRole('button', { name: 'Report issue' }));

    const modal = await screen.findByTestId('pe-data-issue-modal');
    expect(within(modal).getByText(/Reports are tenant-scoped feedback/)).toBeInTheDocument();

    // Empty description fails validation with the canonical message — no POST.
    fireEvent.click(within(modal).getByRole('button', { name: 'Submit report' }));
    expect(await within(modal).findByText('Describe the issue')).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();

    // URL validation matches the canonical rule. (Queried by placeholder: once
    // the error renders, it becomes part of the wrapping label's text.)
    fireEvent.change(within(modal).getByPlaceholderText('https://…'), {
      target: { value: 'not-a-url' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Submit report' }));
    expect(await within(modal).findByText('Must be an http(s) URL')).toBeInTheDocument();
    fireEvent.change(within(modal).getByPlaceholderText('https://…'), {
      target: { value: '' },
    });

    fireEvent.change(within(modal).getByPlaceholderText('What looks wrong, and why?'), {
      target: { value: 'The HAC-D mark disagrees with the committee report table.' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Submit report' }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/program-elements/0601102A/data-issues',
        expect.objectContaining({
          issueType: 'value_incorrect',
          description: 'The HAC-D mark disagrees with the committee report table.',
          fy: 2027,
          suggestedSourceUrl: null,
        }),
      ),
    );
    // Modal closes after success.
    await waitFor(() =>
      expect(screen.queryByTestId('pe-data-issue-modal')).not.toBeInTheDocument(),
    );
  });

  test('a 404 renders the not-found state, never an empty profile', async () => {
    mockEndpoints(() => Promise.reject({ response: { status: 404 } }));
    renderProfile();

    expect(await screen.findByTestId('pe-state-not-found')).toBeInTheDocument();
    expect(
      screen.getByText('No PE record exists for 0601102A. This is not an empty watch page.'),
    ).toBeInTheDocument();
  });

  test('a non-404 failure renders the failed state with a retry affordance', async () => {
    mockEndpoints(() => Promise.reject({ response: { status: 500 } }));
    renderProfile();

    expect(await screen.findByTestId('pe-state-failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('an unsupported source family fails closed with no fabricated figures', async () => {
    mockEndpoints({ ...DETAIL, unsupportedSourceFamily: true });
    renderProfile();

    expect(await screen.findByTestId('pe-state-unsupported')).toBeInTheDocument();
    expect(screen.queryByText('$310.5M')).not.toBeInTheDocument();
  });

  test('a known identity with no ingested budget years says so explicitly', async () => {
    mockEndpoints({ ...DETAIL, years: [] });
    renderProfile();

    expect(await screen.findByText('Not yet ingested')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The Program Element identity is known, but no budget-year rows have been ingested for this code.',
      ),
    ).toBeInTheDocument();
    // NO POSITION headline — a missing figure is stated, never zeroed.
    expect(screen.getByText('NO POSITION')).toBeInTheDocument();
  });
});

describe('PeProfileVNext canonical pathname and explicit legacy override', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    tenantSlug = 'capiro-internal';
    sourceItems = [];
    sourcesFail = false;
    dossierMode='empty';dossierFailRefresh=false;
  });
  test('an ASCII-lowercase pathname is claimed, requests the canonical uppercase id and keeps the original URL', async () => {
    mockEndpoints();
    // The URL is lowercase; matchPeProfilePath normalizes ASCII lowercase to the
    // canonical uppercase dossier id (PE_PROFILE_ID is /i + .toUpperCase()), so
    // the route is claimed and the profile loads.
    renderProfile('/program-elements/0601102a');
    expect(await screen.findByText('Defense Research Sciences')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/api/program-elements/0601102A');
    expect(screen.getByText('0601102A')).toBeInTheDocument();
    // The route is claimed and read, but the URL the user typed is never rewritten.
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/program-elements/0601102a');
  });
  test.each(['reconciliation', 'whatever'] as const)(
    'a static-segment or malformed pathname (%s) is not claimed as a line profile',
    async (segment) => {
      mockEndpoints();
      renderProfile(`/program-elements/${segment}`);
      expect(await screen.findByRole('alert')).toHaveTextContent('Missing Program Element code');
      expect(apiGet).not.toHaveBeenCalledWith('/api/program-elements/0601102A');
    },
  );
  test('an explicit legacy lowercase code override retains core normalization without changing route ownership', async () => {
    mockEndpoints();
    renderProfile('/program-elements/0601102a', '0601102a');
    expect(await screen.findByText('Defense Research Sciences')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/api/program-elements/0601102A');
    expect(screen.getByText('0601102A')).toBeInTheDocument();
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/program-elements/0601102a');
  });
});

describe('Native dossier and URL authority regressions',()=>{
 beforeEach(()=>{apiGet.mockReset();apiPost.mockReset();sourceItems=[];sourcesFail=false;dossierMode='empty';dossierFailRefresh=false;});
 test('external URL/history controls the selected tab after a previous tab click',async()=>{
  tenantSlug='maven';mockEndpoints();renderProfile();await screen.findByText('Defense Research Sciences');fireEvent.click(screen.getByRole('tab',{name:'Sources & proof'}));await screen.findByText(/evidence coverage/);
  fireEvent.click(screen.getByRole('button',{name:'URL funding'}));await waitFor(()=>expect(screen.getByRole('tab',{name:'Funding & lifecycle'})).toHaveAttribute('aria-selected','true'));
  fireEvent.click(screen.getByRole('button',{name:'History back'}));await waitFor(()=>expect(screen.getByRole('tab',{name:'Sources & proof'})).toHaveAttribute('aria-selected','true'));
  fireEvent.click(screen.getByRole('button',{name:'History forward'}));await waitFor(()=>expect(screen.getByRole('tab',{name:'Funding & lifecycle'})).toHaveAttribute('aria-selected','true'));
 });
 test.each(['pending','error'] as const)('shows honest %s dossier state and useful partial canonical description',async mode=>{
  dossierMode=mode;mockEndpoints();renderProfile();await screen.findByText('Defense Research Sciences');expect(await screen.findByText('Basic research program.')).toBeInTheDocument();expect(screen.getByText('Canonical description · partial provenance')).toBeInTheDocument();
  expect(await screen.findByText(mode==='pending'?'Loading dossier fields…':/Dossier fields could not be refreshed/)).toBeInTheDocument();expect(screen.queryByText(/Dossier coverage: available/)).not.toBeInTheDocument();
 });
 test('renders all eight native field values and distinct availability with exact contextual citations',async()=>{
  dossierMode='fields';mockEndpoints();renderProfile();await screen.findByText('Actual mission');for(const name of fieldNames)expect(screen.getByText('Actual '+name)).toBeInTheDocument();
  const mission=screen.getByRole('region',{name:'Mission'}),plans=screen.getByRole('region',{name:'Plans'});expect(within(mission).getByText('Availability: available')).toBeInTheDocument();expect(within(plans).getByText('Availability: partial')).toBeInTheDocument();
  expect(within(plans).getByText('canonical_value_field_provenance_unavailable')).toBeInTheDocument();fireEvent.click(within(plans).getByText('Source context (1)'));expect(within(plans).getByRole('link',{name:'Qualified publisher'})).toHaveAttribute('href','https://example.gov/plans');expect(within(plans).getByText(/occurrence occ-plans/)).toBeInTheDocument();expect(within(plans).getByText(/revision rev-plans/)).toBeInTheDocument();
 });
 test('retains partial useful fields and labels current freshness unknown on failed dossier refresh',async()=>{
  dossierMode='fields';mockEndpoints();renderProfile();await screen.findByText('Actual plans');dossierFailRefresh=true;await act(async()=>{await profileClient.invalidateQueries({queryKey:['defense-dossier']});});expect(await screen.findByText(/Dossier fields could not be refreshed/)).toBeInTheDocument();expect(screen.getByText('Actual plans')).toBeInTheDocument();expect(screen.queryByRole('region',{name:'Canonical description fallback'})).not.toBeInTheDocument();
 });
});

describe('Dossier citation URL safety',()=>{
 beforeEach(()=>{apiGet.mockReset();apiPost.mockReset();tenantSlug='maven';sourceItems=[];sourcesFail=false;dossierMode='fields';dossierFailRefresh=false;});
 test.each(['javascript:alert(1)','https://name:secret@example.gov/doc','https://example.gov/\ncontrol','https://example.gov/\\path'])('renders unsafe citation %s as unavailable plain text',async url=>{
  const evidence=dossier.fields[0]!.evidence[0]!,original=evidence.sourceUrl;
  try{evidence.sourceUrl=url;mockEndpoints();renderProfile();await screen.findByText('Actual mission');const mission=screen.getByRole('region',{name:'Mission'});fireEvent.click(within(mission).getByText('Source context (1)'));expect(within(mission).queryByRole('link')).not.toBeInTheDocument();expect(within(mission).getByText(/source URL unavailable/)).toBeInTheDocument();expect(screen.getByText('Field-specific provenance is partial.')).toBeInTheDocument();}
  finally{evidence.sourceUrl=original;}
 });
});