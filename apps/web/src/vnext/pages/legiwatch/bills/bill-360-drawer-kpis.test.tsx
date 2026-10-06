/**
 * LW-QA-021 — the LegiWatch Bill 360 drawer's KPI strip.
 *
 * The drawer is the surface the defect was filed against. It rendered the API's
 * positional `BillKpi[]` as value-then-label with no formatter and no `sub`, so
 * on H.R. 8800 the "Last official action" tile literally painted
 * `2026-07-22T00:00:00.000Z`, that value overflowed its 140px tile into the
 * neighbouring one, and three of six tiles showed a bare em-dash that reads as
 * blank. This suite pins the fixed contract.
 */
import { createElement } from 'react';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillDossierResponse } from '../../../../pages/bills/bill-360.types.js';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 't', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string) => apiGet(url) }),
}));

import { Bill360Drawer } from './Bill360Drawer.js';

const NO_FUNDING_REASON =
  'Funding intelligence is not yet enabled for this vehicle. No $0 is shown unless a source states zero.';

/** H.R. 8800 as production actually returns it: a real passage vote, an ISO
 *  last-action instant, and no linked funding position. */
function hr8800(): BillDossierResponse {
  return {
    bill: {
      id: '119-hr-8800',
      num: 'H.R. 8800',
      title: 'Department of Defense Appropriations Act, 2027',
      chamber: 'House',
      type: 'hr',
      congress: 119,
      sponsor: 'Rep. Example',
      introduced: '2026-05-01T00:00:00.000Z',
      statusLabel: 'Passed House',
      statusSev: 'success',
      statusAt: '2026-07-22T00:00:00.000Z',
      stage: 'passed_chamber',
      jurisdiction: 'US',
      isState: false,
      url: null,
    },
    latest: {
      text: 'Received in the Senate.',
      date: '2026-09-14T00:00:00.000Z',
    },
    context: null,
    tracking: null,
    kpis: [
      {
        id: 'current_status',
        label: 'Current status',
        value: 'Passed House',
        valueType: 'status',
        asOf: '2026-07-22T00:00:00.000Z',
        sub: null,
        unavailableReason: null,
      },
      {
        id: 'latest_vote',
        label: 'Latest recorded vote',
        value: 'Passed 216-212',
        valueType: 'text',
        asOf: '2026-07-22T00:00:00.000Z',
        sub: 'On Passage',
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
        label: 'Latest action',
        value: '2026-09-14T00:00:00.000Z',
        valueType: 'date',
        asOf: '2026-09-14T00:00:00.000Z',
        sub: 'Received in the Senate.',
        unavailableReason: null,
      },
      {
        id: 'next_milestone',
        label: 'Expected next step',
        value: 'Senate action',
        valueType: 'text',
        asOf: null,
        sub: 'Date not verified',
        unavailableReason: null,
      },
    ],
    overview: {
      whatChanged: null,
      whyItMatters: null,
      officialNextStep: null,
      analystOutlook: null,
    },
    milestones: [
      {
        date: '2026-09-14T00:00:00.000Z',
        label: 'Received in Senate',
        detail: 'Senate receipt',
        state: 'current',
        outcome: null,
        sourceIds: ['receipt'],
        sourceCount: 1,
      },
      {
        date: '2026-07-22T00:00:00.000Z',
        label: 'Passed House',
        detail: 'On passage · 216–212 · Roll no. 278',
        state: 'done',
        outcome: 'Passed',
        outcomeSev: 'success',
        sourceIds: ['passage-primary', 'passage-summary'],
        sourceCount: 2,
      },
      {
        date: '2026-07-22T00:00:00.000Z',
        label: 'On motion to recommit Failed by the Yeas and Nays: 213 - 216',
        detail: 'House · Floor action',
        state: 'failed',
        outcome: 'Failed',
        outcomeSev: 'critical',
        sourceIds: ['recommit'],
        sourceCount: 1,
      },
    ],
    votes: [],
    governingRules: [],
    noVote: null,
    funding: {
      available: false,
      status: NO_FUNDING_REASON,
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
    provenance: { lastSyncedAt: '2026-07-23T00:00:00.000Z', sources: [] },
  };
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation((url: string) => {
    if (url.includes('/dossier')) return Promise.resolve({ data: hr8800() });
    return Promise.resolve({ data: { hearings: [] } });
  });
});

afterEach(() => cleanup());
it('opens real dossier provisions and honest impact coverage in the drawer', async () => {
  const dossier = hr8800();
  dossier.funding.provisions = [
    {
      sec: '101',
      title: 'Published requirement',
      summary: 'A source-backed provision summary.',
      origin: 'official',
      source: 'Committee report',
    },
  ];
  apiGet.mockImplementation(async (url: string) => ({
    data: url.includes('/dossier') ? dossier : { hearings: [] },
  }));
  renderDrawer();
  fireEvent.click(await screen.findByRole('tab', { name: 'Provisions' }));
  expect(screen.getByText('Published requirement')).toBeTruthy();
  expect(screen.getByText('A source-backed provision summary.')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Impact' }));
  expect(
    screen.getByText(/Select a client to prepare a client-specific impact draft/),
  ).toBeTruthy();
  expect(screen.queryByText(/full dossier contract/)).toBeNull();
});

function renderDrawer() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        null,
        createElement(Bill360Drawer, {
          billId: '119-hr-8800',
          clientId: '',
          onClose: () => {},
          onOpenFull: () => {},
        }),
      ),
    ),
  );
}

/** The `.lw-stat` tile whose label is `label`. */
async function tile(label: string): Promise<HTMLElement> {
  const el = await screen.findByText(label);
  const t = el.closest('.lw-stat');
  if (!t) throw new Error(`no .lw-stat tile for ${label}`);
  return t as HTMLElement;
}

describe('LW-QA-021 — Bill 360 drawer KPI strip', () => {
  it('renders all six tiles in the canonical order, keyed by id not position', async () => {
    renderDrawer();
    await waitFor(() => expect(document.querySelectorAll('.lw-stat').length).toBe(6));
    expect([...document.querySelectorAll('.lw-stat__label')].map((n) => n.textContent)).toEqual([
      'Current status',
      'Latest recorded vote',
      'Funding position',
      'Δ from request',
      'Latest action',
      'Expected next step',
    ]);
  });

  it('never paints a raw ISO instant — the last-action tile shows a calendar date', async () => {
    renderDrawer();
    const t = await tile('Latest action');
    expect(t.textContent).toContain('2026-09-14');
    expect(t.textContent).not.toContain('T00:00:00.000Z');
    // …and the action itself rides along, so the tile is meaningful.
    expect(t.textContent).toMatch(/Received in the Senate/);
  });

  it('shows the real recorded vote where one exists', async () => {
    renderDrawer();
    const t = await tile('Latest recorded vote');
    expect(t.querySelector('.lw-stat__value')?.textContent).toBe('Passed 216-212');
    expect(t.textContent).toContain('On Passage');
  });

  it('says WHY funding is missing — never blank, never 0, never a bare dash', async () => {
    renderDrawer();
    for (const label of ['Funding position', 'Δ from request']) {
      const t = await tile(label);
      expect(t.querySelector('.lw-stat__value')?.textContent).toBe('Not available');
      expect(t.textContent).toContain('No $0 is shown unless a source states zero');
      expect(t.querySelector('.lw-stat__value')?.textContent).not.toBe('—');
      expect(t.querySelector('.lw-stat__value')?.textContent).not.toBe('');
    }
  });

  it('never puts a date in the funding-delta tile', async () => {
    renderDrawer();
    const t = await tile('Δ from request');
    expect(t.querySelector('.lw-stat__value')?.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('puts the label ABOVE the value in every tile (app-wide KPI convention)', async () => {
    renderDrawer();
    await waitFor(() => expect(document.querySelectorAll('.lw-stat').length).toBe(6));
    for (const t of document.querySelectorAll('.lw-stat')) {
      const kids = [...t.children].map((c) => c.className);
      expect(kids[0]).toBe('lw-stat__label');
      expect(kids[1]).toBe('lw-stat__value');
    }
  });

  it('keeps the passage status date separate from the later latest-action date', async () => {
    renderDrawer();
    await screen.findByText(/H\.R\. 8800/);
    const head = document.querySelector('.lw-b360__head')!;
    expect(head.textContent).toContain('Passed House · 2026-07-22');
    expect(head.textContent).toContain('Latest action 2026-09-14');
    expect(head.textContent).not.toContain('T00:00:00.000Z');
  });

  it('shows an external expected step without implying an official schedule', async () => {
    renderDrawer();
    const t = await tile('Expected next step');
    expect(t.querySelector('.lw-stat__value')?.textContent).toBe('Senate action');
    expect(t.textContent).toContain('Date not verified');
    expect(t.textContent).not.toContain('No analyst has recorded');
  });

  it('shows one aggregated passage event, readable receipt copy, and explicit outcomes', async () => {
    renderDrawer();
    fireEvent.click(await screen.findByRole('tab', { name: 'Path & Votes' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Received in Senate');
    expect(dialog.textContent).toContain('Senate receipt');
    expect(dialog.textContent).not.toContain('IntroReferral');
    expect(dialog.textContent).toContain('2 official source records');
    expect(dialog.textContent).toContain('Passed');
    expect(dialog.textContent).toContain('Failed');
    expect(screen.getAllByText('Passed')).toHaveLength(1);
    expect(screen.getAllByText('Failed')).toHaveLength(1);
  });

  it('shows House authorization tables as pending analysis with exact track and source context', async () => {
    const d = hr8800();
    d.kpis = d.kpis.map((cell) => {
      if (cell.id === 'funding_position') {
        return {
          ...cell,
          label: 'House authorization',
          unavailableLabel: 'Analysis pending',
          unavailableReason: 'Funding tables are available; amounts await verification.',
        };
      }
      if (cell.id === 'delta_from_request') {
        return {
          ...cell,
          label: 'Change vs. FY2027 request',
          unavailableLabel: 'Comparison pending',
          unavailableReason: 'Funding tables are available; amounts await verification.',
        };
      }
      return cell;
    });
    d.funding = {
      ...d.funding,
      available: true,
      status: 'Funding tables are available; amounts await verification.',
      tablesAvailable: true,
      analysisStatus: 'analysis_pending',
      overrideReconciliation: 'not_required',
      vehicle: {
        id: 'veh-hr8800-house',
        label: 'House-passed H.R. 8800',
        track: 'authorization',
        stage: 'house',
        status: 'passed',
        chamber: 'house',
        fiscalYear: 2027,
        amountTreatment: 'proposed_authorization',
        sourceDocumentTitle: 'House-passed H.R. 8800 funding tables',
        sourceDocumentKey: 'hr8800_house_passed_fy2027',
        sourceDocumentVersion: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        sourceDocumentUrl: 'https://example.invalid/hr8800',
        sourceDocumentCurrent: true,
      },
      programElementImpacts: [
        {
          pe: '0603270A',
          name: 'Electronic Warfare Technology',
          fiscalYear: 2027,
          vehicleTrack: 'authorization',
          houseLabel: 'House authorization (HASC)',
          senateLabel: 'Senate authorization (SASC)',
          conferenceLabel: 'NDAA conference authorization',
          requestMillions: 100,
          houseMillions: 120,
          senateMillions: null,
          conferenceMillions: null,
          enactedMillions: null,
          deltaVsRequestMillions: 20,
          pct: 20,
          basis: 'explicit',
          source: 'FY2027 · authorization track · accepted',
        },
      ],
    };
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/dossier')) return Promise.resolve({ data: d });
      return Promise.resolve({ data: { hearings: [] } });
    });

    renderDrawer();
    expect((await tile('House authorization')).textContent).toContain('Analysis pending');
    expect((await tile('Change vs. FY2027 request')).textContent).toContain('Comparison pending');

    fireEvent.click(await screen.findByRole('tab', { name: 'Funding' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(
      'Funding tables are available; amounts await verification.',
    );
    expect(dialog.textContent).toContain('Proposed authorization level — not appropriated funding');
    expect(dialog.textContent).toContain('House-passed H.R. 8800 funding tables');
    expect(dialog.textContent).toContain('version 0123456789ab');
    expect(dialog.textContent).toContain('House authorization (HASC)');
    expect(dialog.textContent).toContain('Senate authorization (SASC)');
    expect(dialog.textContent).not.toContain('No funding lines are carried by this vehicle');
  });
});
