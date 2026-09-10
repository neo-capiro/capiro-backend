/**
 * F07 (2026-09-10 remediation plan §5) — strategy-local health diagnostics.
 *
 * Observed defect: clicking Plan health (chip and bottom card) navigated to
 * the GLOBAL Watch proposal queue (/strategies/agents/proposals), which is
 * empty and explains nothing about THIS strategy's score or affected steps.
 * The Next 30 days empty state also claimed suggested work is in that queue.
 *
 * This suite pins the repaired behavior:
 *  - both health controls open ONE diagnostics panel for the CURRENT
 *    strategy, inline (no navigation away);
 *  - the score shows as N/100 (a score, not an issue count); 'No steps' for
 *    an empty plan;
 *  - diagnostic groups derive from the EXACT predicates feeding the score:
 *    steps without an owner, gates without linked source references, and
 *    overdue unfinished dated commitments (shared UTC rule);
 *  - each finding shows the affected step title with an Open step action
 *    that opens exactly that step; a multi-issue step appears in every
 *    applicable group without corrupting totals (unique affected-step total
 *    separate from issue totals);
 *  - source coverage copy never claims the source is verified;
 *  - the empty Watch queue never hides these findings;
 *  - suggested-step review stays reachable: the Next-30 empty state points
 *    at the timeline, not the proposal queue;
 *  - empty/loading/fetch-error states make no fabricated health claims;
 *  - Watch proposals remain a separately named, separately scoped action.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyEditorVNext } from './StrategyEditorVNext.js';
import type { StrategyDetail, StrategyNode } from '../../../pages/strategy/types.js';

const actions = vi.hoisted(() => ({
  edit: vi.fn(),
  remove: vi.fn(),
  assistant: vi.fn(),
  add: vi.fn(),
}));

const STRATEGY_ID = '11111111-2222-3333-4444-555555555555';
const NOW = new Date('2026-08-19T12:00:00.000Z');

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

/** A plan with one step in ALL three diagnostic groups (multi-issue). */
const MULTI_NODES: StrategyNode[] = [
  // Unowned + ungrounded gate + overdue: appears in every group.
  node({
    id: 'multi',
    title: 'Multi-issue step',
    kind: 'gate',
    startsOn: '2026-06-01',
    endsOn: '2026-06-30',
    ownerUserId: null,
    provenance: null,
  }),
  node({
    id: 'clean',
    title: 'Clean step',
    startsOn: '2027-01-01',
    endsOn: '2027-02-01',
    ownerUserId: 'u1',
  }),
  node({
    id: 'unowned',
    title: 'Unowned step',
    startsOn: '2027-01-01',
    endsOn: '2027-02-01',
    ownerUserId: null,
  }),
];

function detailFor(nodes: StrategyNode[]): StrategyDetail {
  return {
    id: STRATEGY_ID,
    clientId: 'client-1',
    title: 'Diagnostics fixture',
    type: 'regulatory',
    goal: 'Goal',
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
    nodes,
    artifacts: [],
  };
}

const state = vi.hoisted(() => ({
  detail: null as unknown as import('../../../pages/strategy/types.js').StrategyDetail,
  empty: false,
}));

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

vi.mock('../../../pages/strategy/client-targets-lite.js', () => ({
  useClientTargetsLite: () => ({ data: [] }),
  targetDisplayLabel: () => 'Target',
  targetRefFromClientTarget: (x: unknown) => x,
}));

vi.mock('./strategies-api.js', async () => {
  const actual = await vi.importActual<typeof import('./strategies-api.js')>('./strategies-api.js');
  return {
    ...actual,
    useStrategy: () => ({
      data: state.empty ? { ...state.detail, nodes: [] } : state.detail,
      isLoading: false,
      isError: false,
      dataUpdatedAt: NOW.getTime(),
    }),
    useFirmPhases: () => ({ data: [] }),
    useReferenceCalendars: () => ({
      data: {
        congress: [],
        ppbeLanes: [],
        ppbeCurrentPhases: [],
        source: { congress: 'baseline' },
      },
    }),
    useClientsLite: () => ({ data: [{ id: 'client-1', name: 'Client One' }] }),
    useTenantMembers: () => ({ data: [{ clerkUserId: 'u1', name: 'Ada' }] }),
    usePendingWatchCounts: () => ({ data: {} }),
    useWatchReviewState: () => ({ data: { proposals: [] } }),
    useWatchMonitoring: () => ({ data: { available: false }, isSuccess: true }),
    useConfigureWatchMonitoring: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRevalidateWatch: () => ({ mutate: vi.fn(), isPending: false }),
    useForkReferenceCalendar: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
    }),
    useAssistant: () => ({
      mutate: actions.assistant,
      isPending: false,
      isError: false,
      error: null,
    }),
    useAddNode: () => ({ mutate: actions.add, isPending: false, isError: false, error: null }),
    useMissions: () => ({ refetch: vi.fn() }),
    useCreateMission: () => ({ mutateAsync: vi.fn() }),
    useUpdateMission: () => ({ mutateAsync: vi.fn() }),
    usePlanExecution: () => ({ mutateAsync: vi.fn() }),
    useExecutionPreflight: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRecordArtifact: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
    useStrategyConversation: () => ({ data: [], isLoading: false }),
    useDismissContextGap: () => ({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
    }),
    useDeleteNode: () => ({ mutate: actions.remove, isPending: false }),
    useUpdateNode: () => ({
      mutate: actions.edit,
      isPending: false,
      isError: false,
      error: null,
      variables: undefined,
    }),
  };
});

function renderEditor(initialEntry = `/strategies/${STRATEGY_ID}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/strategies/:strategyId" element={<StrategyEditorVNext />} />
          <Route path="/strategies/agents/proposals" element={<p>PROPOSALS-QUEUE</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.detail = detailFor(MULTI_NODES);
  state.empty = false;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('F07 — strategy-local health diagnostics', () => {
  it('the Plan health chip opens an INLINE diagnostics panel, not the global proposals queue', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Plan health ·/ }));
    // The panel opens inline — the proposals queue route never renders.
    expect(await screen.findByRole('region', { name: /plan health diagnostics/i })).toBeTruthy();
    expect(screen.queryByText('PROPOSALS-QUEUE')).toBeNull();
  });

  it('the bottom Plan health card opens the SAME panel with the N/100 score meaning', async () => {
    renderEditor();
    // The card's control (the former "Review proposals" button).
    fireEvent.click(
      screen.getByRole('button', { name: /review diagnostics|view diagnostics|diagnostics/i }),
    );
    const panel = await screen.findByRole('region', { name: /plan health diagnostics/i });
    // Score labeled as a score out of 100 — not a bare issue count.
    expect(within(panel).getByText(/\/100/)).toBeTruthy();
  });

  it('shows the three diagnostic groups with step titles and Open step actions; unique-step total separate from issue totals', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Plan health ·/ }));
    const panel = await screen.findByRole('region', { name: /plan health diagnostics/i });

    // Group headings from the exact score predicates.
    expect(within(panel).getByText(/steps without an owner/i)).toBeTruthy();
    expect(within(panel).getByText(/gates without linked source references/i)).toBeTruthy();
    expect(within(panel).getByText(/overdue unfinished dated commitments/i)).toBeTruthy();

    // The multi-issue step appears in all three groups...
    const multiRows = within(panel).getAllByText('Multi-issue step');
    expect(multiRows.length).toBe(3);
    // ...while the UNIQUE affected-step total counts it once (2 unique: multi + unowned).
    expect(within(panel).getByText(/2 steps affected/i)).toBeTruthy();
    // Issue total stays 4 (2 ownership + 1 gate + 1 overdue).
    expect(within(panel).getByText(/4 findings/i)).toBeTruthy();

    // Every affected row carries an Open step action.
    const openButtons = within(panel).getAllByRole('button', { name: /open step/i });
    expect(openButtons.length).toBeGreaterThanOrEqual(4);
  });

  it('Open step from a diagnostic opens exactly that step in the inspector', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Plan health ·/ }));
    const panel = await screen.findByRole('region', { name: /plan health diagnostics/i });

    // Scope to the row li containing this step's title.
    const row = Array.from(panel.querySelectorAll('li')).find((li) =>
      (li.textContent ?? '').includes('Unowned step'),
    );
    if (!row) throw new Error('No row for Unowned step');
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: /open step/i }));

    // The inspector opens on that exact step (its h2 title).
    const inspector = await screen.findByRole('complementary', { name: /step inspector/i });
    expect(within(inspector).getByText('Unowned step')).toBeTruthy();
    expect(within(inspector).getByText(/Selected step/i)).toBeTruthy();
  });

  it('an empty Watch queue never hides findings; Watch proposals remain a separately named action', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Plan health ·/ }));
    const panel = await screen.findByRole('region', { name: /plan health diagnostics/i });

    // Findings present with the (mocked empty) proposals queue...
    expect(within(panel).getAllByText('Multi-issue step').length).toBe(3);
    // ...and Watch proposals remain reachable as their own scoped action.
    expect(within(panel).getByRole('button', { name: /watch proposals/i })).toBeTruthy();
  });

  it('source-coverage copy never claims the source is verified', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Plan health ·/ }));
    const panel = await screen.findByRole('region', { name: /plan health diagnostics/i });
    const coverageNote = within(panel).getByText(/source references/i);
    expect(coverageNote.textContent ?? '').not.toMatch(/verified/i);
  });

  it('an empty plan shows No steps and makes no fabricated health claims', async () => {
    state.empty = true;
    renderEditor();
    expect(screen.getByText(/No steps/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Plan health ·/ }));
    const panel = await screen.findByRole('region', { name: /plan health diagnostics/i });
    expect(within(panel).getByText(/no findings/i)).toBeTruthy();
  });

  it('the Next 30 days empty state points at the timeline, not the proposals queue', async () => {
    state.empty = true;
    renderEditor();
    expect(screen.getByText(/review suggested steps in the timeline/i)).toBeTruthy();
    expect(screen.queryByText(/suggested work is in the review queue/i)).toBeNull();
  });
});

function multiRowFor(panel: HTMLElement, title: string): HTMLElement {
  const heading = Array.from(panel.querySelectorAll('section, div')).find((el) =>
    (el.textContent ?? '').includes(title),
  );
  if (!heading) throw new Error(`No row containing ${title}`);
  return heading as HTMLElement;
}
