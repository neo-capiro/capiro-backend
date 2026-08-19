/**
 * Working-timeline regressions (2026-08-19, second pass).
 *
 * The first pass (a CSS-grid month-column model) fixed the missing TODAY
 * marker and stopped labels spilling outside their own box, but Neo's
 * follow-up review — done by opening the SAME strategy on both
 * `app.capiro.ai` (legacy) and `os.capiro.ai` (vNext) side by side — found
 * the grid model itself was wrong relative to that reference:
 *
 *  1. Step cards were single-line, fixed-height, ellipsis-truncated. Legacy
 *     cards wrap their title across as many lines as it needs and grow the
 *     row to fit. Truncating "Draft and submit white papers justifying the
 *     plus-up" to "Draft and subm…" reads as broken, not "handled overflow".
 *  2. Month columns shrank to fit the 36-month window on one screen (46px at
 *     the 3-year horizon) — legacy holds every column at a fixed 100px and
 *     scrolls horizontally instead. Compressed columns are what made a
 *     legislative-milestone box roughly HALF as wide as the same event on
 *     legacy, which is what actually drove the illegible-label complaint (the
 *     grid model's ellipsis was a symptom of the width, not a separate bug).
 *  3. There was a Horizon (1FY/2FY/3FY) filter chip. Legacy has never had one;
 *     it always shows the rolling [current FY, +1, +2] window.
 *  4. "Editable" legislative calendar meant a hover-revealed (opacity:0 until
 *     hover) drag handle on the timeline bar itself. Legacy's edit affordance
 *     is a plain, always-visible "Edit calendar" link that opens a form modal
 *     (label + from/to quarter selects) — far more discoverable, and this is
 *     what "replicate the same exact functionality" in the follow-up meant.
 *
 * This file replaces the grid-model tests with ones for the ported model:
 * continuous (date-accurate) positions via `pages/strategy/fiscal.ts`,
 * `packSpans` lane packing, wrapped step titles, no horizon chip, and the
 * "Edit calendar" link navigating to the new overlay route rather than
 * toggling an inline drag mode.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyEditorVNext } from './StrategyEditorVNext.js';
import type { ReferenceRow, StrategyDetail, StrategyNode } from '../../../pages/strategy/types.js';

const STRATEGY_ID = '11111111-2222-3333-4444-555555555555';

/** Fixed "now" so the calendar, the TODAY marker and the fixtures agree. */
const NOW = new Date(2026, 7, 19, 12, 0, 0); // Aug 19 2026, local — matches fiscal.ts's local-date model.

vi.mock('../../adapters/legacy/useShellClientContext.js', () => ({
  useShellClientContext: () => ({
    enabled: true,
    loading: false,
    unavailable: false,
    options: [],
    selectedClientId: null,
    selectedClientName: null,
    scopeLabel: 'All clients',
    setSelectedClientId: () => {},
  }),
}));

function node(over: Partial<StrategyNode> & Pick<StrategyNode, 'id' | 'startsOn'>): StrategyNode {
  return {
    strategyId: STRATEGY_ID,
    kind: 'action',
    subject: 'deliverable',
    title: 'Step',
    note: null,
    ownerUserId: null,
    status: 'draft',
    endsOn: null,
    openEnded: false,
    dependsOnIds: [],
    provenance: null,
    targetRef: null,
    meriAuthored: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/* Real shapes from capiro-dev (read 2026-08-19): the plan opens in Aug 2026
   (FY2026) and the legislative baseline runs Jan 2026 – Nov 2027. A long,
   real title is included deliberately — this is the exact string that used
   to render as "Draft and subm…". */
const LONG_TITLE = 'Draft and submit white papers justifying $10M plus-up to target committees';
const NODES: StrategyNode[] = [
  node({ id: 'n1', title: 'Identify target program elements', startsOn: '2026-08-15', endsOn: '2026-09-30' }),
  node({ id: 'n2', kind: 'decision', title: 'Select final PE targets', startsOn: '2026-10-01', endsOn: null }),
  node({ id: 'n3', kind: 'action', title: LONG_TITLE, startsOn: '2027-01-15', endsOn: '2027-02-28', ownerUserId: 'u1' }),
  node({ id: 'n4', kind: 'gate', title: 'Submit congressional funding request', startsOn: '2027-04-28', endsOn: null }),
];

const CONGRESS: ReferenceRow[] = [
  { id: 'c1', kind: 'congress_milestone', label: "President's Budget", fy: null, startsOn: '2026-01-29T00:00:00.000Z', endsOn: '2026-02-19T00:00:00.000Z', tone: 'ink', position: 0 },
  { id: 'c2', kind: 'congress_milestone', label: 'Floor & amendments', fy: null, startsOn: '2026-07-01T00:00:00.000Z', endsOn: '2026-08-17T00:00:00.000Z', tone: 'notable', position: 1 },
  { id: 'c3', kind: 'congress_milestone', label: 'Conference', fy: null, startsOn: '2026-08-17T00:00:00.000Z', endsOn: '2026-09-22T00:00:00.000Z', tone: 'notable', position: 2 },
  { id: 'c4', kind: 'congress_milestone', label: 'Continuing resolution risk', fy: null, startsOn: '2026-09-04T00:00:00.000Z', endsOn: '2026-10-06T00:00:00.000Z', tone: 'critical', position: 3 },
];

const detail: StrategyDetail = {
  id: STRATEGY_ID,
  clientId: 'client-1',
  title: 'Secure a $10M plus-up',
  type: 'regulatory',
  goal: 'Secure a $10M plus-up',
  meriContext: null,
  meriSummary: null,
  draftedByMeri: false,
  targetDate: null,
  ownerUserId: 'u1',
  createdByUserId: 'u1',
  lastEditedByUserId: 'u1',
  lastEditedAt: '2026-08-19T11:00:00.000Z',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-08-19T11:00:00.000Z',
  nodes: NODES,
  artifacts: [],
};

vi.mock('./strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('./strategies-api.js')>('./strategies-api.js');
  return {
    ...actual,
    useStrategy: () => ({ data: detail, isLoading: false, isError: false, dataUpdatedAt: NOW.getTime() }),
    useFirmPhases: () => ({ data: [{ id: 'p1', label: 'Strategy refresh', startFy: 2026, startQ: 1, endFy: 2026, endQ: 2 }] }),
    useReferenceCalendars: () => ({
      data: { congress: CONGRESS, ppbeLanes: [], ppbeCurrentPhases: [], source: { congress: 'baseline' } },
    }),
    useClientsLite: () => ({ data: [{ id: 'client-1', name: 'RTX Corporation' }] }),
    useTenantMembers: () => ({ data: [{ id: 'm1', clerkUserId: 'u1', email: 'a@b.com', name: 'Sarah Chen' }] }),
    usePendingWatchCounts: () => ({ data: {} }),
    useWatchReviewState: () => ({ data: { proposals: [] } }),
  };
});

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/strategies/${STRATEGY_ID}`]}>
        <Routes>
          <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
          <Route path="/strategies/:strategyId/legislative-calendar" element={<div data-testid="legcal-route">legislative-calendar route</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

describe('Working timeline — no horizon filter', () => {
  it('never renders a horizon/scope chip — the window is always the rolling 3-FY range', () => {
    renderEditor();
    expect(screen.queryByText('HORIZON')).toBeNull();
    expect(screen.queryByRole('button', { name: /FY\d\d.*FY\d\d/ })).toBeNull();
  });

  it('shows exactly the rolling [current FY, +1, +2] window', () => {
    renderEditor();
    // "today" (2026-08-19) is in FY2026 -> window is FY26/FY27/FY28. Each FY
    // label repeats once per quarter (4x), so assert presence/absence, not count.
    expect(screen.getAllByText('FY26').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FY27').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FY28').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('FY29')).toHaveLength(0);
    expect(screen.queryAllByText('FY25')).toHaveLength(0);
  });
});

describe('Working timeline — TODAY marker', () => {
  it('renders on-axis (today is always inside the rolling window by construction)', () => {
    const { container } = renderEditor();
    const line = container.querySelector<HTMLElement>('.st-tl__today-line');
    expect(line).toBeTruthy();
  });

  it('marks the current quarter and month on the ruler', () => {
    renderEditor();
    expect(screen.getByText('Current')).toBeTruthy();
    const augCells = screen.getAllByText('Aug');
    expect(augCells.length).toBeGreaterThan(0);
  });
});

describe('Working timeline — step cards never truncate', () => {
  it('renders a long real title in full, with no ellipsis CSS on the title element', () => {
    const { container } = renderEditor();
    const title = [...container.querySelectorAll<HTMLElement>('.st-step__title')].find(
      (el) => el.textContent === LONG_TITLE,
    );
    expect(title).toBeTruthy();
    const cs = getComputedStyle(title!);
    expect(cs.textOverflow).not.toBe('ellipsis');
    expect(cs.overflow).not.toBe('hidden');
  });

  it('does not force a single-line height on the step card', () => {
    const { container } = renderEditor();
    const card = [...container.querySelectorAll<HTMLElement>('.st-step')].find((el) =>
      el.textContent?.includes(LONG_TITLE),
    )!;
    expect(getComputedStyle(card).height).not.toBe('72px');
  });

  it('shows kind + real date range in the eyebrow, and the owner in the meta line', () => {
    const { container } = renderEditor();
    const card = [...container.querySelectorAll<HTMLElement>('.st-step')].find((el) =>
      el.textContent?.includes(LONG_TITLE),
    )!;
    expect(card.querySelector('.st-step__kind')?.textContent).toMatch(/Action · Jan '27/);
    expect(card.querySelector('.st-step__meta')?.textContent).toBe('Owner · Sarah Chen');
  });
});

describe('Working timeline — lane packing (no visual collisions)', () => {
  function overlaps(a: DOMRect, b: DOMRect) {
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  }

  it('never places two step cards, or two legislative bars, on top of each other', () => {
    const { container } = renderEditor();
    for (const selector of ['.st-step', '.st-tl__bar']) {
      const els = [...container.querySelectorAll<HTMLElement>(selector)];
      const rects = els.map((el) => el.getBoundingClientRect());
      for (let i = 0; i < els.length; i++) {
        for (let j = i + 1; j < els.length; j++) {
          expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
        }
      }
    }
  });
});

describe('Legislative calendar — editable via an always-visible link', () => {
  it('renders "Edit calendar" without needing to hover', () => {
    renderEditor();
    const link = screen.getByRole('button', { name: /Edit calendar/i });
    // No opacity:0-until-hover gate — the whole point of the follow-up fix.
    expect(getComputedStyle(link).opacity).not.toBe('0');
  });

  it('opens the legislative-calendar overlay route on click, not an inline drag mode', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Edit calendar/i }));
    expect(screen.getByTestId('legcal-route')).toBeTruthy();
    // The old inline editor's affordances must be gone.
    expect(screen.queryByRole('button', { name: 'Save calendar' })).toBeNull();
  });

  it('renders every seeded legislative milestone, including the long one, in full', () => {
    renderEditor();
    const band = within(document.querySelector('.st-tl__row--legislative.st-tl__band') as HTMLElement);
    for (const row of CONGRESS) {
      const label = band.getByText(row.label);
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
    }
  });
});

describe('PPBE band — read-only, no edit affordance', () => {
  it('has no fork route for ppbe_lane_bar, so there is no Edit control on it', () => {
    renderEditor();
    const ppbeRow = [...document.querySelectorAll('.st-tl__gutter-row')].find((r) =>
      r.textContent?.includes('PPBE'),
    )!;
    expect(within(ppbeRow as HTMLElement).queryByText(/^Edit$/)).toBeNull();
  });
});
