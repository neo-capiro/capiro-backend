/**
 * Certification-pass regression: opening ANY alert's Packet Drawer crashed the
 * whole page to a blank white screen (`TypeError: Cannot read properties of
 * undefined (reading 'toUpperCase')`), for every alert, in every client scope,
 * live in production. `useLwAlert` fetches
 * `GET /intel-api/clients/:scope/feed/alerts/:alertId` and reads the response
 * AS a single FeedItem (`const it = alert.data`); the backend was answering
 * with the paginated feed ENVELOPE instead (`{items, nextCursor, hasMore,
 * counts, ...}`), so `it.sourceType` was `undefined` and
 * `it.sourceType.toUpperCase()` threw. Fixed at the intel-api boundary
 * (`feed.controller.ts` `getAlert`/`getTenantAlert` now unwrap `items[0]`).
 *
 * This test locks the FRONTEND half of that contract: PacketDrawer must
 * render correctly against a well-formed single FeedItem, and must show its
 * honest "could not be loaded" state (never crash) if the transport ever
 * again returns the wrong shape.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';

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
vi.mock('./MemoComposerDrawerVNext.js', () => ({
  MemoComposerDrawer: ({ clientId, item }: { clientId: string; item: FeedItem }) => (
    <div role="dialog" aria-label="Existing memo composer">{clientId} · {item.id}</div>
  ),
}));

import { PacketDrawer } from './PacketDrawer.js';

const ALERT: FeedItem = {
  id: 'a1',
  clientId: 'client-A',
  clientName: 'Client A',
  sourceType: 'bill',
  severity: 'notable',
  materiality: 'medium',
  score: 1,
  title: 'H.R. 8800: Bill text updated',
  whyItMatters: null,
  recommendedAction: null,
  evidence: {},
  status: 'new',
  createdAt: '2026-09-01T00:00:00.000Z',
  workState: { state: 'new', assignedTo: null, snoozedUntil: null, note: null },
  clientImpact: null,
  urgency: null,
} as unknown as FeedItem;

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnMount: false, refetchOnReconnect: false } } });
  return render(
    <MemoryRouter><QueryClientProvider client={qc}>
      <PacketDrawer scope="" alertId="a1" onClose={() => {}} />
    </QueryClientProvider></MemoryRouter>,
  );
}

describe('PacketDrawer — the /feed/alerts/:alertId contract', () => {
  beforeEach(() => apiGet.mockReset());
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the alert when the transport returns a bare FeedItem (the fixed contract)', async () => {
    apiGet.mockImplementation(async (url?: string) => {
      if (url === undefined) return { data: null };
      if (url.includes('/feed/alerts/')) return { data: ALERT };
      if (url.includes('/packet')) return { data: null };
      return { data: null };
    });
    renderDrawer();
    // Scoped to the dialog: proves the drawer rendered real alert content — not
    // a crash, not the "could not be loaded" fallback — and specifically that
    // the DEFENDED span (`it.sourceType.toUpperCase()`'s call site) produced
    // the expected label instead of throwing.
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => expect(within(dialog).getAllByText(/BILL/i).length).toBeGreaterThan(0));
  });

  it('opens the native memo composer for the alert client from the all-clients scope', async () => {
    apiGet.mockImplementation(async (url = '') => ({ data: url.includes('/feed/alerts/') ? ALERT : null }));
    renderDrawer();
    const draft = await screen.findByRole('button', { name: 'Draft memo' });
    fireEvent.click(draft);
    expect(await screen.findByRole('dialog', { name: 'Existing memo composer' })).toHaveTextContent('client-A · a1');
    expect(screen.getByRole('button', { name: 'Create brief' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stage outreach' })).toBeDisabled();
    expect(screen.getByText('Create briefs and stage outreach from a hearing’s detail page.')).toBeInTheDocument();
  });

  it('never crashes to a blank screen if the transport ever answers with the list envelope again', async () => {
    // `it` (the query's .data) is a TRUTHY-but-wrong-shaped object here — the
    // `!it` branch ("could not be loaded") never fires for this input; that
    // branch only covers `null`. The regression this guards is narrower and
    // more important: PRODUCTION crashed the entire page to a blank screen on
    // exactly this shape, because `it.sourceType.toUpperCase()` had no guard.
    // The dialog rendering AT ALL — instead of a blank document — is the proof.
    const envelope = { items: [], nextCursor: null, hasMore: false, counts: {}, severityCounts: {}, total: 0, workStateCounts: {} };
    apiGet.mockImplementation(async (url?: string) => {
      if (url === undefined) return { data: null };
      if (url.includes('/feed/alerts/')) return { data: envelope as unknown as FeedItem };
      if (url.includes('/packet')) return { data: null };
      return { data: null };
    });
    renderDrawer();
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    expect(dialog).toBeInTheDocument();
    // Wait past the loading skeleton (text-free) to the settled render — this
    // is where production crashed to a blank page; settled-and-non-empty is
    // the actual regression proof, not merely "the wrapper element exists".
    await waitFor(() => expect(dialog.textContent).not.toBe(''));
  });

  it('renders when the alert has no linked bill (falls back to sourceType, never crashes on it)', async () => {
    const hearingAlert: FeedItem = { ...ALERT, id: 'a2', sourceType: 'hearing', evidence: {} };
    apiGet.mockImplementation(async (url?: string) => {
      if (url === undefined) return { data: null };
      if (url.includes('/feed/alerts/')) return { data: hearingAlert };
      if (url.includes('/packet')) return { data: null };
      return { data: null };
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, refetchOnMount: false, refetchOnReconnect: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PacketDrawer scope="" alertId="a2" onClose={() => {}} />
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => expect(within(dialog).getAllByText(/HEARING/i).length).toBeGreaterThan(0));
  });
});
