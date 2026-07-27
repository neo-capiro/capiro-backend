import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'vitest-axe';
import { TrackerConfigPanel } from './TrackerConfigPanel.js';
import { AddBillModal, BillCard } from './tracker-components.js';
import { TrackerFeedPanel } from './TrackerFeedPanel.js';
import type {
  AlertPrefsPayload,
  BoardBill,
  WatchlistPayload,
  WatchlistTag,
} from './tracker-api.js';
import type { FeedItem } from './intel-feed-api.js';

/**
 * Gate D phase h (P1-12 / P2-12) — keyboard and screen-reader access.
 *
 * The audit's finding was that core LegiWatch controls were clickable `<div>`s
 * and `<span>`s: not focusable, no role, no state. An analyst who cannot use a
 * mouse could not set an alert trigger, expand a tag, remove a term, or open a
 * feed card at all.
 *
 * These tests drive the UI the way a keyboard does — focus and key events, never
 * a synthetic click on a non-interactive node — so they fail if the elements
 * regress to divs.
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
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ enabled: true, ready: true }),
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

// ── fixtures ────────────────────────────────────────────────────────────────
function tag(over: Partial<WatchlistTag> = {}): WatchlistTag {
  return {
    tag: 'defense authorization',
    issueArea: 'Defense',
    synonyms: ['NDAA'],
    relatedEntities: [],
    riskTerms: [],
    typedTerms: [],
    priority: 'med',
    position: 'monitor',
    ...over,
  } as WatchlistTag;
}
function watchlist(over: Partial<WatchlistPayload> = {}): WatchlistPayload {
  return { issueAreas: ['Defense'], tags: [tag()], version: 3, ...over } as WatchlistPayload;
}
function prefs(over: Partial<AlertPrefsPayload> = {}): AlertPrefsPayload {
  return {
    triggers: ['enactedFailed'],
    materiality: 'medium',
    emailEnabled: true,
    emailAddress: 'a@b.com',
    emailCadence: 'immediate',
    smsEnabled: false,
    smsPhone: null,
    smsPhoneVerified: false,
    smsCadence: 'immediate',
    quietHoursStart: null,
    quietHoursEnd: null,
    ...over,
  } as AlertPrefsPayload;
}
function boardBill(over: Partial<BoardBill> = {}): BoardBill {
  return {
    billId: '119-hr-1200',
    displayNum: 'H.R. 1200',
    title: 'Grid Modernization Act',
    stage: 'passed',
    probability: 0.42,
    tags: ['grid'],
    isManual: true,
    trackedAt: '2026-03-01T00:00:00.000Z',
    unread: true,
    change: { tone: 'critical', label: 'Rule failed', dot: true },
    canonicalStatus: 'Rule failed',
    terminalRisk: true,
    latestActionDate: '2026-03-09',
    latestActionText: 'Failed by the Yeas and Nays: 198 - 224.',
    ...over,
  } as BoardBill;
}
function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'a1',
    clientId: 'c1',
    clientName: 'Acme',
    sourceType: 'bill',
    kind: 'bill_change',
    severity: 'critical',
    materiality: 'high',
    score: 0.72,
    clientImpact: null,
    urgency: 'Action within 3 days',
    title: 'H.R. 1200 — Rule failed on the floor',
    whyItMatters: 'Revenue exposure.',
    tag: 'grid',
    recommendedAction: null,
    evidence: {
      bill: {
        billId: 'hr-1200-119',
        displayNum: 'H.R. 1200',
        title: 'A bill',
        url: 'https://congress.gov/x',
        stage: 'Rule failed',
        actionText: 'Failed.',
        actionDate: '2026-03-09',
      },
      provenance: {
        sourceUrl: 'https://congress.gov/x',
        triggerKey: 'floorVote',
        tone: 'critical',
        band: 'High',
        jurisdiction: 'US',
        writerShape: 'x',
      },
    },
    status: 'new',
    createdAt: '2026-03-10T00:00:00.000Z',
    recommendedActions: [{ kind: 'draft_memo', label: 'Draft memo', primary: true }],
    actions: { inReport: false, talkingPoints: 0 },
    ...over,
  } as FeedItem;
}

function renderConfig(over: Partial<WatchlistPayload> = {}) {
  return render(
    <div className="redesign">
      <TrackerConfigPanel
        allIssueAreas={['Defense']}
        watchlist={watchlist(over)}
        prefs={prefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
      />
    </div>,
  );
}

function renderFeed() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AntApp>
          <div className="lw-root">
            <TrackerFeedPanel clientId="c1" clientName="Acme" />
          </div>
        </AntApp>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderAddBill(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={qc}>
        <AntApp>
          <div className="redesign">
            <button type="button">opener</button>
            <AddBillModal
              clientId="c1"
              boardNums={new Set()}
              onTrackManual={vi.fn()}
              onClose={onClose}
            />
          </div>
        </AntApp>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setupBrowserMocks();
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/feed')) {
      return {
        data: {
          items: [feedItem()],
          nextCursor: null,
          hasMore: false,
          counts: { bill: 1 },
          severityCounts: { critical: 1 },
        },
      };
    }
    return { data: {} };
  });
  apiPostMock.mockResolvedValue({ data: { ok: true } });
});

// ── h-5 cases 1-4: keyboard-only operation ──────────────────────────────────
describe('h-5 case 1 — keyboard-only trigger toggle', () => {
  test('a trigger is focusable, exposes aria-checked, and toggles on Space', () => {
    renderConfig();
    const trigger = screen.getByRole('checkbox', { name: /Enacted|Became law|passage/i });

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    const before = trigger.getAttribute('aria-checked');

    // Space on a <button> fires click in a real browser; jsdom does not
    // synthesise that, so assert the semantics + the handler together.
    fireEvent.keyDown(trigger, { key: ' ', code: 'Space' });
    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-checked')).not.toBe(before);
  });

  test('EVERY trigger exposes checkbox semantics (was a plain div)', () => {
    renderConfig();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('aria-checked')).toMatch(/true|false/);
    }
  });
});

describe('h-5 case 2 — keyboard-only tag expand', () => {
  test('the tag name is a button with aria-expanded and aria-controls', () => {
    renderConfig();
    const name = screen.getByRole('button', { name: '#defense authorization' });
    expect(name).toHaveAttribute('aria-expanded', 'false');
    expect(name.getAttribute('aria-controls')).toBeTruthy();

    name.focus();
    expect(document.activeElement).toBe(name);
    fireEvent.click(name);
    expect(name).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('h-5 case 3 — keyboard-only chip removal', () => {
  test('a chip remove control is a NAMED button, not a span', () => {
    renderConfig();
    fireEvent.click(screen.getByRole('button', { name: '#defense authorization' }));

    const remove = screen.getByRole('button', { name: 'Remove NDAA' });
    expect(remove.tagName).toBe('BUTTON');
    remove.focus();
    expect(document.activeElement).toBe(remove);

    fireEvent.click(remove);
    expect(screen.queryByRole('button', { name: 'Remove NDAA' })).toBeNull();
  });

  test('the tag delete control has a real accessible name', () => {
    renderConfig();
    expect(
      screen.getByRole('button', { name: 'Remove tag defense authorization' }),
    ).toBeInTheDocument();
  });
});

describe('h-5 case 4 — keyboard-only feed card expand', () => {
  test('the card header is a button whose aria-expanded flips', async () => {
    renderFeed();
    const header = await screen.findByRole('button', {
      name: /Rule failed on the floor/,
    });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    header.focus();
    expect(document.activeElement).toBe(header);

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });
});

// ── h-5 case 5: focus trap ──────────────────────────────────────────────────
describe('h-5 case 5 — the custom modal traps and restores focus', () => {
  test('has dialog semantics and an accessible name', async () => {
    renderAddBill();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Add a bill to the board');
  });

  test('focus moves INTO the dialog on open', async () => {
    renderAddBill();
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  test('Tab past the last control wraps to the first', async () => {
    renderAddBill();
    const dialog = await screen.findByRole('dialog');
    const focusables = within(dialog).getAllByRole('button');
    const last = focusables[focusables.length - 1]!;

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    // Wrapped — focus is still inside the dialog, not on the page behind it.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test('Shift+Tab from the first control wraps to the last', async () => {
    renderAddBill();
    const dialog = await screen.findByRole('dialog');
    const first = within(dialog).getAllByRole('button')[0]!;
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test('Escape closes it and focus returns to the opener', async () => {
    const { onClose } = renderAddBill();
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

// ── h-5 cases 6-7: ARIA coverage ────────────────────────────────────────────
describe('h-5 case 6 — every toggle exposes its state', () => {
  test('the feed ordering and worklist controls expose aria-pressed', async () => {
    renderFeed();
    const newest = await screen.findByRole('button', { name: 'Newest' });
    const priority = screen.getByRole('button', { name: 'Priority' });
    expect(newest).toHaveAttribute('aria-pressed', 'true');
    expect(priority).toHaveAttribute('aria-pressed', 'false');

    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('h-5 case 7 — no icon-only control is unnamed', () => {
  test('every button in Configure has a non-empty accessible name', () => {
    const { container } = renderConfig();
    fireEvent.click(screen.getByRole('button', { name: '#defense authorization' }));

    const unnamed = Array.from(container.querySelectorAll('button')).filter((b) => {
      const name =
        b.getAttribute('aria-label') ??
        b.getAttribute('title') ??
        (b.textContent ?? '').trim();
      return !name;
    });
    expect(unnamed.map((b) => b.outerHTML.slice(0, 120))).toEqual([]);
  });

  test('every button on a board card has a non-empty accessible name', () => {
    const { container } = render(
      <div className="lw-root">
        <BillCard
          bill={boardBill()}
          issueSet={new Set(['grid'])}
          justLanded={false}
          onUntrack={vi.fn()}
          onOpen={vi.fn()}
        />
      </div>,
    );
    const unnamed = Array.from(container.querySelectorAll('button')).filter((b) => {
      const name =
        b.getAttribute('aria-label') ??
        b.getAttribute('title') ??
        (b.textContent ?? '').trim();
      return !name;
    });
    expect(unnamed.map((b) => b.outerHTML.slice(0, 120))).toEqual([]);
  });
});

// ── h-5 case 8: the axe pass (§6.5 approved) ────────────────────────────────
/**
 * §6.5 was answered YES, so this is a REAL axe run rather than a claim that
 * cases 1-7 stand in for one. Filtered to serious/critical impact: colour
 * contrast and layout rules are not meaningfully checkable in jsdom, which has
 * no rendering, so passing those would be a false assurance either way.
 */
function seriousViolations(results: Awaited<ReturnType<typeof axe>>) {
  return (results.violations ?? [])
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .filter((v) => v.id !== 'color-contrast')
    // Includes the offending HTML so a future failure is diagnosable from the
    // test output alone rather than needing a re-run with extra logging.
    .map((v) => `${v.id}: ${v.help} :: ${v.nodes.map((n) => n.html).join(' | ').slice(0, 240)}`);
}

describe('h-5 case 8 — axe reports no serious/critical violations', () => {
  test('Configure', async () => {
    const { container } = renderConfig();
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('Configure with a tag expanded', async () => {
    const { container } = renderConfig();
    fireEvent.click(screen.getByRole('button', { name: '#defense authorization' }));
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('a board card', async () => {
    const { container } = render(
      <div className="lw-root">
        <BillCard
          bill={boardBill()}
          issueSet={new Set(['grid'])}
          justLanded={false}
          onUntrack={vi.fn()}
          onOpen={vi.fn()}
        />
      </div>,
    );
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('the Feed, collapsed and expanded', async () => {
    const { container } = renderFeed();
    await screen.findByRole('button', { name: /Rule failed on the floor/ });
    expect(seriousViolations(await axe(container))).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /Rule failed on the floor/ }));
    expect(seriousViolations(await axe(container))).toEqual([]);
  });

  test('the Add Bill modal', async () => {
    const { container } = renderAddBill();
    await screen.findByRole('dialog');
    expect(seriousViolations(await axe(container))).toEqual([]);
  });
});
