import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Bill360PageVNext } from './Bill360PageVNext.js';
import type { BillDossierResponse } from '../../../pages/bills/bill-360.types.js';

/**
 * Bill 360 vNext page regression — the canonical Bill360Page.test.tsx contract
 * re-asserted against the vNext re-skin (plan §2.6).
 *
 * The truth-layer assertions from the R1 H.R. 8800 fixture are re-asserted at the
 * UI boundary: the failed governing rule and its exact tally are on screen, the
 * absence of a target-bill vote is stated, and nothing implies a pending floor
 * vote. Plus the routing/isolation contract: global vs client use separate React
 * Query keys, client context never leaks between bills, and the page fails closed
 * when `bill_360` is off. Selectors target the vNext (`b360-*`) classes and the
 * CapiroTabs tab role; endpoints and query keys are the SAME modules as canonical
 * (bill-360-api.ts is shared), so those assertions are byte-identical.
 */

const getMock = vi.fn();
let folderEnabled = false;
vi.mock('../legiwatch/bills/folder-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../legiwatch/bills/folder-api.js')>()),
  useFolderTrackerFlag: () => ({
    enabled: folderEnabled,
    ready: true,
    scope: 'tenant-one:user-one',
  }),
}));
vi.mock('../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant-one:user-one' }));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}));

let flag = { enabled: true, ready: true };
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  BILL_360_FEATURE: 'bill_360',
  useIntelFeature: () => flag,
  useIntelFeatureEnabled: () => flag.enabled,
}));

const navigateMock = vi.fn();
let search = '';
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: `/bills/${currentBillId}`, search }),
  useNavigate: () => navigateMock,
  useParams: () => ({ billId: currentBillId }),
  useSearchParams: () => [new URLSearchParams(search)],
}));

let currentBillId = '119-hr-8800';

const HR_8800_URL = 'https://www.congress.gov/bill/119th-congress/house-bill/8800';

/** The API's grounded reason when defense_funding_intel is off for the tenant. */
const NO_FUNDING_REASON =
  'Funding intelligence is not yet enabled for this vehicle. No $0 is shown unless a source states zero.';

/** Mirrors the R1 fixture's dossier for H.R. 8800: rule failed, no floor vote. */
function hr8800(overrides: Partial<BillDossierResponse> = {}): BillDossierResponse {
  return {
    bill: {
      id: '119-hr-8800',
      num: 'H.R. 8800',
      title: 'Border Security and Enforcement Appropriations Act, 2026',
      chamber: 'House',
      type: 'hr',
      congress: 119,
      sponsor: 'Rep. Example (R-TX)',
      introduced: '2026-03-04T00:00:00.000Z',
      statusLabel: 'Rule failed',
      statusSev: 'critical',
      statusAt: '2026-06-18T21:30:00.000Z',
      stage: 'rule_failed',
      jurisdiction: 'US',
      isState: false,
      url: HR_8800_URL,
    },
    latest: {
      text: 'Rule H. Res. 1398 providing for consideration reported to the House.',
      date: '2026-06-17T00:00:00.000Z',
    },
    context: null,
    tracking: null,
    kpis: [
      {
        id: 'current_status',
        label: 'Current status',
        value: 'Rule failed',
        valueType: 'status',
        asOf: '2026-06-18T00:00:00.000Z',
        sub: null,
        unavailableReason: null,
      },
      {
        id: 'latest_vote',
        label: 'Latest recorded vote',
        value: 'Failed 211-214',
        valueType: 'text',
        asOf: '2026-06-18T00:00:00.000Z',
        sub: 'Governing rule H. Res. 1398',
        unavailableReason: null,
      },
      {
        id: 'funding_position',
        label: 'Funding position',
        value: null,
        valueType: 'money',
        asOf: null,
        sub: null,
        unavailableReason: NO_FUNDING_REASON,
      },
      {
        id: 'delta_from_request',
        label: 'Δ from request',
        value: null,
        valueType: 'signed_money',
        asOf: null,
        sub: null,
        unavailableReason: NO_FUNDING_REASON,
      },
      {
        id: 'last_official_action',
        label: 'Last official action',
        value: '2026-06-17T00:00:00.000Z',
        valueType: 'date',
        asOf: '2026-06-17T00:00:00.000Z',
        sub: 'Rule reported.',
        unavailableReason: null,
      },
      {
        id: 'next_milestone',
        label: 'Next milestone',
        value: null,
        valueType: 'text',
        asOf: null,
        sub: null,
        unavailableReason: 'No analyst has recorded an expected next milestone for this bill.',
      },
    ],
    overview: {
      whatChanged: {
        origin: 'official',
        text: 'Rule H. Res. 1398 reported to the House.',
        asOf: '2026-06-17',
        source: 'Congress.gov',
        sourceUrl: HR_8800_URL,
      },
      whyItMatters: null,
      officialNextStep: {
        origin: 'official',
        text: 'The governing rule failed; the measure is stalled pending a new rule or an alternative path to the floor.',
        asOf: '2026-06-18',
        source: 'Congress.gov',
        sourceUrl: HR_8800_URL,
      },
      analystOutlook: null,
    },
    milestones: [
      {
        date: '2026-06-18',
        label: 'Governing rule H. Res. 1398 failed',
        detail: 'On Agreeing to the Resolution',
        state: 'failed',
        sev: 'critical',
      },
    ],
    votes: [
      {
        id: 'house-119-1-240',
        label: 'Governing rule H. Res. 1398',
        target: 'rule',
        chamber: 'house',
        date: '2026-06-18',
        result: 'Failed',
        resultSev: 'critical',
        tally: '211-214',
        party: { gopYea: 210, gopNay: 3, demYea: 1, demNay: 211 },
        note: null,
      },
    ],
    governingRules: [
      {
        id: 'house-119-1-240',
        label: 'H. Res. 1398',
        desc: 'On Agreeing to the Resolution (H. Res. 1398)',
        result: 'Failed',
        resultSev: 'critical',
        tally: '211-214',
        date: '2026-06-18',
        controls: true,
        note: 'The rule failed; the underlying measure did not reach a floor vote.',
      },
    ],
    noVote: 'No roll call vote has been recorded on this bill.',
    funding: {
      available: false,
      status:
        'Funding intelligence is not yet enabled for this vehicle. No $0 is shown unless a source states zero.',
      positions: [],
      reqCompare: null,
      senateCompare: null,
      comparisons: [],
      guardrail: null,
      programElementImpacts: [],
      provisions: [],
      parentPackageLabel: null,
    },
    relatedVehicles: [],
    hearings: [],
    alerts: [],
    matchedTopics: [],
    recommendedActions: [],
    provenance: {
      lastSyncedAt: '2026-06-19T06:00:00.000Z',
      sources: [
        {
          label: 'Congress.gov',
          as: '2026-06-18',
          origin: 'official',
          fresh: true,
          url: HR_8800_URL,
        },
      ],
    },
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <Bill360PageVNext />
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

beforeEach(() => {
  folderEnabled = false;
  getMock.mockReset();
  navigateMock.mockReset();
  flag = { enabled: true, ready: true };
  search = '';
  currentBillId = '119-hr-8800';
});

test('the active vNext full page preserves folder context and exposes state source records', async () => {
  folderEnabled = true;
  search = 'folder=folder-one';
  currentBillId = 'fl-2026-h0047';
  const d = hr8800();
  d.bill = {
    ...d.bill,
    id: currentBillId,
    num: 'HB 47',
    isState: true,
    jurisdiction: 'FL',
    sponsorLegislatorId: 'person-one',
  };
  d.provenance = {
    ...d.provenance,
    sourceCheckStatus: 'unknown',
    sourceCheckedAt: null,
    sourceCheckAttemptedAt: null,
  };
  getMock.mockImplementation(async (url) => {
    if (url.endsWith('/context'))
      return {
        data: {
          folder: { id: 'folder-one', name: 'Selected folder', clientId: null },
          assignment: {
            topPriority: true,
            importance: 'high',
            position: 'oppose',
            internalComments: 'Private folder note',
            externalComments: 'External wording',
            version: 1,
          },
          canEdit: false,
        },
      };
    if (url.endsWith('/records'))
      return {
        data: {
          rows: [
            {
              id: 'doc-47',
              date: '2026-06-26',
              label: 'Enrolled text',
              url: 'https://www.flsenate.gov/Session/Bill/2026/47',
            },
          ],
          total: 1,
          nextCursor: null,
          coverage: 'available',
          reason: null,
        },
      };
    return { data: d };
  });
  renderPage();
  expect(await screen.findByText('Private folder note')).toHaveClass('lw-folder-internal');
  expect(screen.getByRole('link', { name: 'Sponsor profile' })).toHaveAttribute(
    'href',
    '/directory/state-legislators/person-one',
  );
  (await screen.findByRole('tab', { name: 'Evidence' })).click();
  expect(await screen.findByRole('region', { name: 'Source check status' })).toBeTruthy();
  await waitFor(() =>
    expect(getMock).toHaveBeenCalledWith(
      '/intel-api/bills/fl-2026-h0047/records',
      expect.objectContaining({ params: expect.objectContaining({ section: 'documents' }) }),
    ),
  );
  expect(await screen.findByText(/Enrolled text/)).toBeTruthy();
});

test('a folder URL does not fetch private context while the folder flag is off', async () => {
  search = 'folder=folder-one';
  getMock.mockResolvedValue({ data: hr8800() });
  renderPage();
  await screen.findByRole('tab', { name: 'Overview' });
  expect(getMock.mock.calls.some(([url]) => url.endsWith('/context'))).toBe(false);
});

describe('Bill360PageVNext — H.R. 8800 truth layer', () => {
  test('shows the failed governing rule with the exact tally and the controls-status badge', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    // Hero carries the canonical status as the pill, never an analyst guess. The
    // same label also appears as the "Current status" KPI value — assert both, by
    // class, rather than a bare text query that matches two nodes.
    expect(await screen.findByText('H.R. 8800')).toBeTruthy();
    const statusPill = document.querySelector('.b360-hero .b360-pill');
    expect(statusPill?.textContent).toBe('Rule failed');
    // critical severity maps onto the danger badge tone on the vNext layer.
    expect(statusPill?.className).toContain('b360-pill--critical');
    expect(statusPill?.className).toContain('capiro-badge--danger');
    // The KPI strip surfaces the rule outcome as the latest recorded vote.
    expect(screen.getByText('Failed 211-214')).toBeTruthy();

    // Path & votes tab: the rule callout with the exact tally. The same tally is
    // also on the recorded-vote card, so assert per section rather than by text.
    (await screen.findByRole('tab', { name: 'Path & votes' })).click();
    await waitFor(() => expect(document.querySelector('.b360-rule-callout')).toBeTruthy());
    expect(document.querySelector('.b360-rule-tally')?.textContent).toBe('211-214');
    expect(document.querySelector('.b360-vote-tally')?.textContent).toBe('211-214');
    expect(screen.getByText('Controls status')).toBeTruthy();
    expect(screen.getByText(/did not reach a floor vote/i)).toBeTruthy();
    // Party split renders from the R1 member-vote tallies (210-3 / 1-211).
    const partyTallies = Array.from(document.querySelectorAll('.b360-party-tally')).map(
      (n) => n.textContent,
    );
    expect(partyTallies).toEqual(['210–3', '1–211']);
  });

  test('states the absence of a target-bill vote and never implies a pending floor vote', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    (await screen.findByRole('tab', { name: 'Path & votes' })).click();
    expect(
      await screen.findByText('No roll call vote has been recorded on this bill.'),
    ).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('pending floor vote');
  });

  test('funding renders a grounded empty state, never $0', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    (await screen.findByRole('tab', { name: 'Funding' })).click();
    expect(await screen.findByText(/No funding positions linked yet/i)).toBeTruthy();
    // The grounded copy explains the rule; what must NOT exist is a fabricated
    // amount — no position row and no amount slot at all. LW-QA-021: the KPI
    // strip now states the same reason, so the copy legitimately appears more
    // than once (it used to render a bare em-dash there).
    expect(
      screen.getAllByText(/No \$0 is shown unless a source states zero/i).length,
    ).toBeGreaterThan(0);
    expect(document.querySelector('.b360-fund-amount')).toBeNull();
    expect(document.querySelector('.b360-petable')).toBeNull();
  });

  test('LW-QA-021: the KPI strip says why a figure is missing, never blank or 0', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    const strip = (await screen.findByText('Funding position')).closest('.b360-kpi')!;
    expect(strip.textContent).toContain('Not available');
    expect(strip.textContent).toMatch(/No \$0 is shown unless a source states zero/i);
    expect(strip.textContent).not.toContain('$0.0');

    // The last-action cell shows a calendar date, never a raw ISO instant.
    const action = (await screen.findByText('Last official action')).closest('.b360-kpi')!;
    expect(action.textContent).toContain('2026-06-17');
    expect(action.textContent).not.toContain('T00:00:00.000Z');

    // A date can never land in the funding-delta cell.
    const delta = (await screen.findByText('Δ from request')).closest('.b360-kpi')!;
    expect(delta.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test('the chrome bar offers both exports once the dossier has loaded', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    expect(await screen.findByRole('button', { name: /Fact sheet \(PDF\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Funding \(CSV\)/ })).toBeTruthy();
  });
});

describe('Bill360PageVNext — routing, context isolation, flag gating', () => {
  test('a bare URL loads the GLOBAL dossier with no client context', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(getMock).toHaveBeenCalledWith('/intel-api/bills/119-hr-8800/dossier');
    // No scope chip / stance / priority on a public dossier.
    expect(screen.queryByText('Stance')).toBeNull();
    expect(screen.queryByText('Priority')).toBeNull();
  });

  test('?client=<id> loads the client-context dossier and shows the scope chip', async () => {
    search = 'client=11111111-1111-1111-1111-111111111111';
    getMock.mockResolvedValue({
      data: hr8800({
        context: {
          contextType: 'client',
          externalRef: '11111111-1111-1111-1111-111111111111',
          name: 'Acme Defense',
        },
        tracking: {
          tracked: true,
          position: 'oppose',
          priority: 'high',
          analystNote: 'Watch the rule re-vote.',
          stage: 'floor',
          trackedAt: '2026-05-03T00:00:00.000Z',
          expected: null,
        },
      }),
    });
    renderPage();

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(getMock).toHaveBeenCalledWith(
      '/intel-api/clients/11111111-1111-1111-1111-111111111111/bills/119-hr-8800/dossier',
    );
    expect(await screen.findByText('Acme Defense')).toBeTruthy();
    expect(screen.getByText('Client')).toBeTruthy();
    expect(screen.getByText('Oppose')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
  });

  test('global and client dossiers occupy separate React Query keys (no context leak)', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    const { qc, unmount } = renderPage();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    unmount();

    search = 'client=11111111-1111-1111-1111-111111111111';
    getMock.mockResolvedValue({
      data: hr8800({
        context: {
          contextType: 'client',
          externalRef: '11111111-1111-1111-1111-111111111111',
          name: 'Acme Defense',
        },
      }),
    });
    render(
      <QueryClientProvider client={qc}>
        <Bill360PageVNext />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));

    const keys = qc
      .getQueryCache()
      .getAll()
      .map((q) => JSON.stringify(q.queryKey))
      .filter((k) => k.includes('bill-dossier'));
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain('["bill-dossier","119-hr-8800",null,"tenant-one:user-one"]');
    expect(keys).toContain(
      '["bill-dossier","119-hr-8800","11111111-1111-1111-1111-111111111111","tenant-one:user-one"]',
    );
  });

  test('fails closed when bill_360 is disabled — a plain state, never a blank page', async () => {
    flag = { enabled: false, ready: true };
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    expect(await screen.findByText(/Bill 360 is not enabled/i)).toBeTruthy();
    // The dossier is never fetched for a tenant without the flag.
    expect(getMock).not.toHaveBeenCalled();
  });

  test('renders nothing while the flag is still resolving (no flash of a dark surface)', () => {
    flag = { enabled: false, ready: false };
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    expect(screen.queryByText(/Bill 360 is not enabled/i)).toBeNull();
    expect(screen.queryByText('H.R. 8800')).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });
});
