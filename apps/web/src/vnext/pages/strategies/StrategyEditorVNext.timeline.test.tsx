/**
 * Working-timeline regressions (2026-08-19).
 *
 * Three defects this covers, all confirmed against capiro-dev before the fix:
 *
 *  1. The axis was pinned to FY27 while api-strategy generates every reference
 *     row, firm phase and seeded plan against `currentFyWindow()` = the LIVE
 *     fiscal year — so "today" fell off the left edge, `showToday` was false,
 *     and the TODAY marker never rendered.
 *  2. Bars were percentage-positioned over a flex ruler, so a label could not
 *     be bounded by its own bar; here they are grid items whose area IS their
 *     month range, with the label in its own ellipsizing span.
 *  3. The legislative band was read-only with a dead "Ask Meri about this
 *     calendar" control posting to a route the service does not implement,
 *     rendered in normal flow underneath the absolutely-positioned bars (which
 *     is what printed text across them). It now edits and forks for real
 *     through `PUT /strategy-api/reference-calendars/congress`.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyEditorVNext } from './StrategyEditorVNext.js';
import type { ReferenceRow, StrategyDetail, StrategyNode } from '../../../pages/strategy/types.js';

const STRATEGY_ID = '11111111-2222-3333-4444-555555555555';

/** Fixed "now" so the axis, the TODAY marker and the fixtures agree. */
const NOW = new Date('2026-08-19T12:00:00.000Z');

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

/* Real shapes from capiro-dev: the plan opens in Aug 2026 (FY2026) and the
   legislative baseline runs Jan 2026 – Nov 2027. Under the old FY27 axis the
   first of each was invisible. */
const NODES: StrategyNode[] = [
  node({ id: 'n1', title: 'Identify target program elements', startsOn: '2026-08-15', endsOn: '2026-09-30' }),
  node({ id: 'n2', kind: 'decision', title: 'Select final PE targets', startsOn: '2026-10-01', endsOn: null }),
  node({ id: 'n3', kind: 'gate', title: 'Submit congressional funding request', startsOn: '2027-04-28', endsOn: null }),
];

const CONGRESS: ReferenceRow[] = [
  { id: 'c1', kind: 'congress_milestone', label: "President's Budget", fy: null, startsOn: '2026-01-29T00:00:00.000Z', endsOn: '2026-02-19T00:00:00.000Z', tone: 'ink', position: 0 },
  { id: 'c2', kind: 'congress_milestone', label: 'Floor & amendments', fy: null, startsOn: '2026-07-01T00:00:00.000Z', endsOn: '2026-08-17T00:00:00.000Z', tone: 'notable', position: 1 },
  { id: 'c3', kind: 'congress_milestone', label: 'Conference', fy: null, startsOn: '2026-08-17T00:00:00.000Z', endsOn: '2026-09-22T00:00:00.000Z', tone: 'notable', position: 2 },
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

const forkMutate = vi.fn();

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
    useTenantMembers: () => ({ data: [] }),
    usePendingWatchCounts: () => ({ data: {} }),
    useWatchReviewState: () => ({ data: { proposals: [] } }),
    useRevalidateWatch: () => ({ mutate: vi.fn(), isPending: false }),
    useForkReferenceCalendar: () => ({ mutate: forkMutate, isPending: false, isError: false, error: null }),
  };
});

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/strategies/${STRATEGY_ID}`]}>
        <Routes>
          <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function bandFor(label: string): HTMLElement {
  const band = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!band) throw new Error(`no band labelled "${label}"`);
  return band;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  forkMutate.mockReset();
});

describe('Working timeline — axis and TODAY marker', () => {
  it('anchors the window on the live fiscal year, so today is on the axis', () => {
    const { container } = renderEditor();
    // FY2026 (today) through FY2028, not the old frozen FY27–FY29.
    expect(screen.getByText('FY26')).toBeTruthy();
    expect(screen.getByText('FY28')).toBeTruthy();
    expect(screen.queryByText('FY29')).toBeNull();

    const pill = screen.getByText('Today');
    expect(pill).toBeTruthy();
    const line = container.querySelector<HTMLElement>('.st-tl__today-line');
    expect(line).toBeTruthy();
    // Interior position — 0% or 100% is the off-axis clamp that used to hide it.
    const left = Number.parseFloat(line!.style.left);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(100);
  });

  it('renders the plan step that starts before the old FY27 axis', () => {
    renderEditor();
    expect(screen.getByText('Identify target program elements')).toBeTruthy();
  });

  it('marks the current month on the ruler', () => {
    const { container } = renderEditor();
    const current = container.querySelectorAll('.st-tl__month--current');
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toBe('AUG');
  });
});

describe('Working timeline — month-column grid', () => {
  it('places every bar on its own month range instead of a percentage offset', () => {
    const { container } = renderEditor();
    const bars = container.querySelectorAll<HTMLElement>('.st-tl__bar');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.style.gridColumn).toMatch(/^\d+ \/ span \d+$/);
      // Nothing is positioned by left/width any more, so nothing can drift off
      // the ruler or spill past its own box.
      expect(bar.style.left).toBe('');
      expect(bar.style.width).toBe('');
    }
  });

  it('gives every bar and step label its own ellipsizing span', () => {
    const { container } = renderEditor();
    // `text-overflow` is inert on a flex container's anonymous text, which is
    // why labels used to be chopped mid-glyph. Each label owns a span now.
    for (const bar of container.querySelectorAll<HTMLElement>('.st-tl__bar')) {
      expect(bar.querySelector('.st-tl__bar-label')).toBeTruthy();
    }
    for (const step of container.querySelectorAll<HTMLElement>('.st-step')) {
      expect(step.querySelector('.st-step__title')).toBeTruthy();
      expect(step.querySelector('.st-step__kind-text')).toBeTruthy();
    }
  });

  it('lanes bars that share a month column even when their dates do not overlap', () => {
    const { container } = renderEditor();
    // "Floor & amendments" ends Aug 17 and "Conference" starts Aug 17 — same
    // August cell, so they must not land in the same grid row.
    const rows = [...container.querySelectorAll<HTMLElement>('.st-tl__bar')]
      .filter((b) => /Floor & amendments|Conference/.test(b.textContent ?? ''))
      .map((b) => b.style.gridRow);
    expect(rows).toHaveLength(2);
    expect(new Set(rows).size).toBe(2);
  });

  it('widens a point-in-time step enough to render its own label', () => {
    const { container } = renderEditor();
    const gate = [...container.querySelectorAll<HTMLElement>('.st-step')].find((s) =>
      s.textContent?.includes('Submit congressional funding request'),
    );
    expect(gate).toBeTruthy();
    const span = Number(gate!.style.gridColumn.split('span ')[1]);
    expect(span).toBeGreaterThanOrEqual(2);
  });

  it('marks a widened point-in-time step so the padding never asserts a duration', () => {
    const { container } = renderEditor();
    // n3 is a gate with no endsOn: drawn >1 column for legibility, so it has to
    // say so — edge modifier, plus the real date in the tooltip and the name.
    const gate = [...container.querySelectorAll<HTMLElement>('.st-step')].find((s) =>
      s.textContent?.includes('Submit congressional funding request'),
    )!;
    expect(gate.className).toContain('st-step--instant');
    expect(gate.className).toContain('st-step--gate');
    expect(gate.title).toMatch(/Submit congressional funding request — \w{3} \d+/);
    expect(gate.getAttribute('aria-label')).toMatch(/, on \w{3} \d+$/);

    // A step with a real end date is NOT marked — the modifier means "instant",
    // not "short".
    const ranged = [...container.querySelectorAll<HTMLElement>('.st-step')].find((s) =>
      s.textContent?.includes('Identify target program elements'),
    )!;
    expect(ranged.className).not.toContain('st-step--instant');
  });
});

describe('PPBE band', () => {
  it('stays read-only — no fork route reaches ppbe_lane_bar', () => {
    // PUT /reference-calendars/ppbe maps to ppbe_current_phase; the band drawn
    // here is ppbe_lane_bar, which no endpoint can write. The Edit affordance
    // is therefore Legislative-only rather than a control that would fail.
    renderEditor();
    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    expect(editButtons).toHaveLength(1);
    const gutterRows = [...document.querySelectorAll('.st-tl__gutter-row')];
    const ppbeRow = gutterRows.find((r) => r.textContent?.startsWith('PPBE'));
    expect(ppbeRow).toBeTruthy();
    expect(ppbeRow!.querySelector('.st-tl__gutter-edit')).toBeNull();
  });
});

describe('Legislative calendar editing', () => {
  it('is read-only until the band is put into edit mode', () => {
    renderEditor();
    expect(document.querySelector('.st-tl__bar--draggable')).toBeNull();
    expect(screen.queryByText(/Save calendar/)).toBeNull();
  });

  it('moves a milestone by whole months and forks the calendar on save', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const band = bandFor('Legislative calendar (editing)');
    // /^Conference,/ — the bar's own aria-label, not its "Remove Conference" sibling.
    const bar = within(band).getByRole('button', { name: /^Conference,/ });
    const before = bar.closest<HTMLElement>('.st-tl__slot')!.style.gridColumn;

    // Keyboard nudge — the same edit a drag commits, without synthesising
    // pointer geometry jsdom has no layout for.
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    const after = within(bandFor('Legislative calendar (editing)'))
      .getByRole('button', { name: /^Conference,/ })
      .closest<HTMLElement>('.st-tl__slot')!.style.gridColumn;
    expect(after).not.toBe(before);
    expect(Number(after.split(' / ')[0])).toBe(Number(before.split(' / ')[0]) + 1);

    fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }));
    await waitFor(() => expect(forkMutate).toHaveBeenCalledTimes(1));

    const rows = forkMutate.mock.calls[0]![0] as Array<{ label: string; startsOn: string; endsOn: string }>;
    expect(rows).toHaveLength(CONGRESS.length);
    // The whole set is sent (the service REPLACES the tenant's rows).
    expect(rows.map((r) => r.label)).toContain("President's Budget");

    const moved = rows.find((r) => r.label === 'Conference')!;
    // Shifted a month with the day of month intact — not snapped to the 1st.
    expect(moved.startsOn).toBe('2026-09-17');
    expect(moved.endsOn).toBe('2026-10-22');

    // Untouched rows keep their exact dates, in the YYYY-MM-DD the DTO requires.
    const untouched = rows.find((r) => r.label === "President's Budget")!;
    expect(untouched.startsOn).toBe('2026-01-29');
    expect(untouched.endsOn).toBe('2026-02-19');

    // Every row satisfies the service's endsOn > startsOn precondition.
    for (const r of rows) {
      expect(r.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(r.endsOn).getTime()).toBeGreaterThan(new Date(r.startsOn).getTime());
    }
  });

  it('adds a milestone and does not save until something actually changed', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save calendar' })).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: 'Add milestone' }));
    expect(screen.getByRole('button', { name: 'Save calendar' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }));
    const rows = forkMutate.mock.calls[0]![0] as Array<{ label: string }>;
    expect(rows).toHaveLength(CONGRESS.length + 1);
    expect(rows.map((r) => r.label)).toContain('New milestone');
  });

  it('drops uncommitted edits on cancel', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add milestone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(forkMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('New milestone')).toBeNull();
  });

  it('removes a milestone from the set it sends', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Conference' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save calendar' }));
    const rows = forkMutate.mock.calls[0]![0] as Array<{ label: string }>;
    expect(rows.map((r) => r.label)).not.toContain('Conference');
    expect(rows).toHaveLength(CONGRESS.length - 1);
  });
});



describe('Calendar persistence and fiscal boundaries', () => {
  it('draws firm phases through the last month before the exclusive end quarter', () => {
    renderEditor();
    const phase = screen.getByRole('button', { name: 'Strategy refresh' });
    expect(phase.style.gridColumn).toBe('1 / span 3');
  });

  it('Done saves a modified calendar rather than discarding it', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add milestone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(forkMutate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ label: 'New milestone' })]), expect.any(Object));
  });
});
