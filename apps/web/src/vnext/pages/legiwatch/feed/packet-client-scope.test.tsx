/**
 * Packet client-scope regression (2026-09-15 production defect):
 *
 * Under the All-clients lens, opening a real federal bill alert rendered "no
 * linked official record was returned" even though the same alert under its
 * owning client lens showed three OFFICIAL facts. Root cause chain, verified
 * against the live local API (TASK/packet-all-scope-diagnosis):
 *   - `_all/feed/alerts/:id` → 200 and resolves the OWNING clientId;
 *   - `_all/alerts/:id/packet` → 404 "Client not found" (there is NO `_all`
 *     packet route — the backend packet contract is per owning client only);
 *   - the drawer fired `useLwPacket(rawScope, alertId)` before the alert read
 *     resolved the owner, and the hook caught every error to null, so the
 *     guaranteed 404 was rendered as absence-of-evidence.
 *
 * These tests lock the corrected request identity:
 *   1. All-clients scope: NO packet request before the alert read resolves
 *      the owning client; then exactly one request to the OWNER's route, never
 *      `_all/alerts/.../packet`.
 *   2. Explicit matching client lens: same owner route.
 *   3. Switching alerts: a late response for the previous alert/owner pair
 *      cannot surface as the next alert's packet.
 *   4. A genuine 404 keeps the honest absence copy (no invented evidence, no
 *      failure claim).
 *   5. A transport failure is rendered as an explicit request failure, never
 *      as "no official evidence".
 *   6. A client lens that is not the alert's owner requests nothing and says
 *      so — a foreign client's packet must not leak through a lens URL.
 *   7. Feed rows under a client lens name the selected client when (and only
 *      when) the row's owner id matches it; anything else stays truthfully
 *      "Historical client".
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem, FeedResponse } from '../../../../pages/clients/tracker/intel-feed-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'test-token', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string) => apiGet(url),
    post: vi.fn().mockResolvedValue({ data: { ok: true } }),
  }),
}));
vi.mock('../../../../pages/clients/tracker/MemoComposerDrawer.js', () => ({
  MemoComposerDrawer: () => <div role="dialog" aria-label="Existing memo composer" />,
}));

import { PacketDrawer } from './PacketDrawer.js';
import { FeedTab } from './FeedTab.js';

const OWNER = 'client-A';
const OTHER = 'client-B';

function alertItem(id: string, clientId: string, title: string): FeedItem {
  return {
    id,
    clientId,
    sourceType: 'bill',
    kind: 'bill_text_changed',
    severity: 'notable',
    materiality: 'medium',
    score: 0.5,
    title,
    whyItMatters: null,
    recommendedAction: null,
    evidence: { bill: { displayNum: 'H.R.2102', billId: 'hr2102-119', jurisdiction: 'US' } },
    status: 'new',
    createdAt: '2026-09-01T00:00:00.000Z',
    workState: { state: 'new', assignedTo: null, snoozedUntil: null, note: null },
    clientImpact: null,
    urgency: null,
  } as unknown as FeedItem;
}

const ALERT_A = alertItem('a1', OWNER, 'H.R.2102: Bill text updated');
const ALERT_B = alertItem('b1', OTHER, 'S.2888: Bill text updated');

function packet(evidenceText: string, claimId = 'c1') {
  return {
    event: { sourceType: 'bill', whatChanged: 'x', occurredAt: '2026-09-15' },
    officialEvidence: [
      {
        claimId,
        text: evidenceText,
        sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/2102',
        retrievedAt: '2026-09-15',
        verification: 'official',
      },
    ],
    proceduralMeaning: { currentStage: 'not established', nextPossibleSteps: [], uncertainty: [] },
    confidence: { relevance: 0.4, procedural: 0, evidenceCoverage: 0.71, missingFields: [] },
  };
}

const PACKET_A = packet('Bill: H.R.2102 — official text', 'ca');
const PACKET_B = packet('Bill: S.2888 — official text', 'cb');

function axios404() {
  return new axios.AxiosError('Not Found', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 404,
  } as never);
}

function axiosNetworkError() {
  return new axios.AxiosError('Network Error', 'ERR_NETWORK');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function qc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

function renderDrawer(scope: string, alertId: string, client?: QueryClient) {
  return render(
    <QueryClientProvider client={client ?? qc()}>
      <PacketDrawer scope={scope} alertId={alertId} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

function packetCalls(): string[] {
  return apiGet.mock.calls.map(([url]) => url).filter((u) => u.includes('/packet'));
}

beforeEach(() => apiGet.mockReset());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PacketDrawer — packet request identity', () => {
  it('holds the packet read until the alert resolves the owner; never requests _all/alerts (premature-request guard)', async () => {
    const alertDeferred = deferred<{ data: unknown }>();
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return alertDeferred.promise;
      return Promise.resolve({ data: null });
    });
    renderDrawer('', 'a1');
    // Drawer mounted, alert read in flight: NO packet request yet — the owner
    // is unresolved and `_all` is never a valid packet client.
    await screen.findByRole('dialog', { name: 'Alert packet' });
    expect(packetCalls()).toHaveLength(0);
    expect(apiGet.mock.calls.some(([u]) => u.endsWith('/alerts/a1/packet'))).toBe(false);

    alertDeferred.resolve({ data: ALERT_A });
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(`/intel-api/clients/${OWNER}/alerts/a1/packet`);
    });
    expect(apiGet.mock.calls.some(([u]) => u.includes('/clients/_all/alerts/'))).toBe(false);
  });

  it('renders the owning client official evidence under All clients (the production defect)', async () => {
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return Promise.resolve({ data: ALERT_A });
      if (url.includes(`/clients/${OWNER}/alerts/a1/packet`))
        return Promise.resolve({ data: PACKET_A });
      return Promise.resolve({ data: null });
    });
    renderDrawer('', 'a1');
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      expect(within(dialog).getByText('Bill: H.R.2102 — official text')).toBeInTheDocument();
    });
    const link = within(dialog).getByText('Source record →');
    expect(link).toHaveAttribute(
      'href',
      'https://www.congress.gov/bill/119th-congress/house-bill/2102',
    );
    // The false absence copy must never appear while real evidence is present.
    expect(within(dialog).queryByText(/no linked official record was returned/i)).toBeNull();
  });

  it('uses the same owner route under an explicit matching client lens', async () => {
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return Promise.resolve({ data: ALERT_A });
      if (url.includes(`/clients/${OWNER}/alerts/a1/packet`))
        return Promise.resolve({ data: PACKET_A });
      return Promise.resolve({ data: null });
    });
    renderDrawer(OWNER, 'a1');
    await screen.findByText('Bill: H.R.2102 — official text');
    expect(apiGet).toHaveBeenCalledWith(`/intel-api/clients/${OWNER}/feed/alerts/a1`);
    expect(apiGet).toHaveBeenCalledWith(`/intel-api/clients/${OWNER}/alerts/a1/packet`);
  });

  it('a late response for the previous alert cannot surface as the next alert packet (switch guard)', async () => {
    const client = qc();
    const heldPacket = deferred<{ data: unknown }>();
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/a1')) return Promise.resolve({ data: ALERT_A });
      if (url.includes('/feed/alerts/b1')) return Promise.resolve({ data: ALERT_B });
      if (url.includes(`/clients/${OWNER}/alerts/a1/packet`)) return heldPacket.promise;
      if (url.includes(`/clients/${OTHER}/alerts/b1/packet`))
        return Promise.resolve({ data: PACKET_B });
      return Promise.resolve({ data: null });
    });

    const first = renderDrawer('', 'a1', client);
    await waitFor(() => expect(packetCalls()).toHaveLength(1));
    first.unmount();

    // Open the second alert while the FIRST packet response is still in flight.
    renderDrawer('', 'b1', client);
    await screen.findByText('Bill: S.2888 — official text');
    expect(screen.queryByText('Bill: H.R.2102 — official text')).toBeNull();

    // The stale first response finally lands — it must not replace or leak into
    // the current drawer's evidence.
    heldPacket.resolve({ data: PACKET_A });
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByText('Bill: H.R.2102 — official text')).toBeNull();
    expect(screen.getByText('Bill: S.2888 — official text')).toBeInTheDocument();
    expect(packetCalls()).toEqual([
      `/intel-api/clients/${OWNER}/alerts/a1/packet`,
      `/intel-api/clients/${OTHER}/alerts/b1/packet`,
    ]);
  });

  it('keeps the honest absence copy for a real 404 (no invented evidence, no failure claim)', async () => {
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return Promise.resolve({ data: ALERT_A });
      if (url.includes('/packet')) return Promise.reject(axios404());
      return Promise.resolve({ data: null });
    });
    renderDrawer('', 'a1');
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      expect(
        within(dialog).getByText(/no linked official record was returned/i),
      ).toBeInTheDocument();
    });
    expect(within(dialog).queryByText(/packet request failed/i)).toBeNull();
    expect(within(dialog).queryByText('Source record →')).toBeNull();
  });

  it('renders an explicit request failure for a transport error — never absence-of-evidence', async () => {
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return Promise.resolve({ data: ALERT_A });
      if (url.includes('/packet')) return Promise.reject(axiosNetworkError());
      return Promise.resolve({ data: null });
    });
    renderDrawer('', 'a1');
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      expect(
        within(dialog).getByText(/official evidence could not be loaded/i),
      ).toBeInTheDocument();
    });
    expect(within(dialog).queryByText(/no linked official record was returned/i)).toBeNull();
    expect(within(dialog).queryByText('Source record →')).toBeNull();
  });

  it('a lens that is not the alert owner requests no packet and leaks no foreign evidence', async () => {
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return Promise.resolve({ data: ALERT_A });
      return Promise.resolve({ data: null });
    });
    // scope=OTHER, alert owned by OWNER → no packet request may be issued at all.
    renderDrawer(OTHER, 'a1');
    await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      expect(
        within(screen.getByRole('dialog', { name: 'Alert packet' })).getByText(
          /different client than the selected view/i,
        ),
      ).toBeInTheDocument();
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(packetCalls()).toHaveLength(0);
    expect(screen.queryByText('Source record →')).toBeNull();
  });

  it('shows the packet-loading state, not absence copy, while the owner packet is in flight', async () => {
    const heldPacket = deferred<{ data: unknown }>();
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return Promise.resolve({ data: ALERT_A });
      if (url.includes('/packet')) return heldPacket.promise;
      return Promise.resolve({ data: null });
    });
    renderDrawer('', 'a1');
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      expect(within(dialog).getByText(/loading official evidence/i)).toBeInTheDocument();
    });
    expect(within(dialog).queryByText(/no linked official record was returned/i)).toBeNull();
    heldPacket.resolve({ data: PACKET_A });
    await screen.findByText('Bill: H.R.2102 — official text');
  });

  it('a cached packet cannot survive a same-key 404 (retained-cache regression)', async () => {
    // React Query keeps the last successful data in cache when a same-key
    // refetch fails. The first read succeeds; the cache is then invalidated so
    // the same owner/alert key refetches and 404s. The drawer must fall back
    // to the honest absence copy — the stale official evidence, procedural
    // meaning, and confidence must NOT remain presented as current.
    const client = qc();
    let packetFails = false;
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return Promise.resolve({ data: ALERT_A });
      if (url.includes('/packet')) {
        return packetFails ? Promise.reject(axios404()) : Promise.resolve({ data: PACKET_A });
      }
      return Promise.resolve({ data: null });
    });
    const first = renderDrawer('', 'a1', client);
    await screen.findByText('Bill: H.R.2102 — official text');
    first.unmount();

    // Same owner+alert key: cached packet exists, now the refetch 404s.
    packetFails = true;
    client.invalidateQueries({ queryKey: ['lw-vnext', 'packet', OWNER, 'a1'] });
    renderDrawer('', 'a1', client);
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      expect(
        within(dialog).getByText(/no linked official record was returned/i),
      ).toBeInTheDocument();
    });
    expect(within(dialog).queryByText('Bill: H.R.2102 — official text')).toBeNull();
    expect(within(dialog).queryByText('Source record →')).toBeNull();
    // Procedural meaning (unguarded before the fix — reads pk directly) and
    // confidence must not survive the failed current read. A real 404 keeps
    // the honest absence copy: Confidence says "Not provided", Unknowns says
    // "No explicit unknowns were recorded".
    expect(within(dialog).queryByText(/now at not established/i)).toBeNull();
    expect(within(dialog).queryByText(/relevance 0\.40/i)).toBeNull();
    expect(within(dialog).getByText('Not provided for this packet.')).toBeInTheDocument();
    expect(
      within(dialog).getByText('No explicit unknowns were recorded for this packet.'),
    ).toBeInTheDocument();
  });

  it('a cached packet cannot survive a same-key transport failure — explicit failure copy, not false absence', async () => {
    const client = qc();
    let packetFails = false;
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed/alerts/')) return Promise.resolve({ data: ALERT_A });
      if (url.includes('/packet')) {
        return packetFails
          ? Promise.reject(axiosNetworkError())
          : Promise.resolve({ data: PACKET_A });
      }
      return Promise.resolve({ data: null });
    });
    const first = renderDrawer('', 'a1', client);
    await screen.findByText('Bill: H.R.2102 — official text');
    first.unmount();

    packetFails = true;
    client.invalidateQueries({ queryKey: ['lw-vnext', 'packet', OWNER, 'a1'] });
    renderDrawer('', 'a1', client);
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      expect(
        within(dialog).getByText(/official evidence could not be loaded/i),
      ).toBeInTheDocument();
    });
    // The retained packet must be suppressed — and a transport failure must
    // never render as absence-of-evidence.
    expect(within(dialog).queryByText('Bill: H.R.2102 — official text')).toBeNull();
    expect(within(dialog).queryByText('Source record →')).toBeNull();
    expect(within(dialog).queryByText(/no linked official record was returned/i)).toBeNull();
    expect(within(dialog).getAllByText('Not loaded.')).toHaveLength(2);
  });
});

describe('Feed rows — client attribution under a client lens', () => {
  const selectedClient = { id: OWNER, name: 'L3Harris' } as unknown as Client;

  function feedOf(items: FeedItem[]): FeedResponse {
    return {
      items,
      nextCursor: null,
      hasMore: false,
      counts: { bill: items.length },
      total: items.length,
      workStateCounts: {
        new: items.length,
        in_review: 0,
        assigned: 0,
        actioned: 0,
        snoozed: 0,
        dismissed: 0,
      },
    };
  }

  function renderFeed(scope: string, clients: Client[], items: FeedItem[]) {
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed?') || url.endsWith('/feed'))
        return Promise.resolve({ data: feedOf(items) });
      return Promise.resolve({ data: null });
    });
    return render(
      <QueryClientProvider client={qc()}>
        <MemoryRouter initialEntries={['/legiwatch?tab=feed']}>
          <FeedTab scope={scope} clients={clients} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('names the selected client on its own rows when the scoped feed omits clientName (the production defect)', async () => {
    // Backend contract: a client-scoped feed deliberately returns clientName
    // null (feed.service.ts resolves names only on the tenant roll-up).
    const owned = alertItem('a1', OWNER, 'H.R.2102: Bill text updated');
    renderFeed(OWNER, [selectedClient], [owned]);
    await screen.findByText('H.R.2102: Bill text updated');
    expect(screen.getByText('L3Harris')).toBeInTheDocument();
    expect(screen.queryByText('Historical client')).toBeNull();
  });

  it('keeps "Historical client" for a row whose owner is a different, unresolved id', async () => {
    const foreign = alertItem('z9', 'client-deleted', 'H.R.999: Bill text updated');
    renderFeed(OWNER, [selectedClient], [foreign]);
    await screen.findByText('H.R.999: Bill text updated');
    expect(screen.getByText('Historical client')).toBeInTheDocument();
    expect(screen.queryByText('L3Harris')).toBeNull();
  });

  it('still prefers the server-resolved clientName on the All-clients feed', async () => {
    const named = {
      ...alertItem('a1', OWNER, 'H.R.2102: Bill text updated'),
      clientName: 'L3Harris',
    };
    renderFeed('', [], [named]);
    await screen.findByText('H.R.2102: Bill text updated');
    expect(screen.getByText('L3Harris')).toBeInTheDocument();
  });

  it('groups by the selected client name under the by-client arrangement', async () => {
    const owned = alertItem('a1', OWNER, 'H.R.2102: Bill text updated');
    apiGet.mockImplementation((url = '') => {
      if (url.includes('/feed?') || url.endsWith('/feed'))
        return Promise.resolve({ data: feedOf([owned]) });
      return Promise.resolve({ data: null });
    });
    render(
      <QueryClientProvider client={qc()}>
        <MemoryRouter initialEntries={['/legiwatch?tab=feed&arrange=byClient']}>
          <FeedTab scope={OWNER} clients={[selectedClient]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText('What changed grouped by client');
    await waitFor(() => {
      expect(screen.getByText('L3Harris', { selector: '.lw-history__label' })).toBeInTheDocument();
    });
    expect(screen.queryByText(OWNER, { selector: '.lw-history__label' })).toBeNull();
  });
});
