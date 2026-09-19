/**
 * Regression: the Bill 360 drawer's Evidence-tab research handoff must build
 * the research scope from the dossier's canonical identity — never from naive
 * `billId.split('-')` segments.
 *
 * Defect (verified against intel-api): `ca-2025-ab1093` produced
 * `jurisdiction=ca` (lowercase) which research.service `scopeOf` rejects with
 * INVALID_RESEARCH_SCOPE (`/^[A-Z]{2}$/`); federal id `119-hr-8800` produced
 * `jurisdiction=119` — equally invalid. The link also sent session=119 for a
 * federal bill even though the research session for US is the congress number
 * string, which the dossier already carries as canonical metadata.
 */
import { createElement } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
// The source-records panel is irrelevant to the link contract; keep it inert.
vi.mock('./BillSourceRecords.js', () => ({ BillSourceRecords: () => null }));
vi.mock('../hearings/BillAgenda.js', () => ({ BillAgenda: () => null }));

import { Bill360Drawer } from './Bill360Drawer.js';

function dossier(bill: Partial<BillDossierResponse['bill']>): BillDossierResponse {
  return {
    bill: {
      id: 'ca-2025-ab1093',
      num: 'AB 1093',
      title: 'Synthetic state bill',
      chamber: 'Assembly',
      type: 'ab',
      congress: null,
      sponsor: null,
      introduced: null,
      statusLabel: 'In committee',
      statusSev: 'neutral',
      statusAt: null,
      stage: 'in_committee',
      jurisdiction: 'CA',
      isState: true,
      url: null,
      ...bill,
    },
    latest: { text: null, date: null },
    context: null,
    tracking: null,
    kpis: [],
    overview: { whatChanged: null, whyItMatters: null, officialNextStep: null },
    milestones: [],
    votes: [],
    governingRules: [],
    noVote: null,
    funding: { lines: [] },
    relatedVehicles: [],
    hearings: [],
    alerts: [],
    matchedTopics: [],
    recommendedActions: [],
    provenance: { sources: [] },
  } as unknown as BillDossierResponse;
}

function renderDrawer(billId: string, d: BillDossierResponse) {
  apiGet.mockImplementation((url: string) => {
    if (url?.includes?.('/dossier')) return Promise.resolve({ data: d });
    return Promise.resolve({ data: { hearings: [] } });
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        MemoryRouter,
        null,
        createElement(Bill360Drawer, {
          billId,
          clientId: '',
          onClose: () => {},
          onOpenFull: () => {},
        }),
      ),
    ),
  );
}

async function evidenceLink(): Promise<HTMLAnchorElement> {
  const tab = await screen.findByRole('tab', { name: 'Evidence' });
  fireEvent.click(tab);
  const link = await screen.findByRole('link', {
    name: 'Research and compare exact bill documents',
  });
  return link as HTMLAnchorElement;
}

beforeEach(() => apiGet.mockReset());
afterEach(() => cleanup());

describe('Bill 360 Evidence → Research handoff scope', () => {
  it('state bill: uppercase jurisdiction + session from the canonical id, never lowercase', async () => {
    renderDrawer('ca-2025-ab1093', dossier({ jurisdiction: 'CA' }));
    const link = await evidenceLink();
    const url = new URL(link.href, 'http://test');
    expect(url.searchParams.get('jurisdiction')).toBe('CA');
    expect(url.searchParams.get('session')).toBe('2025');
    expect(url.searchParams.get('bill')).toBe('ca-2025-ab1093');
  });

  it('federal bill: jurisdiction=US with the congress session, never "119" as a jurisdiction', async () => {
    renderDrawer(
      '119-hr-8800',
      dossier({
        id: '119-hr-8800',
        num: 'H.R. 8800',
        isState: false,
        jurisdiction: 'US',
        congress: 119,
      }),
    );
    const link = await evidenceLink();
    const url = new URL(link.href, 'http://test');
    expect(url.searchParams.get('jurisdiction')).toBe('US');
    expect(url.searchParams.get('session')).toBe('119');
    expect(url.searchParams.get('bill')).toBe('119-hr-8800');
  });

  it('special-session state id keeps its full canonical session segment', async () => {
    renderDrawer('fl-2026x2266-s12', dossier({ id: 'fl-2026x2266-s12', jurisdiction: 'FL' }));
    const link = await evidenceLink();
    const url = new URL(link.href, 'http://test');
    expect(url.searchParams.get('jurisdiction')).toBe('FL');
    expect(url.searchParams.get('session')).toBe('2026x2266');
  });

  it('federal bill resolves US even when the dossier omits jurisdiction', async () => {
    renderDrawer(
      '119-hr-8800',
      dossier({
        id: '119-hr-8800',
        num: 'H.R. 8800',
        isState: false,
        jurisdiction: null,
        congress: 119,
      }),
    );
    const link = await evidenceLink();
    const url = new URL(link.href, 'http://test');
    expect(url.searchParams.get('jurisdiction')).toBe('US');
    expect(url.searchParams.get('session')).toBe('119');
  });

  it('state bill with missing jurisdiction falls back to its canonical id prefix, never another state', async () => {
    renderDrawer('ca-2025-ab1093', dossier({ jurisdiction: null }));
    const link = await evidenceLink();
    const url = new URL(link.href, 'http://test');
    expect(url.searchParams.get('jurisdiction')).toBe('CA');
    expect(url.searchParams.get('session')).toBe('2025');
  });

  it('never emits a non-uppercase or non-alpha jurisdiction even if the id is irregular', async () => {
    renderDrawer('ca-2025-ab1093', dossier({ jurisdiction: 'ca' }));
    const link = await evidenceLink();
    const url = new URL(link.href, 'http://test');
    expect(url.searchParams.get('jurisdiction')).toMatch(/^[A-Z]{2}$/);
  });

  it('preserves client and folder params alongside the corrected scope', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url?.includes?.('/dossier')) return Promise.resolve({ data: dossier({}) });
      return Promise.resolve({ data: { hearings: [] } });
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          null,
          createElement(Bill360Drawer, {
            billId: 'ca-2025-ab1093',
            clientId: 'client-9',
            folderId: 'folder-7',
            onClose: () => {},
            onOpenFull: () => {},
          }),
        ),
      ),
    );
    const link = await evidenceLink();
    const url = new URL(link.href, 'http://test');
    expect(url.searchParams.get('jurisdiction')).toBe('CA');
    expect(url.searchParams.get('client')).toBe('client-9');
    expect(url.searchParams.get('folder')).toBe('folder-7');
  });
});
