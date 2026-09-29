/**
 * Feed-band truthfulness — the production defect: ordinary federal bill
 * changes (H.R.2102 "Bill text updated", H.R.8800 "Bill text updated",
 * S.4784 "New matched bill") rendered as DEADLINE in the feed and the packet
 * drawer. The FeedItem DTO carries no deadline semantics, so the band must
 * name the real kind. These tests render the actual FeedTab rows and the
 * actual PacketDrawer against realistic bill_text_changed / bill_new_match
 * payloads and assert the corrected label, its tone class, the preserved
 * critical-severity path, and the neutral unknown-source fallback.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem, FeedResponse } from '../../../../pages/clients/tracker/intel-feed-api.js';

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
  MemoComposerDrawer: () => <div role="dialog" aria-label="Existing memo composer" />,
}));

import { FeedTab } from './FeedTab.js';
import { PacketDrawer } from './PacketDrawer.js';

function billItem(id: string, over: Partial<FeedItem>): FeedItem {
  return {
    id,
    clientId: 'client-A',
    clientName: 'Client A',
    sourceType: 'bill',
    kind: 'bill_text_changed',
    severity: 'notable',
    materiality: 'medium',
    score: 0.5,
    clientImpact: null,
    urgency: null,
    title: id,
    whyItMatters: null,
    recommendedAction: null,
    evidence: {},
    status: 'new',
    createdAt: '2026-09-01T00:00:00.000Z',
    workState: { state: 'new', assignedTo: null, snoozedUntil: null, note: null },
    ...over,
  } as FeedItem;
}

const TEXT_UPDATED = billItem('a-hr2102', {
  title: 'H.R.2102: Bill text updated',
  kind: 'bill_text_changed',
  severity: 'notable',
  evidence: {
    bill: {
      billId: 'hr2102-119',
      displayNum: 'H.R.2102',
      title: null,
      url: null,
      stage: 'introduced',
      actionText: null,
      actionDate: null,
      jurisdiction: 'US',
    },
  },
});
const NEW_MATCH = billItem('a-s4784', {
  title: 'S.4784: New matched bill',
  kind: 'bill_new_match',
  severity: 'info',
  evidence: {
    bill: {
      billId: 's4784-119',
      displayNum: 'S.4784',
      title: null,
      url: null,
      stage: 'introduced',
      actionText: null,
      actionDate: null,
      jurisdiction: 'US',
    },
  },
});

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

function qc() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderFeed(items: FeedItem[]) {
  apiGet.mockImplementation((url = '') => {
    if (url.startsWith('/intel-api/clients/_all/feed?'))
      return Promise.resolve({ data: feedOf(items) });
    return Promise.resolve({ data: null });
  });
  return render(
    <QueryClientProvider client={qc()}>
      <MemoryRouter initialEntries={['/legiwatch?tab=feed']}>
        <FeedTab scope="" clients={[]} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDrawer(alert: FeedItem) {
  apiGet.mockImplementation((url = '') => {
    if (url.includes('/feed/alerts/')) return Promise.resolve({ data: alert });
    return Promise.resolve({ data: null });
  });
  return render(
    <QueryClientProvider client={qc()}>
      <PacketDrawer scope="" alertId={alert.id} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/** The band pill is the one carrying the lw-pill--<tone> class inside the
 *  row's meta line (the work-state pill lives in the row's side column). */
function bandPillFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest('.lw-prow');
  expect(row, `row for ${title}`).not.toBeNull();
  return row!.querySelector('.lw-prow__meta .lw-pill') as HTMLElement;
}

beforeEach(() => apiGet.mockReset());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Feed rows — federal bill changes are labelled BILL, never DEADLINE', () => {
  it('labels bill_text_updated and bill_new_match rows as BILL with the neutral tone', async () => {
    renderFeed([TEXT_UPDATED, NEW_MATCH]);
    await screen.findByText('H.R.2102: Bill text updated');

    const textPill = bandPillFor('H.R.2102: Bill text updated');
    expect(textPill).toHaveTextContent('BILL');
    expect(textPill).not.toHaveTextContent('DEADLINE');
    expect(textPill.className).toContain('lw-pill--gray');

    const matchPill = bandPillFor('S.4784: New matched bill');
    expect(matchPill).toHaveTextContent('BILL');
    expect(matchPill.className).toContain('lw-pill--gray');

    expect(screen.queryByText('DEADLINE')).toBeNull();
  });

  it('leads rows with the item title, observed change, age, and client', async () => {
    renderFeed([billItem('a-clear', {
      title: 'H.R.2102: Existing item title',
      clientName: 'Client A',
      evidence: { bill: { billId: 'hr2102-119', displayNum: 'H.R.2102', title: 'Existing item title', url: null, stage: 'introduced', actionText: 'Official text updated', actionDate: null, jurisdiction: 'US' } },
    })]);
    const title = await screen.findByText('Existing item title');
    const row = title.closest('.lw-prow') as HTMLElement;
    expect(within(row).getByText('Official text updated')).toBeInTheDocument();
    expect(within(row).getByText('Client A')).toBeInTheDocument();
    expect(within(row).getByText(/^(?:now|\d+[mhd])$/)).toBeInTheDocument();
  });

  it('keeps a critical-severity bill alert as CRITICAL with the error tone', async () => {
    renderFeed([
      billItem('a-crit', { title: 'H.R.8800: Bill text updated', severity: 'critical' }),
    ]);
    await screen.findByText('H.R.8800: Bill text updated');
    const pill = bandPillFor('H.R.8800: Bill text updated');
    expect(pill).toHaveTextContent('CRITICAL');
    expect(pill.className).toContain('lw-pill--error');
  });

  it('keeps the truthful STATE BILL mapping', async () => {
    renderFeed([
      billItem('a-state', {
        title: 'CA AB 123: Status changed',
        sourceType: 'state_bill',
        evidence: {},
      }),
    ]);
    await screen.findByText('CA AB 123: Status changed');
    expect(bandPillFor('CA AB 123: Status changed')).toHaveTextContent('STATE BILL');
  });

  it('labels an unknown future sourceType as the neutral UPDATE, never a deadline', async () => {
    renderFeed([
      billItem('a-future', {
        title: 'Some future source row',
        sourceType: 'court_filing' as unknown as FeedItem['sourceType'],
        evidence: {},
      }),
    ]);
    await screen.findByText('Some future source row');
    const pill = bandPillFor('Some future source row');
    expect(pill).toHaveTextContent('UPDATE');
    expect(pill).not.toHaveTextContent('DEADLINE');
    expect(pill.className).toContain('lw-pill--gray');
  });
});

describe('Packet drawer — same truthful band as the feed row', () => {
  it('shows BILL (never DEADLINE) for a bill_text_updated packet', async () => {
    renderDrawer(TEXT_UPDATED);
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      const head = dialog.querySelector('.lw-drawer__head');
      expect(head).not.toBeNull();
      expect(within(head as HTMLElement).getByText('BILL')).toBeInTheDocument();
    });
    const head = dialog.querySelector('.lw-drawer__head') as HTMLElement;
    expect(within(head).queryByText('DEADLINE')).toBeNull();
    expect(within(head).getByText('BILL').closest('.lw-pill')!.className).toContain(
      'lw-pill--gray',
    );
  });

  it('shows BILL for a bill_new_match packet', async () => {
    renderDrawer(NEW_MATCH);
    const dialog = await screen.findByRole('dialog', { name: 'Alert packet' });
    await waitFor(() => {
      const head = dialog.querySelector('.lw-drawer__head');
      expect(head).not.toBeNull();
      expect(within(head as HTMLElement).getByText('BILL')).toBeInTheDocument();
    });
    const head = dialog.querySelector('.lw-drawer__head') as HTMLElement;
    expect(within(head).queryByText('DEADLINE')).toBeNull();
  });
});
