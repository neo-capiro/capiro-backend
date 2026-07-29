import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { TrackerFeedPanel } from './TrackerFeedPanel.js';
import type { FeedItem } from './intel-feed-api.js';

/**
 * Gate D phase c (P1-10, P1-11) — the feed card.
 *
 * P1-10: the API has always returned severity, whyItMatters, urgency and score,
 * and supported order=score with a covering index; the calm card rendered none
 * of it and hard-coded order='date'.
 *
 * P1-11: an `incomplete` chip rendered on EVERY alert, because toCanonicalAlert
 * hard-codes whoActs:'' and canonical completeness flagged it — with raw field
 * names in the tooltip. Case 5 is the lock that it never comes back.
 */

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
}));

vi.mock('../../bills/bill-target.js', () => ({
  useBillTarget: () => (billId: string) => `/bills/${billId}`,
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
}

function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'a1',
    clientId: 'c1',
    clientName: 'Acme Aerospace',
    sourceType: 'bill',
    kind: 'bill_change',
    severity: 'critical',
    materiality: 'high',
    score: 0.72,
    clientImpact: null,
    urgency: 'Action within 3 days',
    title: 'H.R. 1200 — Rule failed on the floor',
    whyItMatters: 'Acme’s grid-interconnection revenue rides on this title.',
    tag: 'grid',
    recommendedAction: null,
    evidence: {
      schemaVersion: 1,
      type: 'bill',
      bill: {
        billId: 'hr-1200-119',
        displayNum: 'H.R. 1200',
        title: 'A bill',
        url: 'https://congress.gov/bill/hr1200',
        stage: 'Rule failed',
        actionText: 'On agreeing to the resolution Failed by the Yeas and Nays: 198 - 224.',
        actionDate: '2026-03-09',
      },
      provenance: {
        sourceUrl: 'https://congress.gov/bill/hr1200',
        triggerKey: 'floorVote',
        tone: 'critical',
        band: 'High',
        jurisdiction: 'US',
        writerShape: 'bill-change-detector',
      },
    },
    status: 'new',
    createdAt: '2026-03-10T00:00:00.000Z',
    recommendedActions: [{ kind: 'draft_memo', label: 'Draft memo', primary: true }],
    actions: { inReport: false, talkingPoints: 0 },
    ...over,
  };
}

function feedPage(
  items: FeedItem[],
  opts: { nextCursor?: string | null; hasMore?: boolean } = {},
) {
  return {
    items,
    nextCursor: opts.nextCursor ?? null,
    hasMore: opts.hasMore ?? false,
    counts: { bill: items.length },
    severityCounts: { critical: items.length },
  };
}

/** Record every feed URL the panel requests. */
let feedUrls: string[] = [];

function mockApi(items: FeedItem[]) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/feed')) {
      feedUrls.push(url);
      return { data: feedPage(items) };
    }
    if (url.includes('/packet')) {
      return {
        data: {
          event: { sourceType: 'bill', whatChanged: 'x', canonicalStatus: null, occurredAt: null, effectiveAt: null },
          officialEvidence: [],
          proceduralMeaning: {
            currentStage: 'Rule failed',
            nextPossibleSteps: ['New rule from the Rules Committee'],
            blockedBy: ['The governing rule was rejected, so floor consideration cannot proceed under it'],
            uncertainty: [],
          },
          clientContext: { clientId: 'c1', matchedTopics: [], capabilities: [], activeStrategies: [], redLines: [], facilities: [] },
          relationshipContext: { targetOffices: [], existingRelationships: [], recentMeetings: [], openCommitments: [] },
          actionContext: { recommendedTargets: [], recommendedActions: [] },
          confidence: { relevance: 0.8, procedural: 0.9, evidenceCoverage: 0.71, missingFields: ['whoActs'] },
        },
      };
    }
    return { data: {} };
  });
}

function renderPanel(
  props: { focusAlertId?: string; onFocused?: () => void } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (next: { focusAlertId?: string; onFocused?: () => void }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AntApp>
          <TrackerFeedPanel
            clientId="c1"
            clientName="Acme Aerospace"
            focusAlertId={next.focusAlertId}
            onFocused={next.onFocused}
          />
        </AntApp>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return { ...view, rerenderPanel: (next: typeof props) => view.rerender(tree(next)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  feedUrls = [];
  apiPostMock.mockResolvedValue({ data: { ok: true, updated: 0 } });
  setupBrowserMocks();
});

describe('alert email deep links', () => {
  test('waits for the widened query when focus arrives after mount', async () => {
    const onFocused = vi.fn();
    const target = feedItem({ id: 'late-alert', title: 'Late linked regulation', sourceType: 'regulation' });
    apiGetMock.mockImplementation(async (url: string) => {
      if (!url.includes('/feed')) return { data: {} };
      feedUrls.push(url);
      return url.includes('workState=all')
        ? { data: feedPage([target]) }
        : { data: feedPage([feedItem({ id: 'active-alert', title: 'Active queue item' })]) };
    });

    const view = renderPanel();
    expect(await screen.findByText('Active queue item')).toBeInTheDocument();
    view.rerenderPanel({ focusAlertId: 'late-alert', onFocused });

    expect(await screen.findByText('Late linked regulation')).toBeInTheDocument();
    await waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1));
    expect(
      feedUrls.some(
        (url) => url.includes('workState=all') && !url.includes('sourceType='),
      ),
    ).toBe(true);
  });

  test('widens to All and keyset-pages until an older focused alert is loaded', async () => {
    const onFocused = vi.fn();
    const target = feedItem({
      id: 'older-alert',
      title: 'Older linked alert',
      workState: {
        state: 'dismissed',
        assignedTo: null,
        assignedToName: null,
        snoozedUntil: null,
        note: null,
      },
    });
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/feed')) {
        feedUrls.push(url);
        if (url.includes('cursor=page-2')) return { data: feedPage([target]) };
        return {
          data: feedPage([feedItem({ id: 'newer-alert', title: 'Newer alert' })], {
            nextCursor: 'page-2',
            hasMore: true,
          }),
        };
      }
      return { data: {} };
    });

    const { container } = renderPanel({ focusAlertId: 'older-alert', onFocused });

    await waitFor(() =>
      expect(feedUrls.some((url) => url.includes('workState=all'))).toBe(true),
    );
    await waitFor(() =>
      expect(feedUrls.some((url) => url.includes('cursor=page-2'))).toBe(true),
    );
    expect(await screen.findByText('Older linked alert')).toBeInTheDocument();
    await waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-alert-id="older-alert"]')).toHaveClass('open');
  });
});

describe('P1-10 — priority ordering is a control', () => {
  /** c-9 case 2: the calm default is Newest. Regression lock. */
  test('defaults to order=date', async () => {
    mockApi([feedItem()]);
    renderPanel();
    await waitFor(() => expect(feedUrls.length).toBeGreaterThan(0));
    expect(feedUrls[0]).toContain('order=date');
    expect(screen.getByRole('button', { name: 'Newest' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  /** c-9 case 1: clicking Priority refetches with order=score. */
  test('clicking Priority refetches with order=score', async () => {
    mockApi([feedItem()]);
    renderPanel();
    await waitFor(() => expect(feedUrls.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));

    await waitFor(() => expect(feedUrls.some((u) => u.includes('order=score'))).toBe(true));
    // A DISTINCT cache entry — the date page is still the one already fetched,
    // so both orders appear in the request log rather than one replacing it.
    expect(feedUrls.some((u) => u.includes('order=date'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Priority' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('P1-10 — the card shows what the API already returned', () => {
  /** c-9 case 3. */
  test('a collapsed card renders the severity chip', async () => {
    mockApi([feedItem({ severity: 'critical' })]);
    const { container } = renderPanel();
    await screen.findByText(/Rule failed on the floor/);
    const chip = container.querySelector('.chip.sev-critical');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('critical');
  });

  test('a collapsed card renders the deadline/urgency cue', async () => {
    mockApi([feedItem({ urgency: 'Action within 3 days' })]);
    renderPanel();
    expect(await screen.findByText('Action within 3 days')).toBeInTheDocument();
  });

  test('urgency falls back to the bill action date when absent', async () => {
    mockApi([feedItem({ urgency: null })]);
    renderPanel();
    expect(await screen.findByText('Action 2026-03-09')).toBeInTheDocument();
  });

  /** c-9 case 4. */
  test('whyItMatters renders in the expanded body', async () => {
    mockApi([feedItem()]);
    renderPanel();
    const title = await screen.findByText(/Rule failed on the floor/);
    // Not visible while collapsed — this is the restoration, not a duplicate.
    expect(screen.queryByText(/grid-interconnection revenue/)).toBeNull();
    fireEvent.click(title);
    expect(await screen.findByText(/grid-interconnection revenue/)).toBeInTheDocument();
    expect(screen.getByText('Why this matters')).toBeInTheDocument();
  });

  test('the expanded body shows procedural meaning, source, who acts, confidence', async () => {
    mockApi([feedItem()]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));

    expect(await screen.findByText('Procedural meaning')).toBeInTheDocument();
    expect(await screen.findByText(/New rule from the Rules Committee/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View official source' })).toHaveAttribute(
      'href',
      'https://congress.gov/bill/hr1200',
    );
    expect(screen.getByText('Who should act')).toBeInTheDocument();
    expect(await screen.findByText('Confidence and unknowns')).toBeInTheDocument();
    expect(await screen.findByText(/Evidence coverage 71%/)).toBeInTheDocument();
  });
});

describe('P1-11 — internal instrumentation is out of the analyst view', () => {
  /**
   * c-9 case 5 — THE lock. Even with every canonical field missing and whoActs
   * empty, the word `incomplete` must not reach the DOM.
   */
  test('no card renders the word "incomplete"', async () => {
    mockApi([
      feedItem({
        whyItMatters: null,
        tag: null,
        evidence: {},
        workState: undefined,
      }),
    ]);
    const { container } = renderPanel();
    await screen.findByText(/Rule failed on the floor/);
    expect(screen.queryByText(/incomplete/i)).toBeNull();
    expect(container.textContent).not.toMatch(/incomplete/i);
  });

  /** c-9 case 6. */
  test('limited evidence names only MATERIAL gaps, and not at all when whole', async () => {
    mockApi([feedItem({ whyItMatters: null, evidence: {} })]);
    const { container } = renderPanel();
    const warn = await screen.findByText('limited evidence');
    const title = warn.getAttribute('title') ?? '';
    expect(title).toContain('client relevance');
    expect(title).toContain('a source link');
    expect(title).toContain('the official action text');
    // whoActs is an assignment, not evidence — it must never appear here.
    expect(title).not.toContain('whoActs');
    expect(container.querySelector('.chip.warn')).not.toBeNull();
  });

  test('a complete card renders no warning', async () => {
    mockApi([feedItem()]);
    const { container } = renderPanel();
    await screen.findByText(/Rule failed on the floor/);
    expect(screen.queryByText('limited evidence')).toBeNull();
    expect(container.querySelector('.chip.warn')).toBeNull();
  });

  /**
   * c-9 case 7. MP-15 / Gate H d-5: `assignedToName` (set here as a red herring)
   * is never produced by any server code — "Who should act" resolves the raw
   * `assignedTo` DB user id against the tenant-admin roster instead, the SAME
   * roster + resolver the collapsed-card chip already used correctly.
   */
  test('an assigned owner renders (resolved from the roster, not the dead assignedToName field); unassigned shows the affordance', async () => {
    mockApi([
      feedItem({
        workState: {
          state: 'assigned',
          assignedTo: 'user-42',
          assignedToName: 'Wrong Name — must never render',
          snoozedUntil: null,
          note: null,
        },
      }),
    ]);
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/feed')) {
        feedUrls.push(url);
        return { data: feedPage([feedItem({
          workState: { state: 'assigned', assignedTo: 'user-42', assignedToName: 'Wrong Name — must never render', snoozedUntil: null, note: null },
        })]) };
      }
      if (url.includes('/tenant-admin/team')) {
        return { data: [{ userId: 'user-42', email: 'dana@acme.test', firstName: 'Dana', lastName: 'Reyes' }] };
      }
      return { data: {} };
    });
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    // "Dana Reyes" legitimately also appears as an <option> in the Assign
    // owner picker once the roster loads — assert presence, not exclusivity.
    await waitFor(() => expect(screen.getAllByText('Dana Reyes').length).toBeGreaterThan(0));
    const whoShouldAct = (await screen.findByText('Who should act')).parentElement;
    expect(whoShouldAct?.textContent).toContain('Dana Reyes');
    expect(screen.queryByText('Wrong Name — must never render')).toBeNull();
  });

  test('an assigned owner with no matching roster row renders "Former member", never the raw id, blank, or "undefined" (H-8)', async () => {
    mockApi([
      feedItem({
        workState: { state: 'assigned', assignedTo: 'user-99', snoozedUntil: null, note: null },
      }),
    ]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    expect(await screen.findByText('Former member')).toBeInTheDocument();
    expect(screen.queryByText('user-99')).toBeNull();
  });

  test('unassigned renders "Unassigned", never an empty string', async () => {
    mockApi([feedItem()]);
    const { container } = renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    // Scoped to the "Who should act" block: the Assign picker also has an
    // "Unassigned" <option>, which is a different (and correct) node.
    const section = await screen.findByText('Who should act');
    expect(section.parentElement?.textContent).toContain('Unassigned');
    expect(container.querySelector('.acard-why .muted')?.textContent).toBe('Unassigned');
  });

  test('the Assign picker offers only real roster members, never free text', async () => {
    mockApi([feedItem()]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    const picker = await screen.findByLabelText('Assign owner');
    expect(picker.tagName).toBe('SELECT');
    // §6.4 / edge case 10: no text input exists for an assignee id.
    expect(picker.querySelectorAll('input')).toHaveLength(0);
  });
});

describe('P1-10 — no raw score without an explanation', () => {
  /** c-9 case 8. */
  test('the score renders as a band chip with an explanatory tooltip', async () => {
    mockApi([feedItem({ score: 0.72 })]);
    const { container } = renderPanel();
    await screen.findByText(/Rule failed on the floor/);

    const bandChip = container.querySelector('.chip.band');
    expect(bandChip).not.toBeNull();
    expect(bandChip!.textContent).toBe('High priority');
    expect(bandChip!.getAttribute('title')).toMatch(/client relevance/i);

    // The raw number is never printed.
    expect(container.textContent).not.toContain('0.72');
  });

  test('the band comes from the stored provenance band, not a re-derivation', async () => {
    // score says Low, the writer stored High — the stored band wins, so the card
    // agrees with what was emailed.
    mockApi([
      feedItem({
        score: 0.1,
        evidence: {
          provenance: {
            sourceUrl: 'https://x',
            triggerKey: null,
            tone: null,
            band: 'High',
            jurisdiction: 'US',
            writerShape: 'x',
          },
          bill: {
            billId: 'b',
            displayNum: 'H.R. 1',
            title: null,
            url: 'https://x',
            stage: 's',
            actionText: 'a',
            actionDate: null,
          },
        },
      }),
    ]);
    const { container } = renderPanel();
    await screen.findByText(/Rule failed on the floor/);
    expect(container.querySelector('.chip.band')!.textContent).toBe('High priority');
  });
});

/**
 * Gate D phase e (P2-04, P2-05) — the worklist.
 *
 * e-7 cases 8-10. The behaviour under test is P2-06's rule applied to the NEW
 * controls: nothing announces success before its mutation resolves, and a bulk
 * operation reports partial failure rather than a blanket success.
 */
describe('P2-04 — per-user triage', () => {
  test('the worklist filter defaults to Active and sends no workState param', async () => {
    mockApi([feedItem()]);
    renderPanel();
    await waitFor(() => expect(feedUrls.length).toBeGreaterThan(0));
    // 'default' is the server's own behaviour, so the common case's URL is
    // unchanged and keeps its existing cache entry.
    expect(feedUrls[0]).not.toContain('workState');
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('choosing Dismissed refetches with workState=dismissed', async () => {
    mockApi([feedItem()]);
    renderPanel();
    await waitFor(() => expect(feedUrls.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Dismissed' }));
    await waitFor(() => expect(feedUrls.some((u) => u.includes('workState=dismissed'))).toBe(true));
  });

  /** e-7 case 8: pending state before success — never fire-and-toast. */
  test('Mark reviewed posts to the work-state route and disables while pending', async () => {
    let resolvePost: (v: unknown) => void = () => {};
    apiPostMock.mockImplementation(
      () => new Promise((res) => { resolvePost = res; }),
    );
    mockApi([feedItem()]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));

    const btn = await screen.findByRole('button', { name: /Mark reviewed/ });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        expect.stringContaining('/alerts/a1/work-state'),
        expect.objectContaining({ state: 'in_review' }),
      ),
    );
    // Still pending → disabled, and no success has been claimed yet.
    await waitFor(() => expect(btn).toBeDisabled());
    resolvePost({ data: { ok: true } });
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  test('Dismiss sends state=dismissed', async () => {
    apiPostMock.mockResolvedValue({ data: { ok: true } });
    mockApi([feedItem()]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        expect.stringContaining('/alerts/a1/work-state'),
        expect.objectContaining({ state: 'dismissed' }),
      ),
    );
  });

  test('Snooze sends a future snoozedUntil with state=snoozed', async () => {
    apiPostMock.mockResolvedValue({ data: { ok: true } });
    mockApi([feedItem()]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    fireEvent.change(await screen.findByLabelText('Snooze'), { target: { value: '7' } });
    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const body = apiPostMock.mock.calls.at(-1)![1] as { state: string; snoozedUntil: string };
    expect(body.state).toBe('snoozed');
    expect(new Date(body.snoozedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  test('a card shows THIS user’s state, not the firm-wide alert status', async () => {
    mockApi([
      feedItem({
        status: 'new', // the shared event status
        workState: {
          state: 'actioned', // this user's own state
          assignedTo: null,
          snoozedUntil: null,
          note: null,
        },
      }),
    ]);
    renderPanel();
    expect(await screen.findByText('Actioned')).toBeInTheDocument();
  });

  /** e-7 case 10: bulk triage reports PARTIAL failure. */
  test('bulk triage over a selection reports partial failure', async () => {
    apiPostMock.mockRejectedValue(new Error('boom'));
    mockApi([feedItem({ id: 'a1' }), feedItem({ id: 'a2', title: 'Second alert' })]);
    renderPanel();
    await screen.findByText(/Rule failed on the floor/);

    fireEvent.click(screen.getByLabelText('Select H.R. 1200 — Rule failed on the floor'));
    fireEvent.click(screen.getByLabelText('Select Second alert'));
    expect(await screen.findByText('2 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    // The failure is surfaced as a count, not swallowed into a success toast.
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        expect.stringContaining('/alerts/work-state/bulk'),
        expect.objectContaining({ alertIds: ['a1', 'a2'], state: 'in_review' }),
      ),
    );
  });
});

/** e-7 case 9 — P2-05, an alert that already has a memo. */
describe('P2-05 — open an existing memo', () => {
  test('with a memo present, Open memo / Edit in Workspace / Review history all render', async () => {
    mockApi([
      feedItem({
        actions: {
          inReport: false,
          talkingPoints: 0,
          memo: { documentAttachmentId: 'att-1', title: 'Client memo' },
        },
      }),
    ]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    expect(await screen.findByRole('button', { name: /Open memo/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit in Workspace/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Review history/ })).toBeInTheDocument();
  });

  test('with NO memo, none of the open-existing actions render', async () => {
    mockApi([feedItem()]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    await screen.findByText('Who should act');
    expect(screen.queryByRole('button', { name: /Open memo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit in Workspace/ })).toBeNull();
  });
});

/** Renders whatever route navigate() actually lands on, as visible text. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

/** MP-13 / Gate H phase b: Open memo must land on the specific attachment. */
describe('P2-05 — Open memo lands on the specific attachment (Gate H phase b)', () => {
  function renderPanelWithLocationProbe() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AntApp>
            <TrackerFeedPanel clientId="c1" clientName="Acme Aerospace" />
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  test('navigates with &attachmentId= when the memo has a filed document', async () => {
    mockApi([
      feedItem({
        actions: { inReport: false, talkingPoints: 0, memo: { documentAttachmentId: 'att-9', title: 'Client memo' } },
      }),
    ]);
    renderPanelWithLocationProbe();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    fireEvent.click(await screen.findByRole('button', { name: /Open memo/ }));

    await waitFor(() => {
      const text = screen.getByTestId('location-probe').textContent ?? '';
      expect(text).toContain('/clients?');
      expect(text).toContain('clientId=c1');
      expect(text).toContain('tab=documents');
      expect(text).toContain('attachmentId=att-9');
    });
  });

  test('navigates WITHOUT attachmentId (not a fabricated one) when the memo has no filed document (a-4)', async () => {
    mockApi([
      feedItem({
        actions: { inReport: false, talkingPoints: 0, memo: { documentAttachmentId: null, title: 'Client memo' } },
      }),
    ]);
    renderPanelWithLocationProbe();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    fireEvent.click(await screen.findByRole('button', { name: /Open memo/ }));

    await waitFor(() => {
      const text = screen.getByTestId('location-probe').textContent ?? '';
      expect(text).toContain('tab=documents');
    });
    expect(screen.getByTestId('location-probe').textContent ?? '').not.toContain('attachmentId');
  });
});

/** MP-13 / H-5: Review history must land on the specific review request when one exists. */
describe('P2-05 — Review history lands on the specific review request (H-5)', () => {
  function renderPanelWithLocationProbe() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AntApp>
            <TrackerFeedPanel clientId="c1" clientName="Acme Aerospace" />
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  test('navigates with ?id= when the memo has a review request', async () => {
    mockApi([
      feedItem({
        actions: {
          inReport: false,
          talkingPoints: 0,
          memo: { documentAttachmentId: 'att-9', title: 'Client memo', reviewRequestId: 'rr-1' },
        },
      }),
    ]);
    renderPanelWithLocationProbe();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    fireEvent.click(await screen.findByRole('button', { name: /Review history/ }));

    await waitFor(() => {
      const text = screen.getByTestId('location-probe').textContent ?? '';
      expect(text).toContain('/reviews');
      expect(text).toContain('id=rr-1');
    });
  });

  test('navigates to the bare queue when the memo was never held for review', async () => {
    mockApi([
      feedItem({
        actions: {
          inReport: false,
          talkingPoints: 0,
          memo: { documentAttachmentId: 'att-9', title: 'Client memo', reviewRequestId: null },
        },
      }),
    ]);
    renderPanelWithLocationProbe();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    fireEvent.click(await screen.findByRole('button', { name: /Review history/ }));

    await waitFor(() => {
      const text = screen.getByTestId('location-probe').textContent ?? '';
      expect(text).toContain('/reviews');
    });
    expect(screen.getByTestId('location-probe').textContent ?? '').not.toContain('id=');
  });
});

/** MP-14 / Gate H phase c: these are honest navigation labels, not alert actions. */
describe('MP-14 — Action Board / Strategies are labelled as navigation', () => {
  test('renders "Open Action Board" / "Open Strategies", not "Create task" / "Add to strategy"', async () => {
    mockApi([feedItem()]);
    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    expect(await screen.findByRole('button', { name: 'Open Action Board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Strategies' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to strategy' })).toBeNull();
  });
});

/**
 * Gate D phase g (g-7, g-8 case 8) — the `&alert=<id>` deep link.
 *
 * Gate A's alert email wanted this and deferred it because nothing read the
 * param. RadarPage now does: the Feed scrolls to that card, expands it, and
 * clears the param so a refresh does not re-scroll a card the user collapsed.
 */
describe('g-7 — the &alert= deep link focuses one card', () => {
  test('the targeted card auto-expands and the param is cleared once', async () => {
    mockApi([feedItem({ id: 'a9' })]);
    const onFocused = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AntApp>
            <TrackerFeedPanel
              clientId="c1"
              clientName="Acme Aerospace"
              focusAlertId="a9"
              onFocused={onFocused}
            />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Expanded WITHOUT a click — the expanded-only body is present.
    expect(await screen.findByText('Why this matters')).toBeInTheDocument();
    // And the parent is told to drop the param, exactly once.
    await waitFor(() => expect(onFocused).toHaveBeenCalledTimes(1));
  });

  test('a NON-targeted card stays collapsed', async () => {
    mockApi([feedItem({ id: 'a1' })]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AntApp>
            <TrackerFeedPanel clientId="c1" clientName="Acme" focusAlertId="a9" />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText(/Rule failed on the floor/);
    expect(screen.queryByText('Why this matters')).toBeNull();
  });

  test('with no focusAlertId nothing auto-expands (the default feed)', async () => {
    mockApi([feedItem()]);
    renderPanel();
    await screen.findByText(/Rule failed on the floor/);
    expect(screen.queryByText('Why this matters')).toBeNull();
  });
});

/**
 * RB-04 / Gate H a-1, a-7: "Edit in Workspace" on an alert that already has a
 * memo must never generate (and so never replace the filed document) — it
 * reads the saved content directly and opens a Workspace draft from it. A
 * repo-wide grep before this fix found zero tests anywhere exercising the
 * generate endpoint's replaceAttachmentId at all.
 */
describe('P2-05 — Edit in Workspace reads saved content, never regenerates (Gate H a-7)', () => {
  test('clicking Edit in Workspace calls memo-link + drafts, never the generate endpoint, and opens with the saved content', async () => {
    mockApi([
      feedItem({
        actions: {
          inReport: false,
          talkingPoints: 0,
          memo: { documentAttachmentId: 'att-1', title: 'Client memo — H.R. 1200' },
        },
      }),
    ]);
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/feed')) {
        feedUrls.push(url);
        return { data: feedPage([
          feedItem({
            actions: {
              inReport: false,
              talkingPoints: 0,
              memo: { documentAttachmentId: 'att-1', title: 'Client memo — H.R. 1200' },
            },
          }),
        ]) };
      }
      if (url.includes('/memo-link')) {
        return { data: { documentAttachmentId: 'att-1', title: 'Client memo — H.R. 1200', text: 'Saved body text.' } };
      }
      return { data: {} };
    });
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.includes('/workspace-api/drafts')) return { data: { id: 'draft-1' } };
      return { data: { ok: true, updated: 0 } };
    });

    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    fireEvent.click(await screen.findByRole('button', { name: /Edit in Workspace/i }));

    await screen.findByText(/Opened in Workspace/i);

    const getUrls = apiGetMock.mock.calls.map((c) => c[0] as string);
    expect(getUrls.some((u) => u.includes('/memo-link'))).toBe(true);
    const postCalls = apiPostMock.mock.calls as Array<[string, unknown]>;
    expect(postCalls.some(([u]) => u.includes('/workspace-api/drafts'))).toBe(true);
    expect(postCalls.some(([u]) => u.includes('/alert-memo'))).toBe(false);
    // No replaceAttachmentId anywhere — this path never carries one at all.
    expect(postCalls.every(([, body]) => !(body as Record<string, unknown> | undefined)?.replaceAttachmentId)).toBe(
      true,
    );
  });

  test('when there is no saved content to read, Edit in Workspace fails loudly instead of opening an empty draft', async () => {
    mockApi([
      feedItem({
        actions: {
          inReport: false,
          talkingPoints: 0,
          memo: { documentAttachmentId: 'att-1', title: 'Client memo — H.R. 1200' },
        },
      }),
    ]);
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/feed')) {
        feedUrls.push(url);
        return { data: feedPage([
          feedItem({
            actions: {
              inReport: false,
              talkingPoints: 0,
              memo: { documentAttachmentId: 'att-1', title: 'Client memo — H.R. 1200' },
            },
          }),
        ]) };
      }
      if (url.includes('/memo-link')) {
        return { data: { documentAttachmentId: 'att-1', title: 'Client memo — H.R. 1200', text: null } };
      }
      return { data: {} };
    });

    renderPanel();
    fireEvent.click(await screen.findByText(/Rule failed on the floor/));
    fireEvent.click(await screen.findByRole('button', { name: /Edit in Workspace/i }));

    await screen.findByText(/No saved memo content on record/i);
    const postUrls = apiPostMock.mock.calls.map((c) => c[0] as string);
    expect(postUrls.some((u) => u.includes('/workspace-api/drafts'))).toBe(false);
  });
});
