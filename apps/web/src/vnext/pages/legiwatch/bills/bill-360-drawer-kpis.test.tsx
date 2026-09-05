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
import { render, screen, waitFor, cleanup } from '@testing-library/react';
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
      statusLabel: 'Passed a chamber',
      statusSev: 'success',
      statusAt: '2026-07-22T00:00:00.000Z',
      stage: 'passed_chamber',
      jurisdiction: 'US',
      isState: false,
      url: null,
    },
    latest: {
      text: 'Motion to reconsider laid on the table Agreed to without objection.',
      date: '2026-07-22T00:00:00.000Z',
    },
    context: null,
    tracking: null,
    kpis: [
      { id: 'current_status', label: 'Current status', value: 'Passed a chamber', valueType: 'status', asOf: '2026-07-22T00:00:00.000Z', sub: null, unavailableReason: null },
      { id: 'latest_vote', label: 'Latest recorded vote', value: 'Passed 216-212', valueType: 'text', asOf: '2026-07-22T00:00:00.000Z', sub: 'On Passage', unavailableReason: null },
      { id: 'funding_position', label: 'Funding position', value: null, valueType: 'money', asOf: null, sub: null, unavailableReason: NO_FUNDING_REASON },
      { id: 'delta_from_request', label: 'Δ from request', value: null, valueType: 'signed_money', asOf: null, sub: null, unavailableReason: NO_FUNDING_REASON },
      { id: 'last_official_action', label: 'Last official action', value: '2026-07-22T00:00:00.000Z', valueType: 'date', asOf: '2026-07-22T00:00:00.000Z', sub: 'Motion to reconsider laid on the table Agreed to without objection.', unavailableReason: null },
      { id: 'next_milestone', label: 'Next milestone', value: null, valueType: 'text', asOf: null, sub: null, unavailableReason: 'No analyst has recorded an expected next milestone for this bill.' },
    ],
    overview: { whatChanged: null, whyItMatters: null, officialNextStep: null, analystOutlook: null },
    milestones: [],
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
      'Last official action',
      'Next milestone',
    ]);
  });

  it('never paints a raw ISO instant — the last-action tile shows a calendar date', async () => {
    renderDrawer();
    const t = await tile('Last official action');
    expect(t.textContent).toContain('2026-07-22');
    expect(t.textContent).not.toContain('T00:00:00.000Z');
    // …and the action itself rides along, so the tile is meaningful.
    expect(t.textContent).toMatch(/Motion to reconsider/);
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

  it('formats the drawer header timestamp too', async () => {
    renderDrawer();
    await screen.findByText(/H\.R\. 8800/);
    const head = document.querySelector('.lw-b360__head')!;
    expect(head.textContent).toContain('updated 2026-07-22');
    expect(head.textContent).not.toContain('T00:00:00.000Z');
  });
});
