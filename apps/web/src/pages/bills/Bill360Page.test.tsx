import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { Bill360Page } from './Bill360Page.js';
import type { BillDossierResponse } from './bill-360.types.js';

/**
 * Bill 360 page regression (plan §2.6).
 *
 * The truth-layer assertions from the R1 H.R. 8800 fixture are re-asserted at the
 * UI boundary: the failed governing rule and its exact tally are on screen, the
 * absence of a target-bill vote is stated, and nothing implies a pending floor
 * vote. Plus the routing/isolation contract: global vs client use separate React
 * Query keys, client context never leaks between bills, and the page fails closed
 * when `bill_360` is off.
 */

const getMock = vi.fn();
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: vi.fn(), put: vi.fn(), delete: vi.fn() }),
}));

let flag = { enabled: true, ready: true };
vi.mock('../../lib/intel-feature-flags.js', () => ({
  BILL_360_FEATURE: 'bill_360',
  useIntelFeature: () => flag,
  useIntelFeatureEnabled: () => flag.enabled,
}));

const navigateMock = vi.fn();
let search = '';
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useParams: () => ({ billId: currentBillId }),
  useSearchParams: () => [new URLSearchParams(search)],
}));

let currentBillId = '119-hr-8800';

const HR_8800_URL = 'https://www.congress.gov/bill/119th-congress/house-bill/8800';

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
      { label: 'Current status', value: 'Rule failed', sub: '2026-06-18' },
      { label: 'Latest recorded vote', value: 'Failed 211-214', sub: 'Governing rule H. Res. 1398' },
      { label: 'Funding position', value: '—', sub: 'Not linked' },
      { label: 'Δ from request', value: '—', sub: 'n/a' },
      { label: 'Last official action', value: '2026-06-17', sub: 'Rule reported.' },
      { label: 'Next milestone', value: '—', sub: 'None scheduled' },
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
        { label: 'Congress.gov', as: '2026-06-18', origin: 'official', fresh: true, url: HR_8800_URL },
      ],
    },
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <Bill360Page />
      </AntApp>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}

beforeEach(() => {
  getMock.mockReset();
  navigateMock.mockReset();
  flag = { enabled: true, ready: true };
  search = '';
  currentBillId = '119-hr-8800';
});

describe('Bill360Page — H.R. 8800 truth layer', () => {
  test('shows the failed governing rule with the exact tally and the controls-status badge', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    // Hero carries the canonical status as the pill, never an analyst guess. The
    // same label also appears as the "Current status" KPI value — assert both, by
    // class, rather than a bare text query that matches two nodes.
    expect(await screen.findByText('H.R. 8800')).toBeTruthy();
    const statusPill = document.querySelector('.dsr-hero .dsr-pill');
    expect(statusPill?.textContent).toBe('Rule failed');
    expect(statusPill?.className).toContain('critical');
    // The KPI strip surfaces the rule outcome as the latest recorded vote.
    expect(screen.getByText('Failed 211-214')).toBeTruthy();

    // Path & votes tab: the rule callout with the exact tally. The same tally is
    // also on the recorded-vote card, so assert per section rather than by text.
    (await screen.findByRole('button', { name: 'Path & votes' })).click();
    await waitFor(() => expect(document.querySelector('.dsr-rule-callout')).toBeTruthy());
    expect(document.querySelector('.dsr-rule-tally')?.textContent).toBe('211-214');
    expect(document.querySelector('.dsr-vote-tally')?.textContent).toBe('211-214');
    expect(screen.getByText('Controls status')).toBeTruthy();
    expect(screen.getByText(/did not reach a floor vote/i)).toBeTruthy();
    // Party split renders from the R1 member-vote tallies (210-3 / 1-211).
    const partyTallies = Array.from(document.querySelectorAll('.dsr-party-tally')).map(
      (n) => n.textContent,
    );
    expect(partyTallies).toEqual(['210–3', '1–211']);
  });

  test('states the absence of a target-bill vote and never implies a pending floor vote', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    (await screen.findByRole('button', { name: 'Path & votes' })).click();
    expect(
      await screen.findByText('No roll call vote has been recorded on this bill.'),
    ).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('pending floor vote');
  });

  test('funding renders a grounded empty state, never $0', async () => {
    getMock.mockResolvedValue({ data: hr8800() });
    renderPage();

    (await screen.findByRole('button', { name: 'Funding' })).click();
    expect(await screen.findByText(/No funding positions linked yet/i)).toBeTruthy();
    // The grounded copy explains the rule; what must NOT exist is a fabricated
    // amount — no position row and no amount slot at all.
    expect(screen.getByText(/No \$0 is shown unless a source states zero/i)).toBeTruthy();
    expect(document.querySelector('.dsr-fund-amount')).toBeNull();
    expect(document.querySelector('.dsr-petable')).toBeNull();
  });
});

describe('Bill360Page — routing, context isolation, flag gating', () => {
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
        context: { contextType: 'client', externalRef: '11111111-1111-1111-1111-111111111111', name: 'Acme Defense' },
      }),
    });
    render(
      <QueryClientProvider client={qc}>
        <AntApp>
          <Bill360Page />
        </AntApp>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));

    const keys = qc
      .getQueryCache()
      .getAll()
      .map((q) => JSON.stringify(q.queryKey))
      .filter((k) => k.includes('bill-dossier'));
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain('["bill-dossier","119-hr-8800",null]');
    expect(keys).toContain('["bill-dossier","119-hr-8800","11111111-1111-1111-1111-111111111111"]');
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
