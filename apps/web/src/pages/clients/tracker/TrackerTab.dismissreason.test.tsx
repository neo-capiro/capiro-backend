import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { RecCard } from './tracker-components.js';
import { TrackerSurface } from './TrackerTab.js';
import type { RecommendationBill } from './tracker-api.js';

/**
 * §4.10 (Gate E phase f, f-1/f-7 case 7) — the dismiss control became a
 * structured reason picker instead of an immediate one-click hide. Two
 * levels: RecCard's own menu contract (direct render, mirrors the existing
 * legiwatch-copy.test.tsx e-4.3 style), and the actual wire payload
 * TrackerTab's dismissMutation sends once a reason is picked.
 */

const BILL: RecommendationBill = {
  billId: '119-hr-1',
  displayNum: 'H.R. 1',
  title: 'Grid modernization act',
  stage: 'introduced',
  probability: 0.5,
  fit: 0.6,
  belowFloor: false,
  matchedTags: ['grid', 'permitting'],
  matchReasons: [],
  whyKind: 'keyword',
  why: 'Matches grid',
  latestAction: null,
  latestActionDate: null,
  sponsorName: null,
  sponsorParty: null,
  cosponsorsCount: 0,
};

/** A thin wrapper: RecCard's dismiss-menu open state is CONTROLLED by the
 *  parent (lifted to TrackerTab's shared `menu` state in the real app) —
 *  this stands in for that parent. */
function RecCardHarness({ onDismiss }: { onDismiss: (billId: string, reason: string | null, matchedTags: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <RecCard
      bill={BILL}
      issueSet={new Set()}
      selectMode={false}
      selected={false}
      onToggleSelect={() => {}}
      onTrack={() => {}}
      onDismiss={onDismiss}
      onOpen={() => {}}
      dismissOpen={open}
      onToggleDismiss={() => setOpen((o) => !o)}
    />
  );
}

describe('RecCard dismiss-reason menu (f-1)', () => {
  test('offers all five structured reasons plus "Just hide it", closed by default', () => {
    render(<RecCardHarness onDismiss={() => {}} />);
    expect(screen.queryByRole('menuitem', { name: 'Wrong issue' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Hide this bill/i }));

    expect(screen.getByRole('menuitem', { name: 'Wrong issue' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Wrong entity' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Too broad' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Already handled' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Not actionable' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Just hide it' })).toBeInTheDocument();
  });

  test('selecting a structured reason sends it, along with this card\'s matchedTags', () => {
    const onDismiss = vi.fn();
    render(<RecCardHarness onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /Hide this bill/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Too broad' }));
    expect(onDismiss).toHaveBeenCalledWith('119-hr-1', 'too_broad', ['grid', 'permitting']);
  });

  test('"Just hide it" sends a null reason (still carrying matchedTags)', () => {
    const onDismiss = vi.fn();
    render(<RecCardHarness onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /Hide this bill/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Just hide it' }));
    expect(onDismiss).toHaveBeenCalledWith('119-hr-1', null, ['grid', 'permitting']);
  });
});

const apiGetMock = vi.fn();
const apiPostMock = vi.fn(async (_url: string, _body?: unknown) => ({ data: { ok: true } }));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, put: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
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
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
}

function intelRec(over: Record<string, unknown> = {}) {
  return {
    billId: '119-hr-1',
    displayNum: 'H.R. 1',
    title: 'Grid modernization act',
    stage: 'introduced',
    passageProbability: 0.6,
    latestActionText: null,
    latestActionDate: null,
    sponsorName: null,
    sponsorParty: null,
    cosponsorsCount: 0,
    fit: 0.6,
    matchedTags: ['grid'],
    why: 'Matches grid',
    whyKind: 'keyword',
    matchReasons: [],
    ...over,
  };
}

function renderSurface() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <TrackerSurface clientId="client-1" clientName="Acme Corp" variant="bills" />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('TrackerSurface dismissMutation wire payload (f-1/f-2)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockClear();
    setupBrowserMocks();
  });

  test('picking a reason POSTs targetRef/signal/reason/matchedTags to the intel-api feedback endpoint', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { data: { role: 'capiro_admin' } };
      if (url.includes('/feature-flags')) return { data: { tracker_v2: true } };
      if (url.endsWith('/board')) return { data: { columns: [{ id: 'introduced', label: 'Introduced', cards: [] }] } };
      if (url.endsWith('/recommendations')) return { data: [intelRec()] };
      if (url.endsWith('/issue-areas')) return { data: { issueAreas: [] } };
      if (url.includes('watchlist')) return { data: { issueAreas: [], tags: [] } };
      return { data: {} };
    });
    renderSurface();

    // variant="bills" renders Recommendations directly (no panel-switch tab —
    // confirmed via TrackerTab.highfit.test.tsx / TrackerTab.pagination.test.tsx,
    // which reach board/rec content the same way, with no tab click).
    await waitFor(() => expect(screen.getByText('Grid modernization act')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Hide this bill/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Too broad' }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const [url, body] = apiPostMock.mock.calls[0]!;
    expect(String(url)).toContain('/tracker/feedback');
    expect(body).toEqual({
      targetRef: '119-hr-1',
      signal: 'marked_irrelevant',
      reason: 'too_broad',
      matchedTags: ['grid'],
    });
  });
});
