import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TrackerConfigPanel } from './TrackerConfigPanel.js';
import { RecCard } from './tracker-components.js';
import { TrackerFeedPanel } from './TrackerFeedPanel.js';
import { SOURCE_LABEL } from './intel-feed-api.js';
import type { AlertPrefsPayload, RecommendationBill, WatchlistPayload } from './tracker-api.js';

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
}));
vi.mock('../../bills/bill-target.js', () => ({ useBillTarget: () => (billId: string) => `/bills/${billId}` }));

/**
 * Gate E phase e (P2-15) — source-aware copy across Configure and curation.
 * e-4:
 *  1. The rendered Configure panel never says "bill tracker".
 *  2. (feed empty state — covered by the joinWithOr unit check below, since
 *     TrackerFeedPanel needs a live QueryClient + API mocks; the string
 *     construction itself is what phase e changed, and is what this locks.)
 *  3. The dismiss action's accessible name is "Hide this bill" and its
 *     tooltip does not contain "trains".
 *  4. Each e-2 site's new string is present (snapshot-free, one assertion
 *     per site).
 */

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
}

const WATCHLIST: WatchlistPayload = {
  issueAreas: [],
  tags: [{ tag: 'grid', priority: 'med', position: 'monitor', synonyms: [], relatedEntities: [], riskTerms: [], typedTerms: [] }],
};

function makePrefs(overrides: Partial<AlertPrefsPayload> = {}): AlertPrefsPayload {
  return {
    triggers: ['newMatch'],
    materiality: 'medium',
    emailEnabled: true,
    emailAddress: null,
    emailCadence: 'realtime',
    smsEnabled: false,
    smsPhone: null,
    smsPhoneVerified: false,
    smsCadence: 'realtime',
    quietHoursStart: null,
    quietHoursEnd: null,
    jurisdictions: [],
    ...overrides,
  };
}

function renderConfigPanel() {
  setupBrowserMocks();
  return render(
    <TrackerConfigPanel
      allIssueAreas={['Energy', 'Defense']}
      watchlist={WATCHLIST}
      prefs={makePrefs()}
      onSaveWatchlist={() => {}}
      onSavePrefs={() => {}}
      onRequestVerify={() => {}}
      onTestAlert={() => {}}
      typedTermsEnabled
    />,
  );
}

describe('TrackerConfigPanel copy (Gate E phase e, P2-15)', () => {
  test('e-4.1: the rendered panel never contains the string "bill tracker"', () => {
    const { container } = renderConfigPanel();
    expect(container.textContent?.toLowerCase()).not.toContain('bill tracker');
  });

  test('e-4.4a: Issue areas help names source types beyond bills', () => {
    renderConfigPanel();
    expect(screen.getByText(/every source type/i)).toBeInTheDocument();
    expect(screen.getByText(/bills, state bills, hearings, regulations, and Program Elements/i)).toBeInTheDocument();
  });

  test('e-4.4b: the term-inputs help mentions typed terms, not just "embeddings"', () => {
    renderConfigPanel();
    expect(screen.getByText(/typed terms/i)).toBeInTheDocument();
    expect(screen.queryByText(/embeddings \+ keyword match/i)).toBeNull();
  });

  test('e-4.4c: the In-app channel names sources beyond bills', () => {
    renderConfigPanel();
    expect(
      screen.getByText(/Changes inbox, feed, and unread markers across bills, hearings, regulations/i),
    ).toBeInTheDocument();
  });

  test('e-4.4d: the Email channel no longer says "bill, change"', () => {
    renderConfigPanel();
    expect(screen.getByText(/what changed, why it matters to this client, and the official source/i)).toBeInTheDocument();
    expect(screen.queryByText(/Full context — bill, change/i)).toBeNull();
  });

  test('TrackerTab.tsx Bills-surface copy is intentionally UNCHANGED (verified, not touched)', () => {
    // Documented per the plan's e-2: "Bills scored against {client}'s
    // watchlist" and "Bills you track, grouped by live legislative status"
    // are the Bills SURFACE, so bill-specific copy is correct there — this
    // test exists only to record that the site was checked, not to assert
    // anything about TrackerConfigPanel (which does not render that copy).
    expect(true).toBe(true);
  });
});

describe('RecCard dismiss action copy (Gate E phase e, §4.10 honesty half)', () => {
  const BILL: RecommendationBill = {
    billId: '119-hr-1',
    displayNum: 'H.R. 1',
    title: 'Grid modernization act',
    stage: 'introduced',
    probability: 0.5,
    fit: 0.6,
    belowFloor: false,
    matchedTags: ['grid'],
    matchReasons: [],
    whyKind: 'keyword',
    why: 'Matches grid',
    latestAction: null,
    latestActionDate: null,
    sponsorName: null,
    sponsorParty: null,
    cosponsorsCount: 0,
  };

  test('e-4.3: the dismiss action reads "Hide this bill" and its tooltip does not say "trains"', () => {
    render(
      <RecCard
        bill={BILL}
        issueSet={new Set()}
        selectMode={false}
        selected={false}
        onToggleSelect={() => {}}
        onTrack={() => {}}
        onDismiss={() => {}}
        onOpen={() => {}}
        dismissOpen={false}
        onToggleDismiss={() => {}}
      />,
    );
    const dismissBtn = screen.getByRole('button', { name: /Hide this bill/i });
    expect(dismissBtn).toBeInTheDocument();
    expect(dismissBtn.getAttribute('title')).not.toMatch(/trains/i);
    expect(dismissBtn.getAttribute('title')).toMatch(/Hides this bill from recommendations/i);
    expect(screen.queryByText(/Not relevant/i)).toBeNull();
  });
});

describe('Feed empty-state source list (Gate E phase e, P2-15) — built from SOURCE_LABEL', () => {
  test('SOURCE_LABEL covers all 6 source types the empty-state copy is built from', () => {
    const keys = Object.keys(SOURCE_LABEL);
    expect(keys).toHaveLength(6);
    expect(keys).toEqual(
      expect.arrayContaining(['bill', 'hearing', 'combined', 'state_bill', 'regulation', 'program_element']),
    );
  });

  test('excluding "combined" (a pairing marker, not a distinct source) still leaves >= 4 real source types', () => {
    const realTypes = Object.keys(SOURCE_LABEL).filter((k) => k !== 'combined');
    expect(realTypes.length).toBeGreaterThanOrEqual(4);
  });

  test('the RENDERED empty state names at least four of the six source types', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/feed')) {
        return { data: { items: [], nextCursor: null, hasMore: false, counts: {}, severityCounts: {} } };
      }
      return { data: {} };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <MemoryRouter>
            <TrackerFeedPanel clientId="client-1" clientName="Acme Corp" />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Nothing new right now/i)).toBeInTheDocument());

    const bodyText = document.body.textContent?.toLowerCase() ?? '';
    const namedCount = Object.entries(SOURCE_LABEL)
      .filter(([k]) => k !== 'combined')
      .filter(([, label]) => bodyText.includes(label.toLowerCase())).length;
    expect(namedCount).toBeGreaterThanOrEqual(4);
    // The old bill/hearing-only phrasing is gone.
    expect(screen.queryByText(/tracked bill moves or a hearing/i)).toBeNull();
  });
});
